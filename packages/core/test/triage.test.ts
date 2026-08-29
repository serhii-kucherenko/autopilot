import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTriage, describeBacklog } from "../src/triage.ts";
import { parseConfig } from "../src/config.ts";
import { parseBundle } from "../src/bundle.ts";
import { FakeAgent } from "../src/agent.ts";
import { FileTracker } from "../src/tracker.ts";
import { Store } from "../src/store.ts";
import { ReplyError } from "../src/reply.ts";

const config = parseConfig({
  product: { name: "Reco", vision: "docs/vision.md" },
  tracker: { kind: "linear", project: "Reco" },
  repo: { root: ".", defaultBranch: "main" },
  environments: { staging: { deploy: "bash deploy.sh" } },
  gate: { commands: ["pnpm test"] },
});

function tracker() {
  return new FileTracker(join(mkdtempSync(join(tmpdir(), "ap-triage-")), "tickets.json"));
}

const bundle = parseBundle({
  sessionID: "s1",
  app: { name: "Reco", platform: "iPadOS", commitSHA: "abc1234" },
  annotations: [
    {
      id: "a1",
      comment: "search results are stale",
      element: { accessibilityID: "search-field", label: "Search" },
      trace: [{ method: "GET", url: "https://api/search?q=x", statusCode: 200, durationMs: 91 }],
      screen: "Library",
    },
    { id: "a2", comment: "and the empty state is ugly", screen: "Library", trace: [] },
  ],
});

