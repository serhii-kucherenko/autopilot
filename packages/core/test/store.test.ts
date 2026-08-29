import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { parseBundle } from "../src/bundle.ts";

const PNG = Buffer.from("fake-png-bytes").toString("base64");

function bundle(sessionID: string, comment = "search results are stale") {
  return parseBundle({
    sessionID,
    app: { name: "Reco", platform: "iPadOS", commitSHA: "abc1234" },
    sentAt: "2026-08-28T09:00:00Z",
    annotations: [
      { id: `${sessionID}-a1`, comment, screenshotPNG: PNG, trace: [], screen: "Library" },
    ],
  });
}

function store() {
  return new Store(mkdtempSync(join(tmpdir(), "ap-store-")));
}

test("a bundle survives a round trip, and its inline PNG lands on disk", (t) => {
  const s = store();
  t.after(() => s.close());

  const { id, created } = s.put(bundle("s1"));
  assert.equal(id, "s1");
  assert.equal(created, true);

  const got = s.get("s1");
  assert.ok(got);
  assert.equal(got.bundle.annotations[0]!.comment, "search results are stale");

  const path = got.bundle.annotations[0]!.screenshotPath;
  assert.ok(path && existsSync(path), "the crop must be a real file");
  assert.equal(readFileSync(path!).toString("base64"), PNG);
  // The image lives on disk, not in the row (ADR 0004).
  assert.equal(got.bundle.annotations[0]!.screenshotBase64, undefined);
});

test("uploading the same bundle twice stores it once, so a device retry is free", (t) => {
  const s = store();
  t.after(() => s.close());

  assert.equal(s.put(bundle("s1")).created, true);
  assert.equal(s.put(bundle("s1", "edited on the second try")).created, false);
  assert.equal(s.undrained().length, 1);
  // First write wins: the ack, not the upload, is what decides a bundle is done.
  assert.equal(s.get("s1")!.bundle.annotations[0]!.comment, "search results are stale");
});

test("undrained lists oldest first and drops what has been acked", (t) => {
  const s = store();
  t.after(() => s.close());

  s.put(bundle("s1"), { receivedAt: "2026-08-01T00:00:00Z" });
  s.put(bundle("s2"), { receivedAt: "2026-08-03T00:00:00Z" });
  s.put(bundle("s3"), { receivedAt: "2026-08-02T00:00:00Z" });

  assert.deepEqual(s.undrained().map((b) => b.bundle.sessionID), ["s1", "s3", "s2"]);
  assert.equal(s.ack("s3"), true);
  assert.deepEqual(s.undrained().map((b) => b.bundle.sessionID), ["s1", "s2"]);
  // The ack is the only thing that marks it done, and it is idempotent.
  assert.equal(s.ack("s3"), true);
  assert.equal(s.ack("nope"), false);
});

test("prune deletes acked bundles past the window, and their images with them", (t) => {
  const s = store();
  t.after(() => s.close());

  s.put(bundle("old"));
  s.put(bundle("new"));
  s.ack("old", "2026-01-01T00:00:00Z");
  s.ack("new", new Date().toISOString());
  const image = s.get("old")!.bundle.annotations[0]!.screenshotPath!;

  assert.equal(s.prune(30, new Date("2026-08-28T00:00:00Z")), 1);
  assert.equal(s.get("old"), undefined);
  assert.equal(existsSync(image), false, "screenshots of a running product must not linger");
  assert.ok(s.get("new"), "an unexpired bundle stays");
});

test("prune never touches a bundle nobody acked, however old", (t) => {
  const s = store();
  t.after(() => s.close());
  s.put(bundle("s1"), { receivedAt: "2020-01-01T00:00:00Z" });
  assert.equal(s.prune(1, new Date()), 0);
  assert.ok(s.get("s1"));
});

test("a production approval is bound to the commit it was granted for", (t) => {
  const s = store();
  t.after(() => s.close());

  s.approve({ ticketId: "SER-1", commitSHA: "aaa111", approvedBy: "serhii" });
  assert.ok(s.approvalFor("SER-1", "aaa111"), "the approved commit is releasable");
  assert.equal(s.approvalFor("SER-1", "bbb222"), undefined, "a later commit is not");
  assert.equal(s.approvalFor("SER-2", "aaa111"), undefined, "another ticket is not");
});

test("a staged run is recorded once and read back for the digest", (t) => {
  const s = store();
  t.after(() => s.close());

  s.recordRun({
    ticketId: "SER-1",
    commitSHA: "aaa111",
    branch: "auto/ser-1",
    flag: "ser_1",
    summary: "Search ranks by recency",
    unsure: "the tie-break on equal timestamps",
  });
  s.recordRun({ ticketId: "SER-2", commitSHA: "bbb222", branch: "auto/ser-2", flag: "ser_2", summary: "Empty state offers an action" });

  assert.deepEqual(s.undigestedRuns().map((r) => r.ticketId), ["SER-1", "SER-2"]);
  s.markDigested(["SER-1"]);
  assert.deepEqual(s.undigestedRuns().map((r) => r.ticketId), ["SER-2"]);
});

test("reopening the store sees what the last process wrote", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ap-store-"));
  const first = new Store(root);
  first.put(bundle("s1"));
  first.close();

  const second = new Store(root);
  t.after(() => second.close());
  assert.equal(second.undrained().length, 1);
});

/*
 * "Is it working?" needs a denominator.
 *
 * Signals record only the outcomes that were not a clean ship, and runs record the ships. Both
 * existed; nothing ever put them together, so the digest could say "3 conflicts" and a person
 * had no way to know whether that was 3 out of 4 or 3 out of 300. A failure count without an
 * attempt count is not a measurement.
 */
test("the store can say how many attempts shipped, which is the only honest success number", (t) => {
  const s = store();
  t.after(() => s.close());

  s.recordRun({ ticketId: "AP-1", commitSHA: "a1", branch: "auto/ap-1", flag: "ap_1", summary: "one" });
  s.recordRun({ ticketId: "AP-2", commitSHA: "a2", branch: "auto/ap-2", flag: "ap_2", summary: "two" });
  s.recordSignal({ kind: "gate-failed", ticketId: "AP-3" });
  s.recordSignal({ kind: "conflict", ticketId: "AP-4" });
  s.recordSignal({ kind: "conflict", ticketId: "AP-5" });

  const tally = s.tally();
  assert.equal(tally.shipped, 2);
  assert.equal(tally.failed, 3);
  assert.equal(tally.attempts, 5);
  assert.deepEqual(tally.byKind, { "gate-failed": 1, conflict: 2 });
});

test("a tally on an untouched store is all zeroes, not a divide by zero", (t) => {
  const s = store();
  t.after(() => s.close());
  const tally = s.tally();
  assert.deepEqual(tally, { shipped: 0, failed: 0, attempts: 0, byKind: {} });
});

test("the tally counts every run ever, not just the undigested ones", (t) => {
  const s = store();
  t.after(() => s.close());
  s.recordRun({ ticketId: "AP-1", commitSHA: "a1", branch: "b", flag: "f", summary: "one" });
  s.markDigested(["AP-1"]);
  // A digest that resets the score would make the number meaningless the moment it is read.
  assert.equal(s.tally().shipped, 1);
});
