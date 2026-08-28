import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, type Config } from "../src/config.ts";
import { FakeAgent, type FakeStep } from "../src/agent.ts";
import { FileTracker } from "../src/tracker.ts";
import { Store } from "../src/store.ts";
import { Git } from "../src/git.ts";
import { runSelfAudit, MAX_FINDINGS_PER_AUDIT } from "../src/selfaudit.ts";
import { runDigest, plainDigest, describeCoherence } from "../src/digest.ts";
import { runRelease, pressProduction } from "../src/release.ts";
import { runLoop } from "../src/loop.ts";
import { runEngineer } from "../src/engineer.ts";
import { ReplyError } from "../src/reply.ts";

function productRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ap-loop-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "loop@autopilot.test");
  git("config", "user.name", "Autopilot");
  git("config", "commit.gpgsign", "false");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "app.ts"), "export const x = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
  return dir;
}

function config(root: string, over: Record<string, unknown> = {}): Config {
  return parseConfig({
    product: { name: "Reco", vision: "docs/vision.md" },
    tracker: { kind: "linear", project: "Reco" },
    repo: { root, defaultBranch: "main" },
    environments: {
      staging: { deploy: "true", url: "https://staging.reco" },
      production: { deploy: "echo shipped > PRODUCTION_RELEASED" },
    },
    gate: { commands: ["true"] },
    ...over,
  });
}

function tracker() {
  return new FileTracker(join(mkdtempSync(join(tmpdir(), "ap-loop-")), "tickets.json"));
}

function store() {
  return new Store(mkdtempSync(join(tmpdir(), "ap-loop-store-")));
}

function reply(json: unknown, prose = "Looked at the tests and the logs."): string {
  return `${prose}\n\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\``;
}

function shipsCode(flag: string): FakeStep {
  return {
    text: reply({ outcome: "shipped", summary: "Search ranks by recency" }),
    effect: (cwd) => writeFileSync(join(cwd, "src", "app.ts"), `const ${flag} = false;\nexport const x = ${flag} ? 2 : 1;\n`),
  };
}

/* ------------------------------------------------------------------- self-audit */

test("the self-audit files findings in the AI lane with evidence attached", async () => {
  const t = tracker();
  const agent = new FakeAgent([
    reply({
      findings: [
        {
          title: "search.spec.ts is flaky on the ranking case",
          priority: 2,
          where: "test/search.spec.ts:88",
          evidence: "failed 3 of 20 runs with 'expected 2 got 1'",
          doneWhen: "20 consecutive runs pass",
        },
      ],
    }),
  ]);

  const result = await runSelfAudit({ config: config(productRepo()), tracker: t, agent });

  assert.equal(result.nothingToDo, false);
  assert.equal(result.created.length, 1);
  assert.equal(result.created[0]!.lane, "ai");
  assert.ok(result.created[0]!.labels.includes("self-audit"));
  assert.match(result.created[0]!.description, /test\/search\.spec\.ts:88/);
  assert.match(result.created[0]!.description, /failed 3 of 20 runs/);
});

test("nothing to find is a correct outcome, not an empty ticket", async () => {
  const agent = new FakeAgent([reply({ findings: [], nothingToDo: true })]);
  const t = tracker();
  const result = await runSelfAudit({ config: config(productRepo()), tracker: t, agent });

  assert.equal(result.nothingToDo, true);
  assert.deepEqual(await t.listOpen(), []);
});

test("more than five findings is refused, not truncated", async () => {
  const findings = Array.from({ length: MAX_FINDINGS_PER_AUDIT + 1 }, (_v, i) => ({
    title: `f${i}`,
    priority: 3,
    where: `a.ts:${i}`,
    evidence: "e",
  }));
  const agent = new FakeAgent([reply({ findings })]);
  await assert.rejects(
    runSelfAudit({ config: config(productRepo()), tracker: tracker(), agent }),
    /the limit is 5/,
  );
});

test("the self-audit may not file in the human lane, because direction is not its call", async () => {
  const agent = new FakeAgent([
    reply({ findings: [{ title: "add a dark mode", lane: "human", priority: 3, where: "app.ts:1", evidence: "e" }] }),
  ]);
  await assert.rejects(
    runSelfAudit({ config: config(productRepo()), tracker: tracker(), agent }),
    /human lane/,
  );
});