function reply(json: unknown, prose = "Read both crops. The first is a ranking bug.") {
  return `${prose}\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`\n`;
}

test("two annotations can become two tickets in different lanes", async () => {
  const agent = new FakeAgent([
    reply({
      tickets: [
        {
          title: "Search returns stale results",
          lane: "ai",
          priority: 2,
          context: "GET /api/search -> searchController.ts -> ranking.ts",
          evidence: "trace pinned GET https://api/search, build abc1234",
          theirWords: "search results are stale",
          doneWhen: "a fresh item appears in results within one refresh",
          fromAnnotations: ["a1"],
          labels: ["bug"],
        },
        {
          title: "Library empty state has no next action",
          lane: "human",
          priority: 4,
          theirWords: "and the empty state is ugly",
          doneWhen: "the empty state offers one action",
          fromAnnotations: ["a2"],
        },
      ],
    }),
  ]);

  const t = tracker();
  const result = await runTriage({ config, tracker: t, agent, input: { bundles: [bundle] } });

  assert.equal(result.created.length, 2);
  assert.deepEqual(result.created.map((x) => x.lane), ["ai", "human"]);
  assert.ok(result.created[0]!.labels.includes("lane:ai"));
  assert.ok(result.created[1]!.labels.includes("lane:human"));
  assert.equal((await t.listOpen()).length, 2, "the tickets are really in the tracker");
});

test("the prompt carries the trace, the crop and the build, because triage cannot guess them", async () => {
  const agent = new FakeAgent([reply({ tickets: [{ title: "x", lane: "ai", priority: 3 }] })]);
  await runTriage({ config, tracker: tracker(), agent, input: { bundles: [bundle] } });

  const prompt = agent.requests[0]!.prompt;
  assert.match(prompt, /GET https:\/\/api\/search\?q=x -> 200/);
  assert.match(prompt, /Build: abc1234/);
  assert.match(prompt, /search results are stale/);
  assert.match(prompt, /do not invent an endpoint/, "the empty-trace annotation must say so");
  assert.match(prompt, /You are triage for `Reco`/);
  assert.match(prompt, /`2` annotations/, "the annotation count must be filled in");
});

test("triage is given the open backlog, so it can link instead of filing again", async () => {
  const t = tracker();
  await t.create({ title: "Search returns stale results", description: "", lane: "ai", priority: 2 });

  const agent = new FakeAgent([
    reply({
      tickets: [],
      linkedToExisting: [{ ticket: "AP-1", why: "same underlying problem as a1" }],
      question: "should the empty state link to import, or to search?",
    }),
  ]);
  const result = await runTriage({ config, tracker: t, agent, input: { bundles: [bundle] } });

  assert.match(agent.requests[0]!.prompt, /AP-1 \[ai, p2, Backlog\] Search returns stale results/);
  assert.equal(result.created.length, 0);
  assert.deepEqual(result.linkedToExisting, [{ ticket: "AP-1", why: "same underlying problem as a1" }]);
  assert.equal(result.question, "should the empty state link to import, or to search?");
  assert.equal((await t.listOpen()).length, 1, "nothing new was filed");
});

test("conversational capture goes through the same prompt with no bundle", async () => {
  const agent = new FakeAgent([
    reply({ tickets: [{ title: "Search feels slow", lane: "ai", priority: 2, theirWords: "the search feels slow" }] }),
  ]);
  const result = await runTriage({
    config,
    tracker: tracker(),
    agent,
    input: { text: "the search feels slow and the empty state is ugly" },
  });

  assert.equal(result.created.length, 1);
  assert.match(agent.requests[0]!.prompt, /the search feels slow and the empty state is ugly/);
  assert.match(agent.requests[0]!.prompt, /You are triage for `Reco`/);
});

test("triage never gets write tools, whatever the prompt says", async () => {
  const agent = new FakeAgent([reply({ tickets: [{ title: "x", lane: "ai", priority: 3 }] })]);
  await runTriage({ config, tracker: tracker(), agent, input: { text: "something" } });

  const tools = agent.requests[0]!.allowedTools ?? [];
  assert.deepEqual(tools.filter((t) => ["Write", "Edit", "NotebookEdit"].includes(t)), []);
  assert.equal(agent.requests[0]!.permissionMode, "plan");
});

test("the ticket body keeps their words verbatim and in a quote", async () => {
  const agent = new FakeAgent([
    reply({
      tickets: [
        {
          title: "t",
          lane: "ai",
          priority: 3,
          theirWords: "search results are stale",
          context: "ranking.ts",
          doneWhen: "fresh within one refresh",
        },
      ],
    }),
  ]);
  const result = await runTriage({ config, tracker: tracker(), agent, input: { text: "x" } });
  const body = result.created[0]!.description;

  assert.match(body, /> search results are stale/);
  assert.match(body, /\*\*Context\*\*/);
  assert.match(body, /\*\*Done when\*\*/);
});

test("dry run writes nothing to the tracker but still shows what it would file", async () => {
  const agent = new FakeAgent([reply({ tickets: [{ title: "Search is stale", lane: "ai", priority: 2 }] })]);
  const t = tracker();
  const result = await runTriage({ config, tracker: t, agent, input: { text: "x" }, dryRun: true });

  assert.equal(result.created.length, 1);
  assert.equal(result.created[0]!.title, "Search is stale");
  assert.deepEqual(await t.listOpen(), [], "a dry run must not touch the queue");
});

test("an answer with no json block fails loudly instead of silently filing nothing", async () => {
  const agent = new FakeAgent(["I looked at everything and it all seems fine."]);
  await assert.rejects(
    runTriage({ config, tracker: tracker(), agent, input: { text: "x" } }),
    ReplyError,
  );
});

test("the example shape the agent was shown is not mistaken for its answer", async () => {
  // An agent that quotes the contract first, then answers. The last block is the answer.
  const echoed = "Here is the shape I was given:\n\n```json\n{ \"tickets\": [] }\n```\n";
  const agent = new FakeAgent([
    `${echoed}\nNow my answer:\n\n\`\`\`json\n${JSON.stringify({ tickets: [{ title: "real", lane: "ai", priority: 2 }] })}\n\`\`\``,
  ]);
  const result = await runTriage({ config, tracker: tracker(), agent, input: { text: "x" } });
  assert.equal(result.created[0]!.title, "real");
});

test("a ticket with no title is refused rather than filed as untitled", async () => {
  const agent = new FakeAgent([reply({ tickets: [{ lane: "ai", priority: 2, context: "c" }] })]);
  await assert.rejects(runTriage({ config, tracker: tracker(), agent, input: { text: "x" } }), ReplyError);
});

test("a failed agent run is an error, not an empty triage", async () => {
  const agent = new FakeAgent([{ text: "boom", ok: false }]);
  await assert.rejects(
    runTriage({ config, tracker: tracker(), agent, input: { text: "x" } }),
    /triage agent failed/,
  );
});

test("triage with neither a bundle nor text is a programming error", async () => {
  await assert.rejects(
    runTriage({ config, tracker: tracker(), agent: new FakeAgent([]), input: {} }),
    /given neither/,
  );
});

