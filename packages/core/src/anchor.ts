/**
 * The coherence check (`docs/coherence.md`).
 *
 * `DESIGN.md` says how a product looks, in named tokens. This finds the places code stopped
 * using them: a raw hex value, a font stack, a spacing number that is not on the scale. Each
 * one is a small local decision, and the sum of two hundred of them is the drift the anchor
 * exists to prevent.
 *
 * What this does NOT do is judge whether a change contradicts an ADR. That needs reading
 * and reasoning, and `prompts/self-audit.md` already asks for it under "Anchor violations".
 * ponytail: mechanical checks in code, judgment in the prompt. Two tools, each doing the
 * thing it is actually good at.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { matchesPattern } from "./boundaries.ts";

export type ViolationKind = "colour" | "font" | "spacing";

export interface AnchorViolation {
  file: string;
  line: number;
  value: string;
  kind: ViolationKind;
  hint: string;
}

export interface AnchorReport {
  violations: AnchorViolation[];
  filesScanned: number;
  /** Distinct literal values `DESIGN.md` declares. Zero means the anchor is not real yet. */
  declaredValues: number;
  designPath: string;
  designMissing?: boolean;
}

const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".css", ".scss", ".vue", ".svelte"]);

const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  ".autopilot",
  // Git worktrees are copies of the same code. Scanning them multiplies every finding by
  // however many branches someone has checked out - it turned one real report into 3032 lines.
  ".worktrees",
  // Vendored and generated code. Somebody else's bootstrap.css is not this product's drift,
  // and on a real iOS product these four directories alone accounted for 1734 findings.
  "SourcePackages",
  "Pods",
  "Carthage",
  "vendor",
  ".build",
  ".turbo",
  ".cache",
  "out",
  "target",
  "__snapshots__",
  /*
   * Eval fixtures.
   *
   * `eval/cases.ts` carries whole DESIGN.md documents for small fictional products, because a
   * case has to judge the agent against a real anchor to mean anything. Scanning them checks
   * this product's DESIGN.md against another product's tokens, which is a category error
   * rather than a finding - the same reason `TEST_FILE` is skipped, and it produced the same
   * kind of noise: three violations that were all correct fixture data.
   *
   * Narrow on purpose. This directory holds fixtures and nothing a person looks at.
   */
  "eval",
]);

/** Xcode writes `DerivedData`, `DerivedData-Sim`, and whatever else someone names a variant. */
const SKIPPED_PREFIXES = ["DerivedData"];

function skippedDirectory(name: string): boolean {
  return SKIPPED_DIRECTORIES.has(name) || SKIPPED_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * Test files are skipped. A test for a design check is full of deliberately wrong values -
 * this repo's own `anchor.test.ts` contributed 20 of the first 46 findings - and a check that
 * flags its own fixtures is noise that teaches people to ignore it.
 */
const TEST_FILE = /\.(?:test|spec)\.[jt]sx?$/;

// Colour literals, in both notations a modern stylesheet uses. `oklch()` matters as much as
// hex: a palette written entirely in OKLCH would sail past a hex-only check, which is
// exactly the hole this repo's own console would otherwise have walked straight through.
const HEX = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;
const OKLCH = /oklch\(\s*[^)]{3,60}\)/gi;
const FONT_FAMILY = /font-family\s*:\s*([^;\n}]+)/gi;
const SPACING = /(?<![\w.-])(\d+(?:\.\d+)?)(px|rem)\b/g;

/**
 * Any `property: value` pair, in CSS or in a React inline-style object. The value stops at a
 * comma so `{ marginTop: "13px", maxWidth: "34rem" }` reads as two declarations rather than
 * one, which would blame the width on the margin.
 */
const DECLARATION = /(--)?([A-Za-z][A-Za-z0-9-]*)\s*:\s*([^;{},\n]+)/g;

/**
 * The properties the spacing scale actually governs. A `max-width: 34rem` is a measure, not a
 * spacing step, and flagging every one of them was the second thing that made the first run of
 * this check unreadable. `docs/coherence.md`: an over-specified anchor is a real failure mode,
 * and so is an over-broad check.
 */
const SPACING_PROPERTIES = new Set([
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "padding-block",
  "padding-inline",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "margin-block",
  "margin-inline",
  "gap",
  "row-gap",
  "column-gap",
  "top",
  "right",
  "bottom",
  "left",
  "inset",
  "text-indent",
]);

