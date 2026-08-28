import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBundle, readBundleDir, BundleError } from "../src/bundle.ts";

const APP = { name: "Reco", platform: "iPadOS", environment: "staging", commitSHA: "abc1234" };
const BOUNDS = { x: 10, y: 20, width: 100, height: 44 };
const ID = "5B3A1E62-0000-4000-8000-000000000001";

function bundleJSON(overrides: Record<string, unknown> = {}) {
  return {
    sessionID: "AAAA1111-0000-4000-8000-000000000000",
    app: APP,
    sentAt: "2026-08-28T09:00:00Z",
    annotations: [
      {
        id: ID,
        comment: "search results are stale",
        tag: "bug",
        element: { accessibilityID: "search-field", label: "Search", className: "SearchField", bounds: BOUNDS },
        trace: [{ method: "GET", url: "https://api/search?q=x", statusCode: 200, durationMs: 91, at: "2026-08-28T08:59:58Z" }],
        screen: "Library",
        capturedAt: "2026-08-28T08:59:59Z",
      },
    ],
    ...overrides,
  };
}

test("parses an HTTPTransport bundle and keeps the inline screenshot", () => {
  const png = Buffer.from("fake-png").toString("base64");
  const raw = bundleJSON();
  (raw.annotations as any[])[0].screenshotPNG = png;

  const b = parseBundle(raw);
  assert.equal(b.sessionID, "AAAA1111-0000-4000-8000-000000000000");
  assert.equal(b.app.name, "Reco");
  assert.equal(b.annotations.length, 1);
  assert.equal(b.annotations[0]!.screenshotBase64, png);
  assert.equal(b.annotations[0]!.trace[0]!.url, "https://api/search?q=x");
});

test("parses a bundle with no screenshot at all", () => {
  const b = parseBundle(bundleJSON());
  assert.equal(b.annotations[0]!.screenshotBase64, undefined);
  assert.equal(b.annotations[0]!.screenshotPath, undefined);
});

test("rejects a bundle with no annotations, because an empty tray is a bug not a no-op", () => {
  assert.throws(() => parseBundle(bundleJSON({ annotations: [] })), BundleError);
});

test("rejects a bundle missing sessionID, since the id is what makes retry safe", () => {
  const raw = bundleJSON();
  delete (raw as any).sessionID;
  assert.throws(() => parseBundle(raw), BundleError);
});

test("rejects an annotation with no comment", () => {
  const raw = bundleJSON();
  (raw.annotations as any[])[0].comment = "   ";
  assert.throws(() => parseBundle(raw), BundleError);
});

test("tolerates a missing element, because every anchor field is best effort", () => {
  const raw = bundleJSON();
  delete (raw.annotations as any[])[0].element;
  const b = parseBundle(raw);
  assert.equal(b.annotations[0]!.element, undefined);
});

test("readBundleDir finds the sibling PNG that FileTransport wrote", () => {
  const dir = mkdtempSync(join(tmpdir(), "loupe-"));
  const session = join(dir, "AAAA1111-0000-4000-8000-000000000000");
  mkdirSync(session);
  writeFileSync(join(session, "bundle.json"), JSON.stringify(bundleJSON()));
  writeFileSync(join(session, `${ID}.png`), Buffer.from("fake-png"));

  const b = readBundleDir(session);
  assert.equal(b.annotations[0]!.screenshotPath, join(session, `${ID}.png`));
  assert.equal(b.annotations[0]!.screenshotBase64, undefined);
});

test("readBundleDir survives a missing PNG rather than failing the whole tray", () => {
  const dir = mkdtempSync(join(tmpdir(), "loupe-"));
  const session = join(dir, "s");
  mkdirSync(session);
  writeFileSync(join(session, "bundle.json"), JSON.stringify(bundleJSON()));

  const b = readBundleDir(session);
  assert.equal(b.annotations[0]!.screenshotPath, undefined);
});
