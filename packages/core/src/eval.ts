/**
 * Eval: the part that makes a prompt improvable.
 *
 * `prompts/engineer.md` is the most load-bearing file in this product and nothing tested it.
 * The suite passes whatever it says, because the suite runs a scripted agent that never reads
 * it. So every prompt edit was a guess, and "better" meant "I like it more".
 *
 * The rule here is that an expectation must be a **fact about the run**, never a model judging
 * a model. Did it produce a diff. Did the gate pass. Did it touch a file it was told not to.
 * Is the flag actually in the change. Did it refuse work the anchor forbids. Each of those is
 * checkable without an opinion, which is what makes a score worth comparing across a change.
 *
 * A case that expects `conflict` is the most valuable kind: it scores the agent for *stopping*.
 * A loop that builds whatever it is asked is easy to write and is the failure this product
 * exists to avoid.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentRunner } from "./agent.ts";
import { parseConfig } from "./config.ts";
import { runEngineer, type EngineerOutcome } from "./engineer.ts";
import { FileTracker } from "./tracker.ts";

export interface CaseExpectation {
  /** The status the run must end in. `conflict` scores a refusal. */
  outcome: EngineerOutcome["status"];
  /** Files the change must touch. */
  touches?: string[];
  /** Files the change must not touch, however tempting. */
  neverTouches?: string[];
  /** The ticket's flag name must appear in the diff text, not just the file list. */
  flagged?: boolean;
}

export interface EvalCase {
  name: string;
  ticket: { title: string; description: string; lane: "ai" | "human"; priority: number };
  /** Seed files for the throwaway product repo, by path. */
  files: Record<string, string>;
  /** The DESIGN.md the case is judged against. */
  design: string;
  /** Optional vision text, for cases about refusing out-of-scope work. */
  vision?: string;
  expect: CaseExpectation;
}

/** What the run actually did, gathered from git rather than from the agent's own account. */
export interface RunEvidence {
  changed: string[];
  diff: string;
}

export interface CaseResult {
  name: string;
  score: number;
  failures: string[];
  outcome?: EngineerOutcome;
}

/**
 * Score one case as the fraction of its expectations that held.
 *
 * Partial credit on purpose: a run that shipped and hid the change behind its flag but edited
 * one file too many is not the same failure as one that never produced a diff, and a pass/fail
 * bit would call them equal.
 */
export function scoreCase(
  testCase: EvalCase,
  outcome: EngineerOutcome,
  evidence: RunEvidence,
): CaseResult {
  const failures: string[] = [];
  let checks = 0;

  checks += 1;
  if (outcome.status !== testCase.expect.outcome) {
    failures.push(`outcome: expected ${testCase.expect.outcome}, got ${outcome.status}`);
  }

  for (const path of testCase.expect.touches ?? []) {
    checks += 1;
    if (!evidence.changed.includes(path)) failures.push(`expected the change to touch ${path}`);
  }

  for (const path of testCase.expect.neverTouches ?? []) {
    checks += 1;
    if (evidence.changed.includes(path)) failures.push(`${path} was changed and is out of bounds`);
  }

  if (testCase.expect.flagged) {
    checks += 1;
    // The file list is not enough: a change is only behind a flag if the flag is in the change.
    if (!evidence.diff.includes(outcome.flag)) {
      failures.push(`the flag \`${outcome.flag}\` does not appear in the diff`);
    }
  }

  const met = checks - failures.length;
  return { name: testCase.name, score: checks === 0 ? 1 : met / checks, failures, outcome };
}

export interface BaselineDiff {
  before: number;
  after: number;
  regressed: string[];
  improved: string[];
}

/**
 * Compare a run to a stored baseline.
 *
 * The names matter more than the total. One case improving while another breaks leaves the
 * average flat, and an average that cannot move is an average nobody will trust.
 */
export function compareToBaseline(
  before: Pick<CaseResult, "name" | "score">[],
  after: Pick<CaseResult, "name" | "score">[],
): BaselineDiff {
  const priorByName = new Map(before.map((c) => [c.name, c.score]));
  const regressed: string[] = [];
  const improved: string[] = [];
  for (const now of after) {
    const then = priorByName.get(now.name);
    if (then === undefined) continue;
    if (now.score < then) regressed.push(now.name);
    if (now.score > then) improved.push(now.name);
  }
  return { before: mean(before), after: mean(after), regressed, improved };
}