test("a finding with no evidence is refused, so 'consider refactoring' cannot become a ticket", async () => {
  const agent = new FakeAgent([reply({ findings: [{ title: "tidy this up", priority: 3, where: "app.ts:1" }] })]);
  await assert.rejects(runSelfAudit({ config: config(productRepo()), tracker: tracker(), agent }), ReplyError);
});

/* ----------------------------------------------------------------------- digest */

test("a quiet day produces no digest and spends no model call", async () => {
  const s = store();
  const agent = new FakeAgent([]);
  const result = await runDigest({ config: config(productRepo()), tracker: tracker(), agent, store: s });

  assert.equal(result.silent, true);
  assert.equal(result.message, "");
  assert.equal(agent.requests.length, 0, "silence must cost nothing");
  s.close();
});

test("the digest carries what shipped, the flag, the staging link and the unsure note", async () => {
  const s = store();
  s.recordRun({
    ticketId: "AP-1",
    commitSHA: "aaa111bbb",
    branch: "auto/ap-1",
    flag: "flag_ap_1",
    summary: "Search ranks by recency",
    unsure: "the tie-break on equal timestamps",
    stagingURL: "https://staging.reco",
  });
  const agent = new FakeAgent(["## Shipped to staging\n\nSearch now ranks by recency."]);
  const t = tracker();
  await t.create({ title: "Empty state has no action", description: "", lane: "human", priority: 4 });

  const result = await runDigest({ config: config(productRepo()), tracker: t, agent, store: s });

  const prompt = agent.requests[0]!.prompt;
  assert.match(prompt, /Search ranks by recency/);
  assert.match(prompt, /flag_ap_1/);
  assert.match(prompt, /https:\/\/staging\.reco/);
  assert.match(prompt, /unsure about: the tie-break/);
  assert.match(prompt, /Never tell them to run a deploy command/);
  assert.equal(result.silent, false);
  assert.deepEqual(result.covered, ["AP-1"]);

  assert.deepEqual(s.undigestedRuns(), [], "a digested run is not reported twice");
  s.close();
});

test("plainDigest says the same facts with no model involved", () => {
  const runs = [
    { ticketId: "AP-1", commitSHA: "aaa", branch: "b", flag: "flag_ap_1", summary: "Search ranks by recency", unsure: "tie-breaks" },
  ];
  const text = plainDigest(runs, [], config(productRepo()));
  assert.match(text, /Search ranks by recency/);
  assert.match(text, /Needs your eyes/);
  assert.equal(plainDigest([], [], config(productRepo())), "", "still silent on a quiet day");
});

/* ---------------------------------------------------------------------- release */

test("release refuses a ticket nobody pressed production on", async () => {
  const root = productRepo();
  const s = store();
  s.recordRun({ ticketId: "AP-1", commitSHA: new Git(root).head(), branch: "b", flag: "f", summary: "s" });

  const result = await runRelease({ config: config(root), store: s, ticketId: "AP-1" });

  assert.equal(result.status, "not-approved");
  assert.match(result.message, /A human presses production in the console/);
  assert.equal(existsSync(join(root, "PRODUCTION_RELEASED")), false);
  s.close();
});

test("release refuses a ticket that never reached staging", async () => {
  const root = productRepo();
  const s = store();
  const result = await runRelease({ config: config(root), store: s, ticketId: "AP-9" });
  assert.equal(result.status, "not-approved");
  assert.match(result.message, /never shipped to staging/);
  s.close();
});

test("a press releases exactly what was pressed", async () => {
  const root = productRepo();
  const s = store();
  const cfg = config(root);
  s.recordRun({ ticketId: "AP-1", commitSHA: new Git(root).head(), branch: "b", flag: "f", summary: "s" });

  pressProduction({ config: cfg, store: s, ticketId: "AP-1", approvedBy: "serhii" });
  const result = await runRelease({ config: cfg, store: s, ticketId: "AP-1" });

  assert.equal(result.status, "released", result.message);
  assert.ok(existsSync(join(root, "PRODUCTION_RELEASED")));
  assert.match(result.message, /approved by serhii/);
  s.close();
});

