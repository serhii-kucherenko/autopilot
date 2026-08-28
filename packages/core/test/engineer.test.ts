import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEngineer } from "../src/engineer.ts";
import { parseConfig, type Config } from "../src/config.ts";
import { FakeAgent, type FakeStep } from "../src/agent.ts";
import { FileTracker, type Ticket } from "../src/tracker.ts";
import { Git } from "../src/git.ts";
import { Store } from "../src/store.ts";
import { pressProduction } from "../src/release.ts";

/** A real git repo with one commit, so the runner exercises real branching and merging. */
function productRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ap-product-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "loop@autopilot.test");
  git("config", "user.name", "Autopilot");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "# product\n");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "search.ts"), "export const rank = () => [];\n");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
  return dir;
}

function config(root: string, over: Record<string, unknown> = {}): Config {
  return parseConfig({
    product: { name: "Reco", vision: "docs/vision.md" },
    tracker: { kind: "linear", project: "Reco" },
    repo: { root, defaultBranch: "main", branchPrefix: "auto/" },
    environments: {
      staging: { deploy: "echo deployed-to-staging > STAGING_DEPLOYED", url: "https://staging.reco" },
      // If the runner ever reached for production, this file would appear. Nothing in the
      // suite creates it, which is the proof for the release gate.
      production: { deploy: "touch PRODUCTION_WAS_DEPLOYED" },
    },
    gate: { commands: ["test -f src/search.ts"] },
    boundaries: { protectedPaths: ["secrets/"], forbiddenCommands: ["rm -rf"] },
    ...over,
  });
}

function ticket(over: Partial<Ticket> = {}): Ticket {
  return {
    id: "SER-1",
    title: "Search returns stale results",
    description: "**Done when**\n\nfresh within one refresh",
    lane: "ai",
    priority: 2,
    state: "Backlog",
    stateType: "backlog",
    labels: ["lane:ai"],
    blockedBy: [],
    createdAt: "2026-08-01T00:00:00Z",
    ...over,
  };
}

function tracker() {
  return new FileTracker(join(mkdtempSync(join(tmpdir(), "ap-eng-")), "tickets.json"));
}

function reply(json: Record<string, unknown>): string {
  return `Read DESIGN.md and the ADRs first.\n\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\``;
}

/** A fake agent turn that writes real code behind the flag, the way a real one would. */
function shipsCode(flag = "flag_ser_1", extra = ""): FakeStep {
  return {
    text: reply({ outcome: "shipped", summary: "Search ranks by recency", unsure: "the tie-break on equal timestamps" }),
    effect: (cwd) => {
      writeFileSync(
        join(cwd, "src", "search.ts"),
        `const ${flag} = false;\nexport const rank = (items: string[]) => (${flag} ? items.slice().reverse() : []);\n${extra}`,
      );
    },
  };
}

test("one ticket goes from backlog to staging, behind a flag, and the queue reflects it", async () => {
  const root = productRepo();
  const t = tracker();
  const store = new Store(mkdtempSync(join(tmpdir(), "ap-store-")));
  const agent = new FakeAgent([shipsCode("flag_ap_1")]);
  const created = await t.create({ title: "Search returns stale results", description: "d", lane: "ai", priority: 2 });

  const out = await runEngineer({
    config: config(root),
    tracker: t,
    agent,
    store,
    ticket: { ...ticket(), id: created.id },
  });

  assert.equal(out.status, "shipped", out.detail);
  assert.equal(out.flag, `flag_${created.id.toLowerCase().replace("-", "_")}`);

  const git = new Git(root);
  assert.equal(git.currentBranch(), "main", "the runner leaves the product repo on its default branch");
  assert.match(readFileSync(join(root, "src", "search.ts"), "utf8"), /flag_ap_1/);
  assert.ok(existsSync(join(root, "STAGING_DEPLOYED")), "staging must actually be deployed");
  assert.equal(existsSync(join(root, "PRODUCTION_WAS_DEPLOYED")), false, "production is never the loop's to press");

  assert.equal((await t.get(created.id))?.state, "Done", "staging behind a flag is the whole of the loop's job");
  const comments = await t.comments(created.id);
  assert.match(comments.join("\n"), /merged into `main`/);
  assert.match(comments.join("\n"), /Deployed to staging: https:\/\/staging\.reco/);

  const runs = store.undigestedRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.unsure, "the tie-break on equal timestamps");
  assert.equal(runs[0]!.commitSHA, out.commitSHA);
  store.close();
});

