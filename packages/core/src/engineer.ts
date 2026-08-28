/**
 * The engineer runner: one ticket, end to end, staging only.
 *
 * The split of work here is the safety argument of the whole system (ADR 0008):
 *
 * | The agent owns | The runner owns |
 * | -- | -- |
 * | reading the anchor, planning, writing code and tests | the branch, the boundary check, the gate, the merge, the deploy |
 *
 * A prompt asking an agent to run its own gate is guidance. A runner that will not merge
 * until the gate exits 0 is a gate. And because the runner never reads
 * `environments.production`, there is no code path from a ticket to production at all.
 */

import { relative } from "node:path";
import type { Config } from "./config.ts";
import type { AgentRunner } from "./agent.ts";
import { loadPrompt, renderPrompt } from "./agent.ts";
import type { Ticket, Tracker } from "./tracker.ts";
import { Git, branchNameFor, flagNameFor } from "./git.ts";
import { assertDiffInBounds, protectedViolations } from "./boundaries.ts";
import { runGate, runCommand, summariseGate, type GateResult } from "./gate.ts";
import type { Store } from "./store.ts";
import { outputContract, parseReply, requireString, optionalString } from "./reply.ts";

const ENGINEER_SHAPE = `
{
  "outcome": "shipped",
  "summary": "what is now true, in product terms, one or two sentences",
  "unsure": "omit unless something in this change genuinely needs a human eye",
  "conflict": "omit unless outcome is conflict: what the ticket asks that the anchor forbids",
  "runbook": "omit unless outcome is blocked: exact URL, click path, values, cost, how they know it worked",
  "anchorExtended": "omit unless you added a token or an ADR: which file and what you added"
}
`;

export type EngineerStatus =
  | "shipped"
  | "gate-failed"
  | "conflict"
  | "blocked"
  | "no-change"
  | "agent-failed"
  | "out-of-bounds";

export interface EngineerOutcome {
  status: EngineerStatus;
  ticketId: string;
  summary: string;
  branch: string;
  flag: string;
  commitSHA?: string;
  unsure?: string;
  conflict?: string;
  runbook?: string;
  gate?: GateResult;
  /** Everything worth putting in a ticket comment or the digest. */
  detail: string;
}

export interface EngineerOptions {
  config: Config;
  tracker: Tracker;
  agent: AgentRunner;
  store?: Store;
  ticket: Ticket;
  dryRun?: boolean;
  /** Injected in tests. Defaults to a real git in the product repo. */
  git?: Git;
}

/**
 * States the runner moves a ticket through. Named here so nothing invents a new one.
 *
 * `shipped` is `Done`, not `In Review`, and that is deliberate. Landing on staging behind a
 * flag is the whole of the loop's job for a ticket; the production press is recorded as an
 * approval, not as ticket state, and human feedback becomes *new* tickets
 * (`docs/flow.md`). An `In Review` state would also be `started` in Linear's model, which
 * means `pickNext` would resume it forever and the loop would never reach ticket two.
 */
export const STATE = {
  working: "In Progress",
  shipped: "Done",
  backlog: "Backlog",
} as const;

function anchorList(config: Config): string {
  return config.product.anchors.map((a) => `- \`${a}\``).join("\n");
}