function mean(cases: Pick<CaseResult, "score">[]): number {
  if (cases.length === 0) return 0;
  return cases.reduce((sum, c) => sum + c.score, 0) / cases.length;
}

/** The one line a person reads. */
export function formatEvalReport(results: CaseResult[], diff?: BaselineDiff): string {
  const lines = results.map((r) => {
    const mark = r.score === 1 ? "pass" : r.score === 0 ? "FAIL" : "part";
    const head = `[${mark}] ${r.name} (${r.score.toFixed(2)})`;
    return r.failures.length === 0 ? head : [head, ...r.failures.map((f) => `       ${f}`)].join("\n");
  });
  lines.push("", `score: ${mean(results).toFixed(3)} across ${results.length} cases`);
  if (diff) {
    lines.push(`baseline: ${diff.before.toFixed(3)} -> ${diff.after.toFixed(3)}`);
    if (diff.regressed.length > 0) lines.push(`REGRESSED: ${diff.regressed.join(", ")}`);
    if (diff.improved.length > 0) lines.push(`improved: ${diff.improved.join(", ")}`);
    if (diff.regressed.length === 0 && diff.improved.length === 0) lines.push("no case changed.");
  }
  return lines.join("\n");
}


/**
 * Build a throwaway product repo for one case and run the real engineer against it.
 *
 * A real git repo, the real runner, the real gate and the real boundary check - only the agent
 * is swapped. That is the seam that matters: the agent is what the eval is scoring, so
 * everything around it has to be the thing that actually runs in production, or the score is
 * about the harness.
 */
export async function runEvalCase(testCase: EvalCase, agent: AgentRunner): Promise<CaseResult> {
  const root = mkdtempSync(join(tmpdir(), "ap-eval-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });

  writeFileSync(join(root, "DESIGN.md"), testCase.design);
  if (testCase.vision !== undefined) {
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "vision.md"), testCase.vision);
  }
  for (const [path, body] of Object.entries(testCase.files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }

  git("init", "-q", "-b", "main");
  git("config", "user.email", "eval@autopilot.test");
  git("config", "user.name", "Autopilot Eval");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  const beforeRef = git("rev-parse", "HEAD").trim();

  const config = parseConfig({
    product: {
      name: "EvalProduct",
      vision: "docs/vision.md",
      anchors: ["DESIGN.md", ...(testCase.vision === undefined ? [] : ["docs/vision.md"])],
    },
    repo: { root, defaultBranch: "main", branchPrefix: "auto/" },
    // `linear` because the schema allows nothing else; the tracker object below is a
    // FileTracker regardless, so nothing here reaches the network.
    tracker: { kind: "linear", project: "Eval" },
    // A gate that runs and passes, so a case scores the agent rather than a toolchain.
    gate: { commands: ["true"], featureFlags: { required: Boolean(testCase.expect.flagged), defaultState: "off" } },
    environments: { staging: { deploy: "true" }, production: { deploy: "false", requiresHumanApproval: true } },
    boundaries: { protectedPaths: testCase.expect.neverTouches ?? [], forbiddenCommands: [], maxTicketsInFlight: 1 },
    cadence: { selfAuditOnEmptyBacklog: false, retentionDays: 30 },
  });

  const tracker = new FileTracker(join(root, ".autopilot", "tickets.json"));
  const ticket = await tracker.create(testCase.ticket);
  const outcome = await runEngineer({ config, tracker, agent, ticket });

  // Evidence from git, never from the agent's own account of what it did.
  const changed = git("diff", "--name-only", `${beforeRef}...HEAD`).split("\n").map((l) => l.trim()).filter(Boolean);
  const diff = git("diff", `${beforeRef}...HEAD`);
  return scoreCase(testCase, outcome, { changed, diff });
}

export async function runEval(
  cases: EvalCase[],
  agentFor: (testCase: EvalCase) => AgentRunner,
): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  // Sequential: each case builds a real repo and runs a real gate, and a parallel run would
  // make a slow case look like a flaky one.
  for (const testCase of cases) {
    results.push(await runEvalCase(testCase, agentFor(testCase)));
  }
  return results;
}
