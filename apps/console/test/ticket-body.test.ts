/**
 * The ticket-description parser, and the claim that nothing device-supplied becomes markup.
 *
 * The parse is tested directly. The escaping is React's, not this repo's, so what is worth
 * asserting is the thing that would break it: `dangerouslySetInnerHTML` appearing anywhere in
 * the console.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseTicketBlocks, parseSpans } from "../lib/ticket-blocks.ts";

const TRIAGE_DESCRIPTION = [
  "**Their words**",
  "",
  "> search results are stale",
  "> and the empty state is blank",
  "",
  "**Context**",
  "",
  "GET /api/search -> ranking.ts",
  "",
  "**Done when**",
  "",
  "fresh within one refresh",
  "",
  "Filed from annotation a1.",
].join("\n");

test("a triage description parses into labels, a quote and text, with no asterisks left", () => {
  const blocks = parseTicketBlocks(TRIAGE_DESCRIPTION);

  assert.deepEqual(
    blocks.map((b) => b.kind),
    ["label", "quote", "label", "text", "label", "text", "text"],
  );
  assert.equal(blocks[0]!.text, "Their words");
  assert.equal(blocks[1]!.text, "search results are stale\nand the empty state is blank");
  assert.equal(
    blocks.some((b) => b.text.includes("**")),
    false,
    "no asterisk reaches the reader",
  );
});

test("a self-audit description parses its aside", () => {
  const blocks = parseTicketBlocks(
    "**Where**\n\n`app/globals.css:54`\n\n_Filed by the self-audit, not by a person._",
  );
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ["label", "text", "aside"],
  );
  assert.equal(blocks[2]!.text, "Filed by the self-audit, not by a person.");
});

test("backticks become mono spans, so a path or a flag is copyable", () => {
  assert.deepEqual(parseSpans("see `app/globals.css:54` for it"), [
    { mono: false, text: "see " },
    { mono: true, text: "app/globals.css:54" },
    { mono: false, text: " for it" },
  ]);
  assert.deepEqual(parseSpans("no code here"), [{ mono: false, text: "no code here" }]);
});

test("a double-backtick fence is not supported, and degrades to a stray backtick", () => {
  // Markdown's ``code with a ` in it`` form. The runners never emit it, and the worst it does
  // is show one extra backtick, so it is a stated limit rather than a bug to chase.
  assert.deepEqual(parseSpans("`` empty ``"), [
    { mono: false, text: "`" },
    { mono: true, text: " empty " },
    { mono: false, text: "`" },
  ]);
});

test("an unrecognised shape falls through as text rather than vanishing", () => {
  const blocks = parseTicketBlocks("# a heading nobody expected\n\n- and a list item");
  assert.deepEqual(blocks, [
    { kind: "text", text: "# a heading nobody expected" },
    { kind: "text", text: "- and a list item" },
  ]);
});

test("mid-sentence bold is left alone rather than half-parsed", () => {
  assert.deepEqual(parseTicketBlocks("this has **bold** in the middle"), [
    { kind: "text", text: "this has **bold** in the middle" },
  ]);
});

test("an empty description parses to nothing, so the screen shows no empty box", () => {
  assert.deepEqual(parseTicketBlocks(""), []);
  assert.deepEqual(parseTicketBlocks("\n\n   \n"), []);
});

test("markup in an annotation stays data: it parses as text, never as a tag", () => {
  const nasty = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const blocks = parseTicketBlocks(`**Their words**\n\n> ${nasty}`);
  assert.equal(blocks[1]!.kind, "quote");
  assert.equal(blocks[1]!.text, nasty, "kept verbatim, and React escapes it on render");
});

test("no component in the console sets raw HTML", () => {
  // React escapes every string it renders, so the escaping is its guarantee rather than this
  // repo's. What is worth asserting is the single thing that would defeat it.
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".next", ".autopilot", "test"].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(tsx?|jsx?)$/.test(entry.name)) files.push(path);
    }
  };
  const root = new URL("..", import.meta.url).pathname;
  assert.ok(statSync(root).isDirectory());
  walk(root);

  const offenders = files.filter((f) => /dangerouslySetInnerHTML\s*=/.test(readFileSync(f, "utf8")));
  assert.deepEqual(offenders, []);
  assert.ok(files.length > 10, `the walk found only ${files.length} files, so it is not checking much`);
});
