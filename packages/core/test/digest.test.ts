import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coherenceOf, describeCoherence } from "../src/digest.ts";
import { checkAnchor } from "../src/anchor.ts";

/*
 * The digest's own numbers must match the command it tells you to run.
 *
 * `coherenceOf` passed `boundaries.protectedPaths` to the anchor check, which was the same
 * coupling removed from `check-anchor` in ADR 0011 and missed here. So the moment self-hosting
 * protected first-party source, the digest started hiding violations inside exactly the files
 * that decide whether the loop may ship - while its comment claimed the numbers matched.
 */
test("the digest counts the same anchor violations check-anchor does, protected files included", () => {
  const root = mkdtempSync(join(tmpdir(), "ap-digest-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "DESIGN.md"), "# D\n\nInk is #111318. Spacing scale: 8px, 16px.\n");
  writeFileSync(join(root, "src", "gate.ts"), 'const c = "#ff00ff";\n');

  const config = {
    repo: { root },
    boundaries: { protectedPaths: ["src/gate.ts"] },
  } as unknown as Parameters<typeof coherenceOf>[0];

  const direct = checkAnchor({ root }).violations.length;
  assert.equal(direct, 1, "the fixture must actually violate, or this test proves nothing");
  assert.equal(
    coherenceOf(config, []).anchorViolations,
    direct,
    "a protected file is still a file that has to keep the design system",
  );
});

test("the coherence report states the rate, because a failure count alone cannot be read", () => {
  const text = describeCoherence({
    conflicts: 3,
    anchorViolations: 0,
    anchorExists: true,
    signals: [],
    tally: { shipped: 97, failed: 3, attempts: 100, byKind: { conflict: 3 } },
  });
  assert.match(text, /97/, "the shipped count must be there");
  assert.match(text, /100/, "and the denominator, or the 3 means nothing");
});

test("with no attempts yet, the report says so instead of dividing by zero", () => {
  const text = describeCoherence({
    conflicts: 0,
    anchorViolations: 0,
    anchorExists: true,
    signals: [],
    tally: { shipped: 0, failed: 0, attempts: 0, byKind: {} },
  });
  assert.match(text, /nothing has run|no attempts|not run yet/i);
  assert.doesNotMatch(text, /NaN|Infinity/);
});