/** `marginTop` in a React style object is the same property as `margin-top` in CSS. */
function kebab(property: string): string {
  return property.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/**
 * Spacing values every design system ends up using literally. Flagging these produces noise
 * that trains people to ignore the check, which is worse than not having it.
 */
const SPACING_ALWAYS_FINE = new Set(["0px", "0rem", "1px", "2px", "100px", "100rem"]);

/**
 * CSS-wide keywords and generic families. `font-family: inherit` is not a font stack, and
 * flagging it is the kind of finding that gets a check switched off.
 */
const FONT_ALWAYS_FINE = new Set([
  "inherit",
  "initial",
  "unset",
  "revert",
  "revert-layer",
  "sans-serif",
  "serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-monospace",
  "ui-sans-serif",
  "ui-serif",
  "ui-rounded",
]);

/**
 * Blank out comments, keeping every newline so a reported line number still points at the real
 * line. A colour in a comment is not a use of a colour - this check flagged an example inside
 * its own doc comment before this existed.
 *
 * `//` only starts a comment when it is not preceded by `:`, so a `https://` URL survives.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

function collectFiles(root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (skippedDirectory(entry.name)) continue;
      collectFiles(join(root, entry.name), out);
    } else if (SCANNED_EXTENSIONS.has(extname(entry.name)) && !TEST_FILE.test(entry.name)) {
      out.push(join(root, entry.name));
    }
  }
  return out;
}

/** Collapse whitespace and case so two spellings of one colour compare equal. */
function normaliseColour(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").replace(/\(\s/g, "(").replace(/\s\)/g, ")");
}

/**
 * Every literal value `DESIGN.md` declares. The check is deliberately literal-based rather
 * than parsing a token syntax: any `DESIGN.md` shape works, and a value the anchor never
 * mentions anywhere is exactly what "not in DESIGN.md" means.
 */
export function declaredValues(designText: string): Set<string> {
  const values = new Set<string>();

  for (const match of designText.matchAll(HEX)) values.add(match[0].toLowerCase());
  for (const match of designText.matchAll(OKLCH)) values.add(normaliseColour(match[0]));
  for (const match of designText.matchAll(SPACING)) values.add(match[0].toLowerCase());

  /*
   * A bare number counts as declaring that many px and rem.
   *
   * Deliberately generous. A perfectly good DESIGN.md writes its scale in points as bare
   * numbers - `| spaceMd | 16 |` - and a literal `16px` match finds none of them. Run against
   * a real product that does exactly this, the strict version produced 3032 findings, which
   * is the same as producing none. A false positive storm gets a check switched off; a false
   * negative is only a miss.
   */
  for (const match of designText.matchAll(/(?<![\w.#-])(\d{1,4})(?![\w.%-])/g)) {
    values.add(`${match[1]}px`);
    values.add(`${match[1]}rem`);
  }

  // Font names, whether written in backticks, in a font-family line, or in a table cell.
  for (const match of designText.matchAll(/[`"']([A-Za-z][A-Za-z0-9 ]{2,40})[`"']/g)) {
    values.add(match[1]!.trim().toLowerCase());
  }
  for (const match of designText.matchAll(FONT_FAMILY)) {
    for (const family of match[1]!.split(",")) {
      values.add(family.trim().replace(/^["']|["']$/g, "").toLowerCase());
    }
  }
  return values;
}

export interface AnchorOptions {
  root: string;
  /** Defaults to `DESIGN.md` at the root. */
  designPath?: string;
  /** Directories to scan, relative to root. Defaults to the whole tree. */
  include?: string[];
  /**
   * Paths whose style is not this loop's problem. `autopilot check-anchor` passes the config's
   * `boundaries.protectedPaths`: code the loop may never touch cannot be code it is asked to
   * bring back onto the scale.
   */
  exclude?: string[];
}

export function checkAnchor(options: AnchorOptions): AnchorReport {
  const designPath = options.designPath ?? join(options.root, "DESIGN.md");

  if (!existsSync(designPath)) {
    return {
      violations: [],
      filesScanned: 0,
      declaredValues: 0,
      designPath,
      designMissing: true,
    };
  }

  // The anchor's own prose is read whole: a value it merely mentions is a value it declares.
  const declared = declaredValues(readFileSync(designPath, "utf8"));

  const roots = (options.include ?? ["."]).map((dir) => join(options.root, dir)).filter(existsSync);
  const exclude = options.exclude ?? [];
  const files = roots
    .flatMap((dir) => (statSync(dir).isDirectory() ? collectFiles(dir) : [dir]))
    .filter((file) => {
      const rel = relative(options.root, file);
      return !exclude.some((pattern) => matchesPattern(rel, pattern));
    });

  const violations: AnchorViolation[] = [];

  for (const file of files) {
    const lines = stripComments(readFileSync(file, "utf8")).split("\n");
    lines.forEach((text, index) => {
      const at = { file: relative(options.root, file), line: index + 1 };

      for (const match of [...text.matchAll(HEX), ...text.matchAll(OKLCH)]) {
        if (declared.has(normaliseColour(match[0]))) continue;
        violations.push({
          ...at,
          value: match[0],
          kind: "colour",
          hint: `${match[0]} is not in DESIGN.md. Use a token, or add the colour to DESIGN.md in this same change.`,
        });
      }

      for (const match of text.matchAll(FONT_FAMILY)) {
        const first = match[1]!.split(",")[0]!.trim().replace(/^["']|["']$/g, "");
        const lower = first.toLowerCase();
        if (first.startsWith("var(") || FONT_ALWAYS_FINE.has(lower) || declared.has(lower)) continue;
        violations.push({
          ...at,
          value: first,
          kind: "font",
          hint: `the font stack "${first}" is not in DESIGN.md. Name it there or use the token.`,
        });
      }

      for (const declaration of text.matchAll(DECLARATION)) {
        // A custom-property declaration is the token definition itself, not a use of one.
        if (declaration[1]) continue;
        if (!SPACING_PROPERTIES.has(kebab(declaration[2]!))) continue;

        for (const match of declaration[3]!.matchAll(SPACING)) {
          const value = match[0].toLowerCase();
          if (SPACING_ALWAYS_FINE.has(value) || declared.has(value)) continue;
          violations.push({
            ...at,
            value: match[0],
            kind: "spacing",
            hint: `${declaration[2]}: ${match[0]} is off the spacing scale in DESIGN.md. Use a spacing token or extend the scale.`,
          });
        }
      }
    });
  }

  return {
    violations,
    filesScanned: files.length,
    declaredValues: declared.size,
    designPath,
  };
}

/** A report nobody can read is a report nobody acts on. The rest is summarised by file. */
const MAX_LISTED = 20;

export function formatAnchorReport(report: AnchorReport): string {
  if (report.designMissing) {
    return (
      `No DESIGN.md at ${report.designPath}.\n` +
      "A product with a UI and no DESIGN.md has no anchor, so nothing here can tell drift from a choice.\n" +
      "Write it from what the code already does, then run this again."
    );
  }
  if (report.violations.length === 0) {
    return `Anchor clean: ${report.filesScanned} files, ${report.declaredValues} values declared in DESIGN.md.`;
  }
  const total = report.violations.length;
  const shown = report.violations.slice(0, MAX_LISTED);
  const lines = shown.map((v) => `  ${v.file}:${v.line}  [${v.kind}]  ${v.hint}`);

  const byKind = new Map<ViolationKind, number>();
  for (const v of report.violations) byKind.set(v.kind, (byKind.get(v.kind) ?? 0) + 1);

  const rest: string[] = [];
  if (total > MAX_LISTED) {
    const byFile = new Map<string, number>();
    for (const v of report.violations.slice(MAX_LISTED)) {
      byFile.set(v.file, (byFile.get(v.file) ?? 0) + 1);
    }
    const worst = [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    rest.push(
      "",
      `and ${total - MAX_LISTED} more. The files with the most:`,
      ...worst.map(([file, count]) => `  ${count.toString().padStart(5)}  ${file}`),
    );
  }

  return [
    `${total} anchor violation${total === 1 ? "" : "s"} in ${report.filesScanned} files ` +
      `(${[...byKind].map(([kind, count]) => `${count} ${kind}`).join(", ")}):`,
    ...lines,
    ...rest,
    "",
    "Each one is a value the anchor never declared. docs/coherence.md rule 2: extend the",
    "anchor in the same change that uses it, or it does not exist.",
  ].join("\n");
}
