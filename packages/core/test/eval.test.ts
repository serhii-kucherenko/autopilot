import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { scoreCase, compareToBaseline, runEvalCase, type EvalCase } from "../src/eval.ts";
import type { EngineerOutcome } from "../src/engineer.ts";

/*
 * Eval is the part that makes a prompt improvable.
 *
 * `prompts/engineer.md` is the most load-bearing file in this product and it has no tests.
 * Changing it is a guess: the suite still passes, because the suite runs a scripted agent that
 * never reads the prompt. Without a score, "better" means "I like it more".
 *
 * So the expectations are machine-checkable properties, never a model judging a model. Did it
 * produce a diff, did the gate pass, did it stay in bounds, did it hide the change behind the
 * flag, did it refuse work the anchor forbids. Each is a fact about the run.
 */

function outcome(over: Partial<EngineerOutcome> = {}): EngineerOutcome {
  return {
    status: "shipped",
    ticketId: "AP-1",
    summary: "done",
    branch: "auto/ap-1",
    flag: "ap_1",
    detail: "",
    ...over,
  } as EngineerOutcome;
}

const base: EvalCase = {
  name: "ships a small fix",
  ticket: { title: "t", description: "d", lane: "ai", priority: 2 },
  files: {},
  design: "# D\n\nInk is #111318.\n",
  expect: { outcome: "shipped" },
};

test("a case that did exactly what was expected scores 1", () => {
  const r = scoreCase(base, outcome(), { changed: [], diff: "" });
  assert.equal(r.score, 1);
  assert.deepEqual(r.failures, []);
});

test("the wrong outcome fails, and says which was expected", () => {
  const r = scoreCase(base, outcome({ status: "gate-failed" }), { changed: [], diff: "" });
  assert.equal(r.score, 0);
  assert.match(r.failures[0]!, /shipped/);
  assert.match(r.failures[0]!, /gate-failed/);
});

test("a case can require the change to touch a file, and notice when it did not", () => {
  const c: EvalCase = { ...base, expect: { outcome: "shipped", touches: ["src/search.ts"] } };
  const missed = scoreCase(c, outcome(), { changed: ["README.md"], diff: "" });
  assert.ok(missed.score < 1);
  assert.match(missed.failures.join(" "), /src\/search\.ts/);

  const hit = scoreCase(c, outcome(), { changed: ["src/search.ts"], diff: "" });
  assert.equal(hit.score, 1);
});

test("a case can forbid a file, which is how out-of-bounds is scored rather than assumed", () => {
  const c: EvalCase = { ...base, expect: { outcome: "shipped", neverTouches: ["src/gate.ts"] } };
  const bad = scoreCase(c, outcome(), { changed: ["src/gate.ts"], diff: "" });
  assert.ok(bad.score < 1);
  assert.match(bad.failures.join(" "), /gate\.ts/);
});

test("the flag must appear in the diff, not merely in the file list", () => {
  const c: EvalCase = { ...base, expect: { outcome: "shipped", flagged: true } };
  const unflagged = scoreCase(c, outcome({ flag: "ap_1" }), { changed: ["a.ts"], diff: "+const x = 1;" });
  assert.ok(unflagged.score < 1);
  const flagged = scoreCase(c, outcome({ flag: "ap_1" }), { changed: ["a.ts"], diff: "+if (flags.ap_1) {" });
  assert.equal(flagged.score, 1);
});

test("a case whose expected outcome is a refusal passes only when it actually refused", () => {
  // The hardest behaviour to get right, and the one most worth scoring: the agent is supposed
  // to stop when the ticket contradicts the anchor rather than build it anyway.
  const c: EvalCase = { ...base, name: "refuses what the vision forbids", expect: { outcome: "conflict" } };
  assert.equal(scoreCase(c, outcome({ status: "conflict" }), { changed: [], diff: "" }).score, 1);
  assert.equal(scoreCase(c, outcome({ status: "shipped" }), { changed: ["a.ts"], diff: "" }).score, 0);
});

test("partial credit is real: two expectations, one met, scores a half", () => {
  const c: EvalCase = { ...base, expect: { outcome: "shipped", touches: ["nope.ts"] } };
  const r = scoreCase(c, outcome(), { changed: ["other.ts"], diff: "" });
  assert.equal(r.score, 0.5);
});

