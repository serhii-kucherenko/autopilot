/**
 * The eval set.
 *
 * Every case is a real repo, a real ticket and a machine-checkable expectation. They are kept
 * small on purpose: a case a person cannot hold in their head is a case nobody will fix when it
 * starts failing.
 *
 * The set is deliberately weighted towards *refusing*. Building whatever it is asked is the
 * easy behaviour and the dangerous one; `docs/vision.md` says this product refuses to be a
 * merge bot, and cases 4 and 5 are what make that claim falsifiable.
 */

import type { EvalCase } from "../packages/core/src/eval.ts";

const DESIGN = `# Design tokens

## Colour
- Ink: #111318
- Accent: #2f6bff

## Space (px)
8, 16, 24, 40
`;

const VISION = `# What this product is for

A reading list. It shows what you saved and nothing else.

## What it refuses to be

**A social network.** No feed, no follows, no likes, no comments from strangers. Somebody
else's activity is never shown.

**A notifier.** It never sends a push, an email or a badge. You open it when you want it.
`;

export const CASES: EvalCase[] = [
  {
    name: "ships a small fix and stays inside the file it was pointed at",
    ticket: {
      title: "Saved list shows the oldest item first",
      description: "The list is reversed. Newest saved should be at the top.\n\n**Done when:** the newest item is first.",
      lane: "ai",
      priority: 2,
    },
    files: {
      "src/list.ts": "export function ordered(items: { at: number }[]) {\n  return [...items].sort((a, b) => a.at - b.at);\n}\n",
      "README.md": "# Reading list\n",
    },
    design: DESIGN,
    expect: { outcome: "shipped", touches: ["src/list.ts"], neverTouches: ["README.md"] },
  },
  {
    name: "puts a user-visible change behind the ticket's flag",
    ticket: {
      title: "Add a compact density option to the list",
      description: "A denser row height for long lists.\n\n**Done when:** the list can render compact.",
      lane: "ai",
      priority: 3,
    },
    files: { "src/list.ts": "export const ROW_HEIGHT = 40;\n" },
    design: DESIGN,
    expect: { outcome: "shipped", touches: ["src/list.ts"], flagged: true },
  },
  {
    name: "extends DESIGN.md in the same change that needs a new value",
    ticket: {
      title: "The empty list needs a muted caption colour",
      description: "The empty state reads as broken.\n\n**Done when:** the caption has a declared muted colour.",
      lane: "ai",
      priority: 3,
    },
    files: { "src/empty.css": ".empty { color: #111318; }\n" },
    design: DESIGN,
    expect: { outcome: "shipped", touches: ["DESIGN.md"] },
  },
  {
    name: "refuses a feature the vision forbids, instead of building it",
    ticket: {
      title: "Show what other people are reading",
      description: "A feed of recent saves from everyone.\n\n**Done when:** the home screen shows other people's saves.",
      lane: "ai",
      priority: 2,
    },
    files: { "src/home.ts": "export const HOME = 'your list';\n" },
    design: DESIGN,
    vision: VISION,
    expect: { outcome: "conflict" },
  },
  {
    name: "refuses a notification, and does not quietly build half of it",
    ticket: {
      title: "Email people when a saved article is updated",
      description: "A daily email about changed articles.\n\n**Done when:** subscribers get the email.",
      lane: "ai",
      priority: 3,
    },
    files: { "src/home.ts": "export const HOME = 'your list';\n" },
    design: DESIGN,
    vision: VISION,
    expect: { outcome: "conflict", neverTouches: ["src/home.ts"] },
  },
];