export async function runEngineer(options: EngineerOptions): Promise<EngineerOutcome> {
  const { config, tracker, agent, ticket } = options;
  const git = options.git ?? new Git(config.repo.root);
  const branch = branchNameFor(config.repo.branchPrefix, ticket.id);
  const flag = flagNameFor(ticket.id);
  const base = config.repo.defaultBranch;

  const fail = (status: EngineerStatus, summary: string, detail: string): EngineerOutcome => ({
    status,
    ticketId: ticket.id,
    summary,
    branch,
    flag,
    detail,
  });

  if (!git.isRepo()) {
    return fail("blocked", "the product repo is not a git repository", `no git repo at ${config.repo.root}`);
  }

  if (!options.dryRun) await tracker.setState(ticket.id, STATE.working);
  git.checkout(base);
  git.checkoutBranch(branch);

  const prompt = [
    renderPrompt(loadPrompt("engineer"), { product_name: config.product.name }),
    "---",
    "## Your ticket",
    `**${ticket.id} - ${ticket.title}**  (lane: ${ticket.lane}, priority: ${ticket.priority})`,
    ticket.description || "_no description_",
    "---",
    "## The anchor, read it before you plan",
    anchorList(config),
    `Product vision: \`${config.product.vision}\``,
    "---",
    "## What this runner does after you finish",
    [
      `You are on branch \`${branch}\`. Leave your work there uncommitted; the runner commits it.`,
      config.gate.featureFlags.required
        ? `Put the change behind the feature flag \`${flag}\`, default ${config.gate.featureFlags.defaultState}. The runner refuses to merge a diff that does not mention that flag name.`
        : "This product does not require a feature flag.",
      `The runner then runs the quality gate: ${config.gate.commands.map((c) => `\`${c}\``).join(", ")}. It will not merge if any of them fails, and it will not lower the gate.`,
      "The runner merges and deploys to staging. You never deploy anything, and there is no production path from here.",
      config.boundaries.protectedPaths.length > 0
        ? `Out of bounds, checked against your real diff: ${config.boundaries.protectedPaths.map((p) => `\`${p}\``).join(", ")}.`
        : "This product declares no protected paths.",
    ].join("\n\n"),
    outputContract(ENGINEER_SHAPE),
  ].join("\n\n");

  if (options.dryRun) {
    return {
      status: "no-change",
      ticketId: ticket.id,
      summary: "(dry run) the agent was not run",
      branch,
      flag,
      detail: prompt,
    };
  }

  const result = await agent.run({ prompt, cwd: config.repo.root, permissionMode: "acceptEdits" });
  if (!result.ok) {
    await tracker.comment(ticket.id, `The engineer run failed before producing a diff.\n\n${result.stderr ?? result.text}`);
    return fail("agent-failed", "the agent run failed", result.stderr ?? result.text);
  }

  const reply = parseReply<Record<string, unknown>>(result.text);
  const outcome = requireString(reply, "outcome", result.text);
  const summary = optionalString(reply, "summary") ?? ticket.title;
  const unsure = optionalString(reply, "unsure");
  const anchorExtended = optionalString(reply, "anchorExtended");

  // Rule 3 of docs/coherence.md: a conflict stops the ticket and becomes a decision for
  // the human. It never becomes the agent quietly picking a side.
  if (outcome === "conflict") {
    const conflict = optionalString(reply, "conflict") ?? summary;
    await tracker.comment(ticket.id, `Stopped on an anchor conflict, for the human to decide.\n\n${conflict}`);
    await tracker.setState(ticket.id, STATE.backlog);
    const out = fail("conflict", summary, conflict);
    out.conflict = conflict;
    return out;
  }

  if (outcome === "blocked") {
    const runbook = optionalString(reply, "runbook") ?? "no runbook was written, which is itself a bug";
    await tracker.comment(ticket.id, `Blocked on something only a human can do.\n\n${runbook}`);
    const out = fail("blocked", summary, runbook);
    out.runbook = runbook;
    return out;
  }

  const dirty = git.dirtyPaths();
  if (dirty.length === 0) {
    await tracker.comment(ticket.id, `The engineer produced no diff.\n\n${summary}`);
    return fail("no-change", summary, "the agent changed no files");
  }

  // The boundary check runs on the real diff, not on the agent's word for it (ADR 0002).
  const violations = protectedViolations(dirty, config.boundaries.protectedPaths);
  if (violations.length > 0) {
    const detail = violations.map((v) => `${v.path} matches protected ${v.pattern}`).join("\n");
    await tracker.comment(ticket.id, `Refused to commit: the diff touched protected paths.\n\n${detail}`);
    return fail("out-of-bounds", "the diff touched protected paths, nothing was merged", detail);
  }

  const commitSHA = git.commitAll(`${ticket.id}: ${summary}\n\nBehind feature flag ${flag}.`);
  const changed = git.changedPathsSince(base);
  assertDiffInBounds(changed, config.boundaries.protectedPaths);

  if (config.gate.featureFlags.required && !diffMentions(git, base, flag)) {
    await tracker.comment(
      ticket.id,
      `Refused to merge: this product requires every change behind a flag, and the diff does not mention \`${flag}\`.`,
    );
    const out = fail(
      "gate-failed",
      `the change is not behind the required flag \`${flag}\``,
      `no occurrence of ${flag} in the diff against ${base}`,
    );
    out.commitSHA = commitSHA;
    return out;
  }

  const gate = runGate(config.gate.commands, {
    cwd: config.repo.root,
    forbiddenCommands: config.boundaries.forbiddenCommands,
  });

  if (!gate.ok) {
    // A failing gate is not a reason to lower the gate. The ticket stays in progress.
    await tracker.comment(ticket.id, summariseGate(gate));
    const out = fail("gate-failed", "the quality gate failed, nothing was merged", summariseGate(gate));
    out.commitSHA = commitSHA;
    out.gate = gate;
    return out;
  }

  const mergeSHA = git.mergeInto(base, branch, `Merge ${ticket.id} behind ${flag}\n\n${summary}`);

  const deploy = runCommand(config.environments.staging.deploy, {
    cwd: config.repo.root,
    forbiddenCommands: config.boundaries.forbiddenCommands,
  });

  const detail = [
    summary,
    `Branch \`${branch}\` merged into \`${base}\` at ${mergeSHA.slice(0, 7)}, behind flag \`${flag}\` (default ${config.gate.featureFlags.defaultState}).`,
    changed.length > 0 ? `Changed: ${changed.map((c) => relative(".", c)).join(", ")}` : undefined,
    summariseGate(gate),
    deploy.ok
      ? `Deployed to staging${config.environments.staging.url ? `: ${config.environments.staging.url}` : ""}.`
      : `Staging deploy FAILED (exit ${deploy.exitCode}):\n${deploy.output.split("\n").slice(-10).join("\n")}`,
    anchorExtended ? `Anchor extended: ${anchorExtended}` : undefined,
    unsure ? `Unsure about: ${unsure}` : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");

  options.store?.recordRun({
    ticketId: ticket.id,
    commitSHA: mergeSHA,
    branch,
    flag,
    summary,
    ...(unsure ? { unsure } : {}),
    ...(config.environments.staging.url ? { stagingURL: config.environments.staging.url } : {}),
  });

  await tracker.comment(ticket.id, detail);
  await tracker.setState(ticket.id, STATE.shipped);

  const out: EngineerOutcome = {
    status: "shipped",
    ticketId: ticket.id,
    summary,
    branch,
    flag,
    commitSHA: mergeSHA,
    gate,
    detail,
  };
  if (unsure) out.unsure = unsure;
  return out;
}

/**
 * Whether the flag name appears in the added lines. Checking the diff text rather than the
 * file list is the point: a change is only behind a flag if the flag is in the change.
 */
function diffMentions(git: Git, base: string, needle: string): boolean {
  try {
    return git.diffText(base).includes(needle);
  } catch {
    return false;
  }
}
