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

test("a measure is not a spacing step, so max-width and font-size are left alone", () => {
  const root = project({
    "src/a.css": ".x { max-width: 34rem; font-size: 13px; padding: 16px; }\n",
  });
  assert.deepEqual(checkAnchor({ root }).violations, [], "only spacing properties are checked");
});

test("the spacing check reads a React inline style too", () => {
  const root = project({
    "src/a.tsx": 'const s = { marginTop: "13px", maxWidth: "34rem" };\n',
  });
  assert.deepEqual(
    checkAnchor({ root }).violations.map((v) => v.value),
    ["13px"],
  );
});

test("a token definition is the declaration site, not a use, so it is not flagged", () => {
  const root = project({ "src/a.css": ":root { --space-odd: 13px; }\n" });
  assert.deepEqual(checkAnchor({ root }).violations, []);
});

test("a test file is never scanned, because its fixtures are wrong on purpose", () => {
  const root = project({
    "src/bad.test.ts": 'const c = "#ff00aa";\n',
    "src/bad.spec.tsx": 'const c = "#ff00aa";\n',
    "src/real.ts": 'const c = "#111318";\n',
  });
  const report = checkAnchor({ root });
  assert.deepEqual(report.violations, []);
  assert.equal(report.filesScanned, 1, "only the real file");
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

test("a raw oklch() is caught too, or an all-OKLCH palette would sail past the check", () => {
  const root = project(
    { "src/a.css": ".x { color: oklch(58% 0.2 256); background: oklch(98.5% 0.004 250); }\n" },
    "# DESIGN\n\n`--accent` is oklch(58% 0.2 256).\n",
  );
  const report = checkAnchor({ root });
  assert.deepEqual(
    report.violations.map((v) => v.value),
    ["oklch(98.5% 0.004 250)"],
    "the declared one passes, the undeclared one does not",
  );
});

test("whitespace inside oklch() does not smuggle a colour past the check", () => {
  const root = project(
    { "src/a.css": ".x { color: oklch(  58%   0.2   256  ); }\n" },
    "# DESIGN\n\n`--accent` is oklch(58% 0.2 256).\n",
  );
  assert.deepEqual(checkAnchor({ root }).violations, []);
});

test("a colour in a comment is not a use of a colour", () => {
  const root = project({
    "src/a.css": "/* was #ff00aa before the token existed */\n.x { color: #111318; }\n",
    "src/b.ts": '// TODO: #ff00aa used to be here\nconst c = "#111318";\n',
    "src/c.ts": "/* multi\n   line #ff00aa\n*/\nexport const ok = 1;\n",
  });
  assert.deepEqual(checkAnchor({ root }).violations, []);
});

test("stripping a comment keeps the line numbers honest", () => {
  const root = project({
    "src/a.css": "/* nothing\n   here\n*/\n.x { color: #ff00aa; }\n",
  });
  assert.equal(checkAnchor({ root }).violations[0]!.line, 4);
});

test("a https:// url is not mistaken for a comment", () => {
  const root = project({
    "src/a.css": '.x { background: url(https://cdn/x.png); color: #ff00aa; }\n',
  });
  assert.deepEqual(
    checkAnchor({ root }).violations.map((v) => v.value),
    ["#ff00aa"],
  );
});

test("a spacing scale written in bare points still counts as declared", () => {
  const root = project(
    { "src/a.css": ".x { padding: 16px; gap: 28px; margin: 13px; }\n" },
    "# DESIGN\n\n| Token | Value |\n|---|---|\n| spaceMd | 16 |\n| gutterRegular | 28 |\n",
  );
  assert.deepEqual(
    checkAnchor({ root }).violations.map((v) => v.value),
    ["13px"],
    "16 and 28 are declared as points; 13 is not declared at all",
  );
});

test("inherit and the generic families are not font stacks", () => {
  const root = project({
    "src/a.css":
      "a { font-family: inherit; } b { font-family: sans-serif; } c { font-family: system-ui; } d { font-family: Papyrus; }\n",
  });
  assert.deepEqual(
    checkAnchor({ root }).violations.map((v) => v.value),
    ["Papyrus"],
  );
});

test("a git worktree is never scanned, or every finding multiplies by branch count", () => {
  const root = project({
    ".worktrees/other-branch/src/a.css": ".x { color: #ff00aa; }\n",
    "src/ok.css": ".x { color: #111318; }\n",
  });
  const report = checkAnchor({ root });
  assert.deepEqual(report.violations, []);
  assert.equal(report.filesScanned, 1);
});

test("a long report is capped and summarised by file, because nobody reads 3000 lines", () => {
  const many = Array.from({ length: 60 }, (_v, i) => `.c${i} { color: #ff00${(i % 90) + 10}; }`).join("\n");
  const root = project({ "src/many.css": `${many}\n`, "src/one.css": ".x { color: #abcdef; }\n" });
  const text = formatAnchorReport(checkAnchor({ root }));

  assert.match(text, /anchor violations in 2 files \(\d+ colour\)/);
  assert.match(text, /and \d+ more\. The files with the most:/);
  assert.ok(text.split("\n").length < 45, "the report stays readable");
});

test("vendored and generated directories are skipped, whatever the tool named them", () => {
  const root = project({
    "ios/DerivedData/SourcePackages/checkouts/lib/bootstrap.css": ".x { color: #ff00aa; }\n",
    "ios/DerivedData-Sim/SourcePackages/checkouts/lib/bootstrap.css": ".x { color: #ff00aa; }\n",
    "Pods/Thing/style.css": ".x { color: #ff00aa; }\n",
    "vendor/other/style.css": ".x { color: #ff00aa; }\n",
    "app/globals.css": ".x { color: #111318; }\n",
  });
  const report = checkAnchor({ root });
  assert.deepEqual(report.violations, []);
  assert.equal(report.filesScanned, 1, "only the product's own stylesheet");
});

test("exclude honours the config's protected paths, since the loop may not touch them", () => {
  const root = project({
    "public/pdfjs/viewer.css": ".x { color: #ff00aa; }\n",
    "app/globals.css": ".x { color: #ff00bb; }\n",
  });
  const report = checkAnchor({ root, exclude: ["public/pdfjs/"] });
  assert.deepEqual(
    report.violations.map((v) => v.file),
    ["app/globals.css"],
  );
});

test("eval fixtures are not scanned, because they hold another product's design system", () => {
  const root = mkdtempSync(join(tmpdir(), "ap-anchor-eval-"));
  mkdirSync(join(root, "eval"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "DESIGN.md"), "# D\n\nInk is #111318.\n");
  // A fixture describing a fictional product, whose colours are deliberately not ours.
  writeFileSync(join(root, "eval", "cases.ts"), 'const DESIGN = "Accent: #2f6bff";\n');
  // A real source file with the same undeclared colour is still a finding.
  writeFileSync(join(root, "src", "real.css"), ".x { color: #2f6bff; }\n");

  const report = checkAnchor({ root });
  const files = report.violations.map((v) => v.file);
  assert.ok(
    files.some((f) => f.includes("real.css")),
    "the checker must still find real drift, or this skip has made it useless",
  );
  assert.equal(
    files.some((f) => f.includes("cases.ts")),
    false,
    "a fixture's own design system is not this product's drift",
  );
});
