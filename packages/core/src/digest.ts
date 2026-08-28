/**
 * The digest runner: everything that landed on staging, in one message.
 *
 * The digest is the only thing the human reads on a normal day, so this file's most
 * important behaviour is the one that produces nothing: **silence on a quiet day**. The
 * check happens before the agent is called, not after, so an empty digest costs no model
 * call and, more to the point, cannot become a ritual message nobody needs.
 *
 * Unlike triage and the engineer, the digest's output is prose, not JSON (ADR 0007's
 * contract is for data another program acts on). The runner already knows which runs it
 * passed in, so there is nothing to parse back.
 */

import type { Config } from "./config.ts";
import type { AgentRunner } from "./agent.ts";
import { loadPrompt } from "./agent.ts";
import type { Ticket, Tracker } from "./tracker.ts";
import type { StagedRun, Store } from "./store.ts";

export interface DigestResult {
  /** True when there was genuinely nothing to say. `message` is empty and no agent ran. */
  silent: boolean;
  message: string;
  covered: string[];
}

export interface DigestOptions {
  config: Config;
  tracker: Tracker;
  agent: AgentRunner;
  store: Store;
  dryRun?: boolean;
}

function describeRuns(runs: StagedRun[]): string {
  return runs
    .map((r) =>
      [
        `### ${r.ticketId} - ${r.summary}`,
        `Merged at ${r.commitSHA.slice(0, 7)} on branch \`${r.branch}\`, behind flag \`${r.flag}\`.`,
        r.stagingURL ? `Staging: ${r.stagingURL}` : undefined,
        r.unsure ? `The engineer was unsure about: ${r.unsure}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
}

function describeQueue(open: Ticket[]): string {
  if (open.length === 0) return "The backlog is empty. The next wake runs a self-audit.";
  const byLane = { ai: 0, human: 0 };
  for (const t of open) byLane[t.lane] += 1;
  const next = open[0];
  return [
    `${open.length} open (${byLane.ai} AI lane, ${byLane.human} human lane).`,
    next ? `Next up: ${next.id} ${next.title}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

export async function runDigest(options: DigestOptions): Promise<DigestResult> {
  const { config, tracker, agent, store } = options;
  const runs = store.undigestedRuns();
  const open = await tracker.listOpen();

  // prompts/digest.md: "Be silent when nothing changed. An empty digest on a quiet day is
  // correct. A ritual message nobody needs is how this gets ignored."
  if (runs.length === 0) {
    return { silent: true, message: "", covered: [] };
  }

  const prompt = [
    loadPrompt("digest"),
    "---",
    `## The product\n\n${config.product.name}. Vision: \`${config.product.vision}\`.`,
    "---",
    "## What shipped to staging since the last digest",
    describeRuns(runs),
    "---",
    "## The queue",
    describeQueue(open),
    "---",
    "## Open tickets, for the queue line and for anything blocked on the human",
    open.map((t) => `- ${t.id} [${t.lane}, p${t.priority}, ${t.state}] ${t.title}`).join("\n") ||
      "(none)",
    "---",
    "## How to answer",
    [
      "Write the message itself, as markdown. No JSON, no preamble, no sign-off.",
      "Use the five headings from the shape above, and drop any heading that has nothing under it.",
      `The production press is a human action in the console. Never tell them to run a deploy command; tell them what to look at on staging${config.environments.staging.url ? ` (${config.environments.staging.url})` : ""}.`,
    ].join("\n\n"),
  ].join("\n\n");

  if (options.dryRun) {
    return { silent: false, message: prompt, covered: runs.map((r) => r.ticketId) };
  }

  const result = await agent.run({
    prompt,
    cwd: config.repo.root,
    allowedTools: ["Read", "Grep", "Glob"],
    permissionMode: "plan",
  });

  if (!result.ok) {
    throw new Error(`digest agent failed (exit ${result.exitCode}): ${result.stderr ?? result.text}`);
  }

  const covered = runs.map((r) => r.ticketId);
  store.markDigested(covered);
  return { silent: false, message: result.text.trim(), covered };
}

/**
 * The plain-text digest, with no model involved. `autopilot digest --plain` uses it, and so
 * does anything that needs the facts without waiting on an agent.
 */
export function plainDigest(runs: StagedRun[], open: Ticket[], config: Config): string {
  if (runs.length === 0) return "";
  return [
    `# ${config.product.name} - what landed on staging`,
    "",
    "## Shipped to staging",
    ...runs.map(
      (r) =>
        `- **${r.summary}** (${r.ticketId}, flag \`${r.flag}\`${r.stagingURL ? `, ${r.stagingURL}` : ""})`,
    ),
    ...(runs.some((r) => r.unsure)
      ? ["", "## Needs your eyes", ...runs.filter((r) => r.unsure).map((r) => `- ${r.ticketId}: ${r.unsure}`)]
      : []),
    "",
    "## Queue",
    describeQueue(open),
  ].join("\n");
}