test("an approval does not carry over to work merged after the press", async () => {
  const root = productRepo();
  const s = store();
  const cfg = config(root);
  const git = new Git(root);
  s.recordRun({ ticketId: "AP-1", commitSHA: git.head(), branch: "b", flag: "f", summary: "s" });
  pressProduction({ config: cfg, store: s, ticketId: "AP-1", approvedBy: "serhii" });

  // Someone merges more work after the press.
  writeFileSync(join(root, "src", "app.ts"), "export const x = 99;\n");
  git.commitAll("unreviewed work");

  const result = await runRelease({ config: cfg, store: s, ticketId: "AP-1" });

  assert.equal(result.status, "moved-on");
  assert.match(result.message, /unreviewed/);
  assert.equal(existsSync(join(root, "PRODUCTION_RELEASED")), false, "unreviewed code must not ship");
  s.close();
});

test("a product with no production deploy says so instead of failing obscurely", async () => {
  const root = productRepo();
  const s = store();
  const cfg = config(root, { environments: { staging: { deploy: "true" } } });
  const result = await runRelease({ config: cfg, store: s, ticketId: "AP-1" });
  assert.equal(result.status, "no-production");
  s.close();
});

/* ------------------------------------------------------------------------- loop */

test("one cycle takes the top ticket, ships it, and reports exit 0", async () => {
  const root = productRepo();
  const t = tracker();
  const s = store();
  await t.create({ title: "low", description: "", lane: "ai", priority: 4 });
  const urgent = await t.create({ title: "urgent", description: "", lane: "ai", priority: 1 });

  const report = await runLoop({
    config: config(root),
    tracker: t,
    agent: new FakeAgent([shipsCode("flag_ap_2")]),
    store: s,
    maxCycles: 1,
  });

  assert.equal(report.exitCode, 0);
  assert.equal(report.cycles.length, 1);
  assert.equal(report.cycles[0]!.kind, "ticket");
  assert.equal(report.cycles[0]!.engineer?.ticketId, urgent.id, "urgent goes first");
  assert.equal(report.cycles[0]!.engineer?.status, "shipped", report.cycles[0]!.engineer?.detail);
  s.close();
});

test("an empty backlog runs a self-audit instead of idling", async () => {
  const agent = new FakeAgent([
    reply({ findings: [{ title: "flaky test", priority: 2, where: "a.ts:1", evidence: "failed 3/20" }] }),
  ]);
  const t = tracker();
  const report = await runLoop({ config: config(productRepo()), tracker: t, agent, maxCycles: 1 });

  assert.equal(report.cycles[0]!.kind, "self-audit");
  assert.equal(report.exitCode, 0);
  assert.equal((await t.listOpen()).length, 1, "the loop refilled its own queue");
});

test("an empty backlog and nothing to audit is exit 2, not a failure", async () => {
  const agent = new FakeAgent([reply({ findings: [], nothingToDo: true })]);
  const report = await runLoop({ config: config(productRepo()), tracker: tracker(), agent, maxCycles: 3 });

  assert.equal(report.exitCode, 2);
  assert.equal(report.cycles.length, 1, "it stops rather than auditing three times");
  assert.match(report.cycles[0]!.message, /An idle loop is a correct outcome/);
});

test("a gate failure stops the loop rather than burying it under the next ticket", async () => {
  const root = productRepo();
  const t = tracker();
  await t.create({ title: "first", description: "", lane: "ai", priority: 1 });
  await t.create({ title: "second", description: "", lane: "ai", priority: 2 });

  const report = await runLoop({
    config: config(root, { gate: { commands: ["false"] } }),
    tracker: t,
    agent: new FakeAgent([shipsCode("flag_ap_1"), shipsCode("flag_ap_2")]),
    maxCycles: 3,
  });

  assert.equal(report.exitCode, 1);
  assert.equal(report.cycles.length, 1);
  assert.equal(report.cycles[0]!.engineer?.status, "gate-failed");
});

test("waking again mid-ticket resumes the same ticket, it does not start a second", async () => {
  const root = productRepo();
  const t = tracker();
  const first = await t.create({ title: "first", description: "", lane: "ai", priority: 3 });
  await t.create({ title: "second", description: "", lane: "ai", priority: 1 });
  await t.setState(first.id, "In Progress");

  const report = await runLoop({
    config: config(root),
    tracker: t,
    agent: new FakeAgent([shipsCode("flag_ap_1")]),
    maxCycles: 1,
  });

  assert.equal(report.cycles[0]!.engineer?.ticketId, first.id, "the in-flight ticket is the lock");
});