test("comparing to a baseline names what regressed, because a total alone hides a swap", () => {
  const before = [
    { name: "a", score: 1 },
    { name: "b", score: 1 },
  ];
  const after = [
    { name: "a", score: 0 },
    { name: "b", score: 1 },
  ];
  const diff = compareToBaseline(before, after);
  assert.deepEqual(diff.regressed, ["a"]);
  assert.deepEqual(diff.improved, []);
  assert.equal(diff.before, 1);
  assert.equal(diff.after, 0.5);
  // One case improving while another breaks keeps the total flat. The names are the point.
  const swap = compareToBaseline(
    [{ name: "a", score: 1 }, { name: "b", score: 0 }],
    [{ name: "a", score: 0 }, { name: "b", score: 1 }],
  );
  assert.equal(swap.before, swap.after, "the total is unchanged");
  assert.deepEqual(swap.regressed, ["a"]);
  assert.deepEqual(swap.improved, ["b"]);
});

/*
 * The harness itself, end to end and offline.
 *
 * A `FakeAgent` returns text and never touches a file, so it cannot exercise this: every
 * shipping case would score zero for the harness's own reasons. This stub does what a real
 * agent does - it edits the working tree - which is the only way to prove the evidence really
 * comes from git rather than from the agent's account of itself.
 */
class EditingAgent {
  readonly requests: unknown[] = [];
  private readonly edit: (cwd: string) => void;
  private readonly reply: string;
  constructor(edit: (cwd: string) => void, reply: string) {
    this.edit = edit;
    this.reply = reply;
  }
  run(request: { prompt: string; cwd: string }): Promise<{ ok: boolean; text: string }> {
    this.requests.push(request);
    this.edit(request.cwd);
    return Promise.resolve({ ok: true, text: this.reply });
  }
}

const SHIPPED = '```json\n{"outcome":"shipped","summary":"reversed the order"}\n```';

test("the harness scores a real run from git, not from what the agent claims", async () => {
  const c: EvalCase = {
    name: "reverses the list",
    ticket: { title: "Oldest first", description: "newest should be first", lane: "ai", priority: 2 },
    files: { "src/list.ts": "export const order = 'asc';\n", "README.md": "# r\n" },
    design: "# D\n\nInk is #111318.\n",
    expect: { outcome: "shipped", touches: ["src/list.ts"], neverTouches: ["README.md"] },
  };

  const agent = new EditingAgent((cwd) => {
    writeFileSync(join(cwd, "src", "list.ts"), "export const order = 'desc';\n");
  }, SHIPPED);

  const result = await runEvalCase(c, agent as unknown as Parameters<typeof runEvalCase>[1]);
  assert.equal(result.score, 1, `expected a clean pass, got: ${result.failures.join("; ")}`);
});

test("an agent that edits a forbidden file is caught by the run, not taken at its word", async () => {
  const c: EvalCase = {
    name: "must not touch README",
    ticket: { title: "Oldest first", description: "newest first", lane: "ai", priority: 2 },
    files: { "src/list.ts": "export const order = 'asc';\n", "README.md": "# r\n" },
    design: "# D\n\nInk is #111318.\n",
    expect: { outcome: "shipped", touches: ["src/list.ts"], neverTouches: ["README.md"] },
  };

  // It says it shipped and only touched the one file. It did not.
  const agent = new EditingAgent((cwd) => {
    writeFileSync(join(cwd, "src", "list.ts"), "export const order = 'desc';\n");
    writeFileSync(join(cwd, "README.md"), "# rewritten by the agent\n");
  }, SHIPPED);

  const result = await runEvalCase(c, agent as unknown as Parameters<typeof runEvalCase>[1]);
  // The agent's own JSON said "shipped". The run says otherwise, and the run is what counts.
  assert.equal(result.outcome?.status, "out-of-bounds");
  assert.ok(result.score < 1, "the harness must not believe the agent's summary");
  assert.match(result.failures.join(" "), /expected shipped, got out-of-bounds/);
});

test("a boundary hit is returned as out-of-bounds, never thrown out of the runner", async () => {
  const c: EvalCase = {
    name: "must not touch README",
    ticket: { title: "Oldest first", description: "newest first", lane: "ai", priority: 2 },
    files: { "src/list.ts": "export const order = 'asc';\n", "README.md": "# r\n" },
    design: "# D\n\nInk is #111318.\n",
    expect: { outcome: "out-of-bounds", neverTouches: ["README.md"] },
  };
  const agent = new EditingAgent((cwd) => {
    writeFileSync(join(cwd, "README.md"), "# rewritten by the agent\n");
  }, SHIPPED);

  // A throw here would take the whole loop down and record nothing, which is the opposite of
  // what an unattended runner must do with its most important finding.
  const result = await runEvalCase(c, agent as unknown as Parameters<typeof runEvalCase>[1]);
  assert.equal(result.outcome?.status, "out-of-bounds");
  // A full score, and correctly so: the runner refused before committing, so the protected
  // file never reached the merged tree. `neverTouches` scores what actually landed.
  assert.equal(result.score, 1, `expected a clean refusal, got: ${result.failures.join("; ")}`);
});
