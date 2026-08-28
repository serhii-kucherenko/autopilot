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
import type { Signal, StagedRun, Store } from "./store.ts";
import { checkAnchor } from "./anchor.ts";

/**
 * The two numbers `docs/coherence.md` names as the falsification test for the anchor bet:
 *
 * > If tickets keep stopping on anchor conflicts, the anchor is over-specified.
 * > If the human review keeps finding drift the anchor should have caught, the anchor is
 * > under-specified.
 *
 * `conflicts` is the first. `anchorViolations` is the second, inverted: it is the drift the
 * anchor *did* catch mechanically, so a rising human-found-drift count against a zero here
 * is what says the anchor is under-specified.
 */
export interface Coherence {
  conflicts: number;
  anchorViolations: number;
  /** False when the product has no DESIGN.md at all, which makes both numbers meaningless. */
  anchorExists: boolean;
  /** Every outcome that was not a clean ship, conflicts included. */
  signals: Signal[];
}

export function coherenceOf(config: Config, signals: Signal[]): Coherence {
  const anchor = checkAnchor({ root: config.repo.root });
  return {
    conflicts: signals.filter((s) => s.kind === "conflict").length,
    anchorViolations: anchor.violations.length,
    anchorExists: !anchor.designMissing,
    signals,
  };
}

export function describeCoherence(coherence: Coherence): string {
  if (!coherence.anchorExists) {
    return "No DESIGN.md in this product, so there is no anchor and nothing to measure. That is the finding.";
  }
  const lines = [
    `Tickets stopped on an anchor conflict: ${coherence.conflicts}.`,
    `Values in the code that DESIGN.md never declared: ${coherence.anchorViolations}.`,
  ];
  if (coherence.conflicts >= 3) {
    lines.push(
      "Three or more conflicts in one batch is the over-specified signal from docs/coherence.md. " +
        "Worth asking which rule is fighting the work.",
    );
  }
  if (coherence.anchorViolations > 0) {
    lines.push("Run `autopilot check-anchor` for the file and line of each one.");
  }
  return lines.join(" ");
}

export interface DigestResult {
  /** True when there was genuinely nothing to say. `message` is empty and no agent ran. */
  silent: boolean;
  message: string;
  covered: string[];
  coherence?: Coherence;
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
  const signals = store.undigestedSignals();
  const open = await tracker.listOpen();

  // prompts/digest.md: "Be silent when nothing changed. An empty digest on a quiet day is
  // correct. A ritual message nobody needs is how this gets ignored."
  //
  // A batch of nothing but failures is not a quiet day, though, so signals break the silence
  // too - otherwise a loop stuck on one failing gate would go unreported for as long as it
  // kept failing.
  if (runs.length === 0 && signals.length === 0) {
    return { silent: true, message: "", covered: [] };
  }

  const coherence = coherenceOf(config, signals);

  const prompt = [
    loadPrompt("digest"),
    "---",
    `## The product\n\n${config.product.name}. Vision: \`${config.product.vision}\`.`,
    "---",
    "## What shipped to staging since the last digest",
    describeRuns(runs),
    "---",
    "## What the loop hit and did not ship",
    signals.length === 0
      ? "Nothing. Every ticket in this batch went through cleanly."
      : signals
          .map((s) => `- ${s.ticketId} [${s.kind}] ${s.detail?.split("\n")[0] ?? ""}`)
          .join("\n"),
    "---",
    "## Coherence",
    describeCoherence(coherence),
    "A conflict is a decision for the human, not a failure. Put each one under \"Decisions for you\" with your recommendation.",
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
    return { silent: false, message: prompt, covered: runs.map((r) => r.ticketId), coherence };
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
  store.markSignalsDigested();
  return { silent: false, message: result.text.trim(), covered, coherence };
}

/**
 * The plain-text digest, with no model involved. `autopilot digest --plain` uses it, and so
 * does anything that needs the facts without waiting on an agent.
 */
export function plainDigest(
  runs: StagedRun[],
  open: Ticket[],
  config: Config,
  coherence?: Coherence,
): string {
  if (runs.length === 0 && !coherence?.signals.length) return "";
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
    ...(coherence?.signals.length
      ? [
          "",
          "## Did not ship",
          // A conflict is named, not just counted: it is a decision waiting on the human,
          // which makes it the most actionable line in the whole message.
          ...coherence.signals.map(
            (s) => `- ${s.ticketId} [${s.kind}] ${s.detail?.split("\n")[0] ?? ""}`.trimEnd(),
          ),
        ]
      : []),
    ...(coherence ? ["", "## Coherence", describeCoherence(coherence)] : []),
    "",
    "## Queue",
    describeQueue(open),
  ].join("\n");
}