test("a failing gate blocks the merge and leaves the ticket in progress", async () => {
  const root = productRepo();
  const t = tracker();
  const created = await t.create({ title: "a", description: "", lane: "ai", priority: 2 });
  const agent = new FakeAgent([shipsCode("flag_ap_1")]);

  const out = await runEngineer({
    config: config(root, { gate: { commands: ["test -f DOES_NOT_EXIST"] } }),
    tracker: t,
    agent,
    ticket: { ...ticket(), id: created.id },
  });

  assert.equal(out.status, "gate-failed");
  assert.match(out.detail, /quality gate FAILED/);
  const git = new Git(root);
  git.checkout("main");
  assert.match(readFileSync(join(root, "src", "search.ts"), "utf8"), /export const rank = \(\) => \[\];/, "main is untouched");
  assert.equal(existsSync(join(root, "STAGING_DEPLOYED")), false, "nothing deploys when the gate fails");
  assert.equal((await t.get(created.id))?.state, "In Progress", "the ticket stays open, the gate is not lowered");
});

test("a change not behind the required flag is refused, even with a green gate", async () => {
  const root = productRepo();
  const t = tracker();
  const created = await t.create({ title: "a", description: "", lane: "ai", priority: 2 });
  const agent = new FakeAgent([
    {
      text: reply({ outcome: "shipped", summary: "changed it, but with no flag" }),
      effect: (cwd) => writeFileSync(join(cwd, "src", "search.ts"), "export const rank = () => [1];\n"),
    },
  ]);

  const out = await runEngineer({ config: config(root), tracker: t, agent, ticket: { ...ticket(), id: created.id } });

  assert.equal(out.status, "gate-failed");
  assert.match(out.summary, /not behind the required flag/);
  assert.equal(existsSync(join(root, "STAGING_DEPLOYED")), false);
});

