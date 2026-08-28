import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAnchor, declaredValues, formatAnchorReport } from "../src/anchor.ts";

const DESIGN = `# DESIGN.md

## Colour
| Token | Light | Dark |
| -- | -- | -- |
| \`--ink\` | #111318 | #f4f6fa |
| \`--accent\` | #2f6df6 | #7ea6ff |

## Type
Body is \`Inter\`, code is \`JetBrains Mono\`.

## Spacing
The scale is 4px, 8px, 12px, 16px, 24px, 32px, 48px.
`;

// `null` means no DESIGN.md at all. Not `undefined`: that would trigger the default.
function project(files: Record<string, string>, design: string | null = DESIGN): string {
  const root = mkdtempSync(join(tmpdir(), "ap-anchor-"));
  if (design !== null) writeFileSync(join(root, "DESIGN.md"), design);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

test("declaredValues picks up colours, fonts and the spacing scale", () => {
  const declared = declaredValues(DESIGN);
  assert.ok(declared.has("#111318"));
  assert.ok(declared.has("#7ea6ff"));
  assert.ok(declared.has("inter"));
  assert.ok(declared.has("jetbrains mono"));
  assert.ok(declared.has("16px"));
  assert.equal(declared.has("#ff0000"), false);
});

test("a colour the anchor never declared is a violation, with the file and line", () => {
  const root = project({
    "src/Button.tsx": 'export const B = () => <button style={{ color: "#ff0000" }} />;\n',
  });
  const report = checkAnchor({ root });

  assert.equal(report.violations.length, 1);
  assert.equal(report.violations[0]!.kind, "colour");
  assert.equal(report.violations[0]!.file, "src/Button.tsx");
  assert.equal(report.violations[0]!.line, 1);
  assert.match(report.violations[0]!.hint, /not in DESIGN\.md/);
});

test("a declared colour is clean, in either case", () => {
  const root = project({
    "src/a.css": ".x { color: #111318; }\n",
    "src/b.css": ".y { color: #2F6DF6; }\n",
  });
  assert.deepEqual(checkAnchor({ root }).violations, []);
});

test("a font stack the anchor never named is a violation; a token is not", () => {
  const root = project({
    "src/a.css": "body { font-family: Comic Sans MS, sans-serif; }\n",
    "src/b.css": "body { font-family: var(--font-body); }\n",
    "src/c.css": "code { font-family: 'JetBrains Mono', monospace; }\n",
  });
  const report = checkAnchor({ root });
  assert.deepEqual(
    report.violations.map((v) => [v.kind, v.value]),
    [["font", "Comic Sans MS"]],
  );
});

test("off-scale spacing is a violation, and the values every system uses literally are not", () => {
  const root = project({
    "src/a.css": ".x { padding: 16px; margin: 13px; border-width: 1px; top: 0px; }\n",
  });
  const report = checkAnchor({ root });
  assert.deepEqual(
    report.violations.map((v) => v.value),
    ["13px"],
  );
});

test("node_modules, dist and .next are never scanned", () => {
  const root = project({
    "node_modules/lib/a.css": ".x { color: #ff0000; }\n",
    "dist/bundle.js": 'var c = "#00ff00";\n',
    ".next/x.css": ".y { color: #0000ff; }\n",
    "src/ok.css": ".z { color: #111318; }\n",
  });
  const report = checkAnchor({ root });
  assert.deepEqual(report.violations, []);
  assert.equal(report.filesScanned, 1);
});

test("DESIGN.md itself is not scanned as code, or every token would be a violation", () => {
  const root = project({ "src/a.css": ".x { color: #111318; }\n" });
  assert.deepEqual(checkAnchor({ root }).violations, []);
});

test("no DESIGN.md is reported as no anchor, not as a clean run", () => {
  const root = project({ "src/a.css": ".x { color: #ff0000; }\n" }, null);
  const report = checkAnchor({ root });

  assert.equal(report.designMissing, true);
  assert.deepEqual(report.violations, [], "there is nothing to compare against");
  assert.match(formatAnchorReport(report), /has no anchor/);
});

test("the report names the coherence rule, so the fix is obvious", () => {
  const root = project({ "src/a.css": ".x { color: #ff0000; }\n" });
  const text = formatAnchorReport(checkAnchor({ root }));
  assert.match(text, /src\/a\.css:1/);
  assert.match(text, /extend the/);
  assert.match(formatAnchorReport(checkAnchor({ root: project({}) })), /Anchor clean/);
});

test("include narrows the scan to the directories that hold UI", () => {
  const root = project({
    "src/a.css": ".x { color: #ff0000; }\n",
    "scripts/tool.ts": 'const c = "#00ff00";\n',
  });
  const report = checkAnchor({ root, include: ["src"] });
  assert.equal(report.violations.length, 1);
  assert.equal(report.violations[0]!.file, "src/a.css");
});
