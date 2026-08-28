import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTracker, LinearTracker, pickNext, atCapacity, inFlight, type Ticket } from "../src/tracker.ts";

function tracker() {
  return new FileTracker(join(mkdtempSync(join(tmpdir(), "ap-track-")), "tickets.json"));
}

function ticket(over: Partial<Ticket> = {}): Ticket {
  return {
    id: "SER-1",
    title: "t",
    description: "",
    lane: "ai",
    priority: 3,
    state: "Backlog",
    stateType: "backlog",
    labels: [],
    blockedBy: [],
    createdAt: "2026-08-01T00:00:00Z",
    ...over,
  };
}

test("FileTracker writes a ticket and reads it back with an id", async () => {
  const t = tracker();
  const created = await t.create({ title: "Search is stale", description: "why", lane: "ai", priority: 2 });
  assert.match(created.id, /^AP-\d+$/);
  assert.equal(created.lane, "ai");
  assert.ok(created.labels.includes("lane:ai"), "the lane must be a label, as integrations/README says");

  const got = await t.get(created.id);
  assert.equal(got?.title, "Search is stale");
  assert.deepEqual((await t.listOpen()).map((x) => x.id), [created.id]);
});

test("FileTracker persists across instances, so a crashed run resumes", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "ap-track-")), "tickets.json");
  await new FileTracker(path).create({ title: "a", description: "", lane: "ai", priority: 3 });
  assert.equal((await new FileTracker(path).listOpen()).length, 1);
});

test("a completed ticket leaves the open list", async () => {
  const t = tracker();
  const c = await t.create({ title: "a", description: "", lane: "ai", priority: 3 });
  await t.setState(c.id, "Done");
  assert.deepEqual(await t.listOpen(), []);
  assert.equal((await t.get(c.id))?.stateType, "completed");
});

test("comments are appended, never replaced, because they are the run record", async () => {
  const t = tracker();
  const c = await t.create({ title: "a", description: "", lane: "ai", priority: 3 });
  await t.comment(c.id, "first");
  await t.comment(c.id, "second");
  assert.deepEqual(await t.comments(c.id), ["first", "second"]);
});

test("labels lists what has actually been used, so triage can reuse instead of inventing", async () => {
  const t = tracker();
  await t.create({ title: "a", description: "", lane: "ai", priority: 3, labels: ["bug"] });
  await t.create({ title: "b", description: "", lane: "human", priority: 3 });
  assert.deepEqual((await t.labels()).sort(), ["bug", "lane:ai", "lane:human"]);
});

test("pickNext takes urgent before high, and treats no-priority as last", () => {
  const next = pickNext(
    [
      ticket({ id: "SER-none", priority: 0 }),
      ticket({ id: "SER-low", priority: 4 }),
      ticket({ id: "SER-urgent", priority: 1 }),
      ticket({ id: "SER-high", priority: 2 }),
    ]);
  assert.equal(next?.id, "SER-urgent");
});

test("equal priority falls back to oldest first, so nothing starves", () => {
  const next = pickNext(
    [
      ticket({ id: "SER-new", priority: 2, createdAt: "2026-08-10T00:00:00Z" }),
      ticket({ id: "SER-old", priority: 2, createdAt: "2026-08-01T00:00:00Z" }),
    ]);
  assert.equal(next?.id, "SER-old");
});

test("a ticket blocked by an open ticket is skipped, one blocked by a done ticket is not", () => {
  const all = [
    ticket({ id: "SER-blocker", priority: 4 }),
    ticket({ id: "SER-blocked", priority: 1, blockedBy: ["SER-blocker"] }),
  ];
  assert.equal(pickNext(all)?.id, "SER-blocker");

  const unblocked = [
    ticket({ id: "SER-blocker", priority: 4, state: "Done", stateType: "completed" }),
    ticket({ id: "SER-blocked", priority: 1, blockedBy: ["SER-blocker"] }),
  ];
  assert.equal(pickNext(unblocked)?.id, "SER-blocked");
});

test("an in-flight ticket is resumed rather than a second one started", () => {
  const all = [
    ticket({ id: "SER-started", priority: 4, state: "In Progress", stateType: "started" }),
    ticket({ id: "SER-urgent", priority: 1 }),
  ];
  assert.equal(pickNext(all)?.id, "SER-started");
});

test("a running ticket is picked regardless of where it sits in the list", () => {
  const all = [
    ticket({ id: "SER-c", priority: 1 }),
    ticket({ id: "SER-a", stateType: "started", state: "In Progress", createdAt: "2026-08-01T00:00:00Z" }),
    ticket({ id: "SER-b", stateType: "started", state: "In Progress", createdAt: "2026-08-02T00:00:00Z" }),
  ];
  assert.equal(pickNext(all)?.id, "SER-a", "oldest running first");
  assert.deepEqual(inFlight(all).map((t) => t.id), ["SER-a", "SER-b"]);
});

test("atCapacity counts only what is running, and ignores finished work", () => {
  const running = ticket({ id: "SER-a", stateType: "started", state: "In Progress" });
  const done = ticket({ id: "SER-z", stateType: "completed", state: "Done" });
  assert.equal(atCapacity([running, done], 1), true);
  assert.equal(atCapacity([running, done], 2), false);
  assert.equal(atCapacity([done], 1), false);
});

test("an empty backlog returns nothing, which is what triggers the self-audit", () => {
  assert.equal(pickNext([]), undefined);
});

test("LinearTracker sends one GraphQL POST with the API key, and never leaks it in an error", async () => {
  const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({
      url,
      body: JSON.parse(init.body as string),
      headers: init.headers as Record<string, string>,
    });
    return new Response(
      JSON.stringify({
        data: {
          issues: {
            nodes: [
              {
                id: "uuid-1",
                identifier: "SER-1",
                title: "Search is stale",
                description: "d",
                priority: 2,
                url: "https://linear.app/x",
                branchName: "auto/ser-1",
                createdAt: "2026-08-01T00:00:00Z",
                state: { name: "Backlog", type: "backlog" },
                labels: { nodes: [{ name: "lane:ai" }] },
                relations: { nodes: [] },
              },
            ],
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const t = new LinearTracker({ apiKey: "lin_api_secret", project: "Autopilot", fetchImpl: fetchImpl as typeof fetch });
  const open = await t.listOpen();

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.linear.app/graphql");
  assert.equal(calls[0]!.headers.Authorization, "lin_api_secret");
  assert.equal(open[0]!.id, "SER-1");
  assert.equal(open[0]!.lane, "ai");
  assert.equal(open[0]!.stateType, "backlog");
});

test("a GraphQL error is raised with the message but without the key", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ errors: [{ message: "Entity not found" }] }), { status: 200 });
  const t = new LinearTracker({ apiKey: "lin_api_secret", project: "P", fetchImpl: fetchImpl as typeof fetch });
  await assert.rejects(t.listOpen(), (e: Error) => {
    assert.match(e.message, /Entity not found/);
    assert.equal(e.message.includes("lin_api_secret"), false, "the key must never reach a log");
    return true;
  });
});

test("LinearTracker refuses to construct without a key, and says how to get one", () => {
  assert.throws(() => new LinearTracker({ apiKey: "", project: "P" }), /LINEAR_API_KEY/);
});