test("a diff touching a protected path is never committed", async () => {
  const root = productRepo();
  const t = tracker();
  const created = await t.create({ title: "a", description: "", lane: "ai", priority: 2 });
  const agent = new FakeAgent([
    {
      text: reply({ outcome: "shipped", summary: "helpfully rotated the secrets" }),
      effect: (cwd) => {
        mkdirSync(join(cwd, "secrets"), { recursive: true });
        writeFileSync(join(cwd, "secrets", "key.json"), "{}");
      },
    },
  ]);

  const out = await runEngineer({ config: config(root), tracker: t, agent, ticket: { ...ticket(), id: created.id } });

  assert.equal(out.status, "out-of-bounds");
  assert.match(out.detail, /secrets\/key\.json matches protected secrets\//);
  assert.equal(new Git(root).currentBranch(), "auto/ap-1");
  assert.match((await t.comments(created.id)).join("\n"), /Refused to commit/);
});

test("an anchor conflict stops the ticket and hands the decision back, unmerged", async () => {
  const root = productRepo();
  const t = tracker();
  const created = await t.create({ title: "a", description: "", lane: "ai", priority: 2 });
  const agent = new FakeAgent([
    reply({
      outcome: "conflict",
      summary: "cannot do this without contradicting the anchor",
      conflict: "DESIGN.md has no token for a destructive action colour, and this ticket needs one",
    }),
  ]);

  const out = await runEngineer({ config: config(root), tracker: t, agent, ticket: { ...ticket(), id: created.id } });

  assert.equal(out.status, "conflict");
  assert.match(out.conflict!, /no token for a destructive action colour/);
  assert.equal((await t.get(created.id))?.state, "Backlog", "a conflicted ticket goes back, it does not sit half-done");
  assert.equal(existsSync(join(root, "STAGING_DEPLOYED")), false);
});

test("a human-only blocker comes back with the runbook attached to the ticket", async () => {
  const root = productRepo();
  const t = tracker();
  const created = await t.create({ title: "a", description: "", lane: "ai", priority: 2 });
  const agent = new FakeAgent([
    reply({
      outcome: "blocked",
      summary: "needs an API key nobody can generate but you",
      runbook: "1. open https://example.com/settings/keys\n2. press Create key\n3. paste it back as RECO_API_KEY",
    }),
  ]);

  const out = await runEngineer({ config: config(root), tracker: t, agent, ticket: { ...ticket(), id: created.id } });

  assert.equal(out.status, "blocked");
  assert.match((await t.comments(created.id)).join("\n"), /open https:\/\/example\.com\/settings\/keys/);
});

test("an agent that changed nothing is reported as such, not as shipped", async () => {
  const root = productRepo();
  const t = tracker();
  const created = await t.create({ title: "a", description: "", lane: "ai", priority: 2 });
  const agent = new FakeAgent([reply({ outcome: "shipped", summary: "I thought about it" })]);

  const out = await runEngineer({ config: config(root), tracker: t, agent, ticket: { ...ticket(), id: created.id } });
  assert.equal(out.status, "no-change");
  assert.equal(existsSync(join(root, "STAGING_DEPLOYED")), false);
});

test("the engineer prompt carries the ticket, the anchor and the flag, and says who deploys", async () => {
  const root = productRepo();
  const t = tracker();
  await t.create({ title: "Search returns stale results", description: "", lane: "ai", priority: 2 });
  const agent = new FakeAgent([reply({ outcome: "shipped", summary: "x" })]);
  await runEngineer({ config: config(root), tracker: t, agent, ticket: ticket({ id: "AP-1" }) });

  const prompt = agent.requests[0]!.prompt;
  assert.match(prompt, /You are the engineer for `Reco`/);
  assert.match(prompt, /AP-1 - Search returns stale results/);
  assert.match(prompt, /`DESIGN\.md`/);
  assert.match(prompt, /`docs\/adr\/`/);
  assert.match(prompt, /flag_ap_1/);
  assert.match(prompt, /You never deploy anything/);
  assert.match(prompt, /`secrets\/`/, "the boundaries must be stated, then enforced anyway");
  assert.equal(agent.requests[0]!.cwd, root, "the agent works in the product repo, never in Autopilot");
});

test("a dry run writes nothing anywhere and hands back the prompt for review", async () => {
  const root = productRepo();
  const t = tracker();
  const created = await t.create({ title: "a", description: "", lane: "ai", priority: 2 });
  const agent = new FakeAgent([shipsCode()]);

  const out = await runEngineer({
    config: config(root),
    tracker: t,
    agent,
    ticket: { ...ticket(), id: created.id },
    dryRun: true,
  });

  assert.equal(agent.requests.length, 0, "a dry run must not spend a model call");
  assert.match(out.detail, /You are the engineer for `Reco`/);
  assert.equal((await t.get(created.id))?.state, "Backlog");
});

test("a second run on the same ticket resumes its branch instead of failing", async () => {
  const root = productRepo();
  const t = tracker();
  const created = await t.create({ title: "a", description: "", lane: "ai", priority: 2 });

  const first = await runEngineer({
    config: config(root, { gate: { commands: ["test -f DOES_NOT_EXIST"] } }),
    tracker: t,
    agent: new FakeAgent([shipsCode("flag_ap_1")]),
    ticket: { ...ticket(), id: created.id },
  });
  assert.equal(first.status, "gate-failed");

  const second = await runEngineer({
    config: config(root),
    tracker: t,
    agent: new FakeAgent([shipsCode("flag_ap_1", "// second pass\n")]),
    ticket: { ...ticket(), id: created.id },
  });
  assert.equal(second.status, "shipped", second.detail);
  assert.match(readFileSync(join(root, "src", "search.ts"), "utf8"), /second pass/);
});

test("a failed staging deploy is not a ship, and offers the human nothing to press", async (t) => {
  const root = productRepo();
  const tr = tracker();
  const s = new Store(mkdtempSync(join(tmpdir(), "ap-store-")));
  t.after(() => s.close());
  const created = await tr.create({ title: "a", description: "", lane: "ai", priority: 2 });

  const out = await runEngineer({
    config: config(root, {
      environments: { staging: { deploy: "exit 9" }, production: { deploy: "touch PRODUCTION_WAS_DEPLOYED" } },
    }),
    tracker: tr,
    store: s,
    agent: new FakeAgent([shipsCode("flag_ap_1")]),
    ticket: { ...ticket(), id: created.id },
  });

  assert.equal(out.status, "deploy-failed", out.detail);
  assert.match(out.detail, /staging deploy failed \(exit 9\)/);
  assert.deepEqual(s.undigestedRuns(), [], "nothing pressable is recorded for a build that never deployed");
  assert.notEqual((await tr.get(created.id))?.state, "Done");
  assert.deepEqual(s.undigestedSignals().map((x) => x.kind), ["deploy-failed"]);
});

test("the repo goes back to the default branch whatever happened", async () => {
  const cases: [string, FakeStep][] = [
    ["conflict", reply({ outcome: "conflict", summary: "no", conflict: "the anchor forbids it" })],
    ["blocked", reply({ outcome: "blocked", summary: "no", runbook: "open the dashboard" })],
    ["no-change", reply({ outcome: "shipped", summary: "I thought about it" })],
  ];

  for (const [name, step] of cases) {
    const root = productRepo();
    const tr = tracker();
    const created = await tr.create({ title: "a", description: "", lane: "ai", priority: 2 });
    await runEngineer({
      config: config(root),
      tracker: tr,
      agent: new FakeAgent([step]),
      ticket: { ...ticket(), id: created.id },
    });
    assert.equal(new Git(root).currentBranch(), "main", `${name} left the tree on the ticket branch`);
    assert.equal((await tr.get(created.id))?.state, "Backlog", `${name} left the ticket in flight`);
  }
});

test("a gate failure returns the tree to base but keeps the branch, so the next run resumes", async () => {
  const root = productRepo();
  const tr = tracker();
  const created = await tr.create({ title: "a", description: "", lane: "ai", priority: 2 });

  const out = await runEngineer({
    config: config(root, { gate: { commands: ["false"] } }),
    tracker: tr,
    agent: new FakeAgent([shipsCode("flag_ap_1")]),
    ticket: { ...ticket(), id: created.id },
  });

  assert.equal(out.status, "gate-failed");
  const git = new Git(root);
  assert.equal(git.currentBranch(), "main");
  assert.ok(git.branchExists("auto/ap-1"), "the work is still on its branch");
  assert.equal((await tr.get(created.id))?.state, "In Progress", "still in flight, on purpose");
});

test("a press reads the default branch, not whatever branch is checked out", async (t) => {
  const root = productRepo();
  const s = new Store(mkdtempSync(join(tmpdir(), "ap-store-")));
  t.after(() => s.close());
  const cfg = config(root);
  const git = new Git(root);
  const mainHead = git.headOf("main");

  // A runner that stopped mid-ticket used to leave the tree here.
  git.checkoutBranch("auto/ap-1");
  writeFileSync(join(root, "src", "search.ts"), "export const rank = () => [2];\n");
  const branchHead = git.commitAll("unreviewed work on a branch");
  assert.notEqual(branchHead, mainHead);

  s.recordRun({ ticketId: "AP-1", commitSHA: mainHead, branch: "auto/ap-1", flag: "f", summary: "s" });
  const pressed = pressProduction({ config: cfg, store: s, ticketId: "AP-1", approvedBy: "serhii" });

  assert.equal(pressed.commitSHA, mainHead, "the press approves what is on main, not the branch tip");
  assert.ok(s.approvalFor("AP-1", mainHead));
  assert.equal(s.approvalFor("AP-1", branchHead), undefined);
});