test("two cycles in a row work two tickets, because a shipped ticket is done", async () => {
  const root = productRepo();
  const t = tracker();
  await t.create({ title: "first", description: "", lane: "ai", priority: 1 });
  await t.create({ title: "second", description: "", lane: "ai", priority: 2 });

  const report = await runLoop({
    config: config(root),
    tracker: t,
    agent: new FakeAgent([shipsCode("flag_ap_1"), shipsCode("flag_ap_2")]),
    maxCycles: 2,
  });

  assert.deepEqual(report.cycles.map((c) => c.engineer?.status), ["shipped", "shipped"]);
  assert.deepEqual(report.cycles.map((c) => c.engineer?.ticketId), ["AP-1", "AP-2"]);
});

/* -------------------------------------------------------------------- coherence */

test("a conflicted ticket is counted, so the anchor bet can be falsified", async () => {
  const root = productRepo();
  const t = tracker();
  const s = store();
  const created = await t.create({ title: "a", description: "", lane: "ai", priority: 2 });

  await runEngineer({
    config: config(root),
    tracker: t,
    store: s,
    agent: new FakeAgent([
      reply({ outcome: "conflict", summary: "cannot do this", conflict: "DESIGN.md has no token for it" }),
    ]),
    ticket: created,
  });

  const signals = s.undigestedSignals();
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.kind, "conflict");
  assert.equal(signals[0]!.ticketId, created.id);
  s.close();
});

test("a clean ship records no signal, because shipping is not a finding", async () => {
  const root = productRepo();
  const t = tracker();
  const s = store();
  const created = await t.create({ title: "a", description: "", lane: "ai", priority: 2 });

  await runEngineer({
    config: config(root),
    tracker: t,
    store: s,
    agent: new FakeAgent([shipsCode("flag_ap_1")]),
    ticket: created,
  });

  assert.deepEqual(s.undigestedSignals(), []);
  s.close();
});

test("the digest reports both coherence numbers and names the over-specified signal", async () => {
  const root = productRepo();
  const s = store();
  const cfg = config(root);
  s.recordRun({ ticketId: "AP-1", commitSHA: "aaa", branch: "b", flag: "f", summary: "s" });
  for (const id of ["AP-2", "AP-3", "AP-4"]) {
    s.recordSignal({ kind: "conflict", ticketId: id, detail: "the anchor forbids it" });
  }

  const agent = new FakeAgent(["## Shipped\n\nsomething"]);
  const result = await runDigest({ config: cfg, tracker: tracker(), agent, store: s });

  assert.equal(result.coherence?.conflicts, 3);
  assert.equal(result.coherence?.anchorExists, false, "the test product has no DESIGN.md");

  const prompt = agent.requests[0]!.prompt;
  assert.match(prompt, /## Coherence/);
  assert.match(prompt, /AP-2 \[conflict\]/);
  assert.match(prompt, /A conflict is a decision for the human/);

  assert.deepEqual(s.undigestedSignals(), [], "a digested signal is not reported twice");
  s.close();
});

test("a batch of nothing but failures is not a quiet day", async () => {
  const s = store();
  s.recordSignal({ kind: "gate-failed", ticketId: "AP-1", detail: "the suite fails" });
  const agent = new FakeAgent(["## Did not ship\n\nAP-1"]);

  const result = await runDigest({ config: config(productRepo()), tracker: tracker(), agent, store: s });

  assert.equal(result.silent, false, "a loop stuck on a failing gate must not go unreported");
  assert.match(agent.requests[0]!.prompt, /AP-1 \[gate-failed\]/);
  s.close();
});

test("the coherence numbers mean nothing without a DESIGN.md, and it says so", () => {
  assert.match(
    describeCoherence({ conflicts: 0, anchorViolations: 0, anchorExists: false, signals: [] }),
    /no anchor and nothing to measure/,
  );
  assert.match(
    describeCoherence({ conflicts: 1, anchorViolations: 2, anchorExists: true, signals: [] }),
    /stopped on an anchor conflict: 1.*never declared: 2/s,
  );
});

test("a conflict is named in the plain digest, not only counted", () => {
  const cfg = config(productRepo());
  const text = plainDigest([], [], cfg, {
    conflicts: 1,
    anchorViolations: 0,
    anchorExists: true,
    signals: [{ kind: "conflict", ticketId: "AP-2", detail: "the vision refuses a feed", at: "2026-08-28T00:00:00Z" }],
  });
  assert.match(text, /AP-2 \[conflict\] the vision refuses a feed/);
  assert.match(text, /stopped on an anchor conflict: 1/);
});