test("triaging the same bundle twice files nothing the second time", async () => {
  // SER-622's stated Done-when, and it was not met: an explicit re-run of `triage <dir>`
  // filed every ticket again. The device-generated sessionID plus the ack is the mechanism.
  const root = mkdtempSync(join(tmpdir(), "ap-idem-"));
  const store = new Store(root);
  const t = new FileTracker(join(root, "tickets.json"));
  const answer = reply({ tickets: [{ title: "Search is stale", lane: "ai", priority: 2 }] });

  store.put(bundle);
  const first = await runTriage({
    config,
    tracker: t,
    agent: new FakeAgent([answer]),
    input: { bundles: [bundle] },
    store,
  });
  assert.equal(first.created.length, 1);
  assert.deepEqual(first.alreadyTriaged, []);

  store.ack(bundle.sessionID);

  const second = await runTriage({
    config,
    tracker: t,
    agent: new FakeAgent([answer]),
    input: { bundles: [bundle] },
    store,
  });
  assert.equal(second.created.length, 0, "a re-run must not duplicate");
  assert.deepEqual(second.alreadyTriaged, [bundle.sessionID]);
  assert.equal((await t.listAll()).length, 1);
  store.close();
});

test("an unacked bundle is still triaged, so a crashed run can simply run again", async () => {
  const root = mkdtempSync(join(tmpdir(), "ap-idem-"));
  const store = new Store(root);
  const t = new FileTracker(join(root, "tickets.json"));
  store.put(bundle);
  // No ack: the previous run died before filing anything.
  const result = await runTriage({
    config,
    tracker: t,
    agent: new FakeAgent([reply({ tickets: [{ title: "x", lane: "ai", priority: 2 }] })]),
    input: { bundles: [bundle] },
    store,
  });
  assert.equal(result.created.length, 1);
  store.close();
});

test("with no store there is nothing to check against, and triage still runs", async () => {
  const result = await runTriage({
    config,
    tracker: tracker(),
    agent: new FakeAgent([reply({ tickets: [{ title: "x", lane: "ai", priority: 2 }] })]),
    input: { bundles: [bundle] },
  });
  assert.equal(result.created.length, 1);
  assert.deepEqual(result.alreadyTriaged, []);
});

/*
 * Two tickets for one thing, and a backlog that does not blow the prompt.
 *
 * Triage is told to merge duplicates and it is given the open backlog to do it with - but the
 * backlog it saw was `id [lane, p, state] title` and nothing else. Two tickets can describe the
 * same problem in different words ("search is stale" / "results do not refresh") and no reader,
 * human or model, can tell from titles alone. The description is where the overlap actually is.
 *
 * And it was unbounded. A product with three hundred open tickets would have put all three
 * hundred into one prompt.
 */
test("the backlog handed to triage carries enough of each ticket to spot a duplicate", () => {
  const text = describeBacklog([
    {
      id: "AP-1",
      title: "Search is stale",
      description: "Typing a new query keeps showing the previous result set until you reload.",
      lane: "ai",
      priority: 2,
      state: "Backlog",
      stateType: "backlog",
      labels: [],
      blockedBy: [],
      createdAt: "2026-08-28T00:00:00Z",
    },
  ]);
  assert.match(text, /AP-1/);
  assert.match(text, /Search is stale/);
  assert.match(text, /previous result set/, "the description is where an overlap is visible");
});

test("a long description is cut, so one rambling ticket cannot crowd out the rest", () => {
  const text = describeBacklog([
    {
      id: "AP-1",
      title: "Long one",
      description: "x".repeat(5000),
      lane: "ai",
      priority: 2,
      state: "Backlog",
      stateType: "backlog",
      labels: [],
      blockedBy: [],
      createdAt: "2026-08-28T00:00:00Z",
    },
  ]);
  assert.ok(text.length < 1000, `one ticket must not dominate, got ${text.length} chars`);
});

test("a huge backlog is capped and says how many it left out, rather than silently truncating", () => {
  const many = Array.from({ length: 300 }, (_, i) => ({
    id: `AP-${i + 1}`,
    title: `Ticket ${i + 1}`,
    description: "something",
    lane: "ai" as const,
    priority: 2,
    state: "Backlog",
    stateType: "backlog" as const,
    labels: [],
    blockedBy: [],
    createdAt: "2026-08-28T00:00:00Z",
  }));
  const text = describeBacklog(many);
  assert.match(text, /\b\d+ more\b/, "a silent cut would let triage duplicate what it cannot see");
  assert.ok(text.length < 20000, `the prompt must stay bounded, got ${text.length} chars`);
});
