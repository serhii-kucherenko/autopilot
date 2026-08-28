/**
 * `pnpm demo` - one full cycle, offline, seeded, both roles.
 *
 * This is the MVP gate: a click-through with realistic data, walking the loop's path and the
 * human's. Nothing here is a mock of the system. It runs the real triage runner, the real
 * engineer runner, the real quality gate, the real git merge and the real store, against a
 * throwaway product repo. Only two things are fakes, and both are the ones ADR 0005 and
 * ADR 0002 already provide: `FakeAgent` in place of the Claude Code CLI, and `FileTracker` in
 * place of Linear. So it needs no credential, no network and no model call.
 *
 * What it proves, in order:
 *   the loop     a bundle arrives → triage files two tickets → the engineer ships one to
 *                staging behind a flag, with the gate passing
 *   the human    the digest has something in it, a crop and a trace are readable, and the
 *                production press is available and refuses to be anything else
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  FakeAgent,
  FileTracker,
  Store,
  parseBundle,
  parseConfig,
  runEngineer,
  runTriage,
  pickNext,
  runRelease,
  type Config,
  type FakeStep,
} from "@autopilot/core";

const HERE = resolve(import.meta.dirname, "..");
const STORE_ROOT = join(HERE, ".autopilot");
const PRODUCT_ROOT = join(STORE_ROOT, "demo-product");

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

function step(n: number, of: number, line: string): void {
  say(`\n[${n}/${of}] ${line}`);
}

/** A throwaway product repo with a real ranking bug in it, so the fix is a real diff. */
function buildProductRepo(): void {
  rmSync(PRODUCT_ROOT, { recursive: true, force: true });
  mkdirSync(join(PRODUCT_ROOT, "src"), { recursive: true });
  mkdirSync(join(PRODUCT_ROOT, "docs", "adr"), { recursive: true });

  writeFileSync(
    join(PRODUCT_ROOT, "DESIGN.md"),
    [
      "# DESIGN.md — Nimbus",
      "",
      "## Colour",
      "`--ink` is oklch(24% 0.02 258). `--accent` is oklch(58% 0.2 256).",
      "",
      "## Spacing",
      "The scale is 8px, 16px, 24px.",
      "",
    ].join("\n"),
  );

  writeFileSync(
    join(PRODUCT_ROOT, "docs", "vision.md"),
    [
      "# Nimbus",
      "",
      "A reading library. It refuses to become a social network: no feeds, no follows,",
      "no counts of anything a person did not ask to be counted.",
      "",
    ].join("\n"),
  );

  writeFileSync(
    join(PRODUCT_ROOT, "docs", "adr", "0001-recency-over-relevance.md"),
    [
      "# 0001 — Search ranks by recency, not by a relevance score",
      "",
      "**Status:** accepted",
      "",
      "A library is something a person has read. Recency is the ordering they can predict;",
      "a relevance score is one they cannot. Ranking is stable and explainable, always.",
      "",
    ].join("\n"),
  );

  // The bug: results come back in insertion order, so an edit never moves an item.
  writeFileSync(
    join(PRODUCT_ROOT, "src", "search.ts"),
    [
      "export interface Item {",
      "  title: string;",
      "  updatedAt: string;",
      "}",
      "",
      "export function rank(items: Item[]): Item[] {",
      "  return items;",
      "}",
      "",
    ].join("\n"),
  );

  writeFileSync(
    join(PRODUCT_ROOT, "src", "search.test.ts"),
    [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'import { rank } from "./search.ts";',
      "",
      'test("the newest item comes first", () => {',
      "  const items = [",
      '    { title: "old", updatedAt: "2026-01-01T00:00:00Z" },',
      '    { title: "new", updatedAt: "2026-08-01T00:00:00Z" },',
      "  ];",
      '  assert.equal(rank(items)[0]!.title, "new");',
      "});",
      "",
    ].join("\n"),
  );

  const git = (...args: string[]) => execFileSync("git", args, { cwd: PRODUCT_ROOT, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "loop@autopilot.local");
  git("config", "user.name", "Autopilot");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "Nimbus, with a ranking bug");
}

const CONFIG_PATH = join(HERE, "autopilot.config.json");
const ENV_PATH = join(HERE, ".env.local");

/**
 * Written to disk as well as held in memory, because the console reads
 * `autopilot.config.json` from its own directory. Without the file it falls back to "no
 * product configured", which is honest but is not the demo.
 */
function demoConfig(): Config {
  return parseConfig({
    product: { name: "Nimbus", vision: "docs/vision.md", anchors: ["DESIGN.md", "docs/adr/", "docs/vision.md"] },
    tracker: { kind: "linear", project: "Nimbus" },
    repo: { root: PRODUCT_ROOT, defaultBranch: "main", branchPrefix: "auto/" },
    environments: {
      // No `url`: this demo product has nowhere to actually preview, and a link pointing
      // back at the console would be a fake preview - the one thing a digest must not carry.
      staging: { deploy: "echo staged > STAGED" },
      // Present, and never reached: the engineer runner does not read this block at all.
      production: { deploy: "echo released > RELEASED" },
    },
    gate: {
      // A real gate. The failing test in the repo is what the engineer has to make pass.
      commands: ["node --experimental-strip-types --test src/search.test.ts"],
      featureFlags: { required: true, defaultState: "off" },
    },
    capture: { loupe: { enabled: true }, conversational: true },
    boundaries: {
      protectedPaths: ["docs/adr/", "**/.env*"],
      forbiddenCommands: ["git push --force", "rm -rf"],
      maxTicketsInFlight: 1,
    },
    cadence: { engineerInterval: "30m", digest: "daily 08:00", selfAuditOnEmptyBacklog: true },
  });
}

/** A 1x1 PNG. Small on purpose: the demo ships a real image file, not a promise of one. */
const CROP_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** A second tray, left un-acked on purpose so the Inbox screen has something in it. */
function untriagedBundle() {
  return parseBundle({
    sessionID: "8f14e45f-ea6d-4b1c-9f2a-000000000002",
    app: { name: "Nimbus", platform: "iOS", version: "1.4.2", environment: "staging", commitSHA: "a1b2c3d" },
    sentAt: new Date().toISOString(),
    annotations: [
      {
        id: "8f14e45f-ea6d-4b1c-9f2a-0000000000b1",
        comment: "saving a note from the share sheet does nothing at all",
        tag: "bug",
        screen: "Share",
        capturedAt: new Date().toISOString(),
        screenshotPNG: CROP_PNG,
        element: { accessibilityID: "share-save", label: "Save", className: "PrimaryButton" },
        trace: [
          { method: "POST", url: "https://api.nimbus.app/v1/items", statusCode: 500, durationMs: 812 },
        ],
        console: [{ level: "error", message: "POST /v1/items failed: 500" }],
      },
    ],
  });
}

function seedBundle() {
  return parseBundle({
    sessionID: "8f14e45f-ea6d-4b1c-9f2a-000000000001",
    app: { name: "Nimbus", platform: "iPadOS", version: "1.4.2", environment: "staging", commitSHA: "a1b2c3d" },
    sentAt: new Date().toISOString(),
    annotations: [
      {
        id: "8f14e45f-ea6d-4b1c-9f2a-0000000000a1",
        comment: "I edited this note an hour ago and it is still at the bottom of search",
        tag: "bug",
        screen: "Library",
        capturedAt: new Date().toISOString(),
        screenshotPNG: CROP_PNG,
        element: {
          accessibilityID: "search-results-list",
          label: "Search results",
          className: "ResultsList",
          bounds: { x: 16, y: 220, width: 704, height: 480 },
        },
        trace: [
          { method: "GET", url: "https://api.nimbus.app/v1/search?q=weather", statusCode: 200, durationMs: 91 },
          { method: "GET", url: "https://api.nimbus.app/v1/items?limit=50", statusCode: 200, durationMs: 44 },
        ],
        console: [],
      },
      {
        id: "8f14e45f-ea6d-4b1c-9f2a-0000000000a2",
        comment: "and when there are no results the screen is just blank, it should offer something",
        tag: "polish",
        screen: "Library",
        capturedAt: new Date().toISOString(),
        screenshotPNG: CROP_PNG,
        element: { accessibilityID: "empty-state", label: "No results", className: "EmptyState" },
        trace: [],
        console: [{ level: "warn", message: "EmptyState rendered with no action" }],
      },
    ],
  });
}

/** What triage would answer. Two annotations, two problems, two lanes. */
const TRIAGE_REPLY = `Read both crops. The first is a ranking bug the trace pins to
\`GET /v1/search\`; ADR 0001 already says ranking is by recency, so this is a defect, not a
question. The second is a missing next action on an empty state - that is product direction,
so it goes to the human lane.

\`\`\`json
{
  "tickets": [
    {
      "title": "Search results ignore how recently something was edited",
      "lane": "ai",
      "priority": 1,
      "context": "GET /v1/search?q= -> src/search.ts rank() -> returns items in insertion order. docs/adr/0001 requires recency ordering. src/search.test.ts already asserts it and fails.",
      "evidence": "trace pinned GET https://api.nimbus.app/v1/search?q=weather 200 in 91ms; build a1b2c3d; crop shows the results list with the edited note last",
      "theirWords": "I edited this note an hour ago and it is still at the bottom of search",
      "doneWhen": "the most recently edited item is first in search results, and src/search.test.ts passes",
      "fromAnnotations": ["8f14e45f-ea6d-4b1c-9f2a-0000000000a1"],
      "labels": ["bug"]
    },
    {
      "title": "An empty search offers nothing to do next",
      "lane": "human",
      "priority": 3,
      "context": "EmptyState renders with no action; console warns 'EmptyState rendered with no action'. What the action should be is a product decision, not a defect.",
      "evidence": "crop shows a blank results area; console warn on render; no network call fired",
      "theirWords": "and when there are no results the screen is just blank, it should offer something",
      "doneWhen": "the empty state offers exactly one action, and the vision doc says which",
      "fromAnnotations": ["8f14e45f-ea6d-4b1c-9f2a-0000000000a2"]
    }
  ]
}
\`\`\``;

/** What the engineer would do: read the anchor, fix it behind the flag, make the test pass. */
function engineerReply(flag: string): FakeStep {
  return {
    text: `Read DESIGN.md, docs/adr/0001 and docs/vision.md first. ADR 0001 settles the
ordering, so there is no decision to make here - only a fix. Sorted by \`updatedAt\`
descending behind \`${flag}\`, and the existing failing test is the check.

\`\`\`json
{
  "outcome": "shipped",
  "summary": "Search puts the most recently edited item first",
  "unsure": "two items edited in the same second keep their insertion order. ADR 0001 asks for stable ranking, so that is deliberate, but worth an eye."
}
\`\`\``,
    effect: (cwd) => {
      writeFileSync(
        join(cwd, "src", "search.ts"),
        [
          "export interface Item {",
          "  title: string;",
          "  updatedAt: string;",
          "}",
          "",
          "/**",
          " * docs/adr/0001: ranking is by recency, because that is the ordering a person can",
          " * predict. Equal timestamps keep their insertion order, so the sort stays stable.",
          " */",
          `const ${flag} = true;`,
          "",
          "export function rank(items: Item[]): Item[] {",
          `  if (!${flag}) return items;`,
          "  return items",
          "    .map((item, index) => ({ item, index }))",
          "    .sort((a, b) => b.item.updatedAt.localeCompare(a.item.updatedAt) || a.index - b.index)",
          "    .map(({ item }) => item);",
          "}",
          "",
        ].join("\n"),
      );
    },
  };
}

async function main(): Promise<number> {
  const total = 6;
  say("Autopilot demo — one full cycle, offline. No credential, no network, no model call.");
  say("Fakes: the Claude Code CLI (ADR 0002) and Linear (ADR 0005). Everything else is real.");

  step(1, total, "Building a throwaway product repo with a real ranking bug");
  rmSync(STORE_ROOT, { recursive: true, force: true });
  mkdirSync(STORE_ROOT, { recursive: true });
  buildProductRepo();
  say(`      ${PRODUCT_ROOT}`);
  say("      src/search.test.ts asserts recency ordering and currently fails.");

  const config = demoConfig();
  writeFileSync(
    CONFIG_PATH,
    `${JSON.stringify(
      {
        $schema: "../../schema/autopilot.config.schema.json",
        product: { name: config.product.name, vision: config.product.vision, anchors: config.product.anchors },
        tracker: { kind: "linear", project: config.tracker.project },
        repo: config.repo,
        environments: config.environments,
        gate: config.gate,
        capture: config.capture,
        boundaries: config.boundaries,
        cadence: config.cadence,
      },
      null,
      2,
    )}\n`,
  );
  say(`      wrote ${CONFIG_PATH}`);

  /*
   * The console's writes are fail-closed on `AUTOPILOT_CONSOLE_TOKEN`, so without one the
   * production press would refuse and the demo would stop half a step short. Next reads
   * `.env.local` on its own, which makes `pnpm console` work straight after this with nothing
   * to export by hand. A fresh secret each run, and the file is gitignored.
   */
  writeFileSync(
    ENV_PATH,
    [
      "# Written by `pnpm demo`. Gitignored, and regenerated on every run.",
      "# The console's writes are fail-closed on this; see SECURITY.md - it is a gate, not",
      "# user authentication, and the console must not face the public internet.",
      `AUTOPILOT_CONSOLE_TOKEN=${randomBytes(24).toString("hex")}`,
      "AUTOPILOT_FAKE=1",
      "",
    ].join("\n"),
  );
  say(`      wrote ${ENV_PATH} with a fresh console token`);

  const store = new Store(STORE_ROOT);
  const tracker = new FileTracker(join(STORE_ROOT, "tickets.json"));

  try {
    step(2, total, "A bundle arrives from the iPad — two annotations, one session");
    const put = store.put(seedBundle());
    say(`      stored ${put.id}, created=${put.created}`);
    say(`      uploading it again: created=${store.put(seedBundle()).created} (the id makes retry free)`);

    step(3, total, "Triage turns them into tickets — not one per annotation");
    const triage = await runTriage({
      config,
      tracker,
      agent: new FakeAgent([TRIAGE_REPLY]),
      input: { bundles: [store.undrained()[0]!.bundle] },
    });
    for (const ticket of triage.created) {
      say(`      ${ticket.id}  [${ticket.lane}, p${ticket.priority}]  ${ticket.title}`);
    }
    // The ack comes after the tickets exist, never before.
    store.ack(seedBundle().sessionID);
    say("      bundle acked, because the tickets now exist");

    // A second tray arrives while the first is being worked, which is the normal case and
    // means the Inbox screen has real content rather than an empty state on first open.
    store.put(untriagedBundle());
    say("      a second tray arrived and is still waiting: a 500 on POST /v1/items");

    step(4, total, "The engineer takes the top unblocked ticket, end to end");
    const next = pickNext(await tracker.listOpen());
    if (!next) throw new Error("the demo produced no workable ticket");
    say(`      picked ${next.id} (urgent before medium)`);

    const flag = `flag_${next.id.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
    const outcome = await runEngineer({
      config,
      tracker,
      store,
      agent: new FakeAgent([engineerReply(flag)]),
      ticket: next,
    });

    say(`      ${outcome.status}: ${outcome.summary}`);
    if (outcome.status !== "shipped") {
      say(`\n${outcome.detail}`);
      return 1;
    }
    say(`      the gate really ran: ${config.gate.commands[0]}`);
    say(`      merged behind ${outcome.flag} at ${outcome.commitSHA?.slice(0, 7)}`);
    say(`      staging deployed: ${existsSync(join(PRODUCT_ROOT, "STAGED")) ? "yes" : "no"}`);
    say(
      `      production deployed: ${existsSync(join(PRODUCT_ROOT, "RELEASED")) ? "YES — BUG" : "no, and it never can be"}`,
    );

    step(5, total, "The human's turn: production refuses without a press");
    const refused = await runRelease({ config, store, ticketId: next.id });
    say(`      autopilot release ${next.id} → ${refused.status}`);
    say(`      ${refused.message}`);

    step(6, total, "Open the console and walk it");
    say("      pnpm console        then open http://localhost:4317");
    say("");
    say("      As the loop:   Inbox has the acked bundle's crops and traces");
    say("      As the human:  Digest has the staged change and its press;");
    say("                     Backlog shows what is next and what is yours;");
    say("                     press production, then run the release command it prints.");
    say("");
    say(`      state: ${STORE_ROOT}`);
    return 0;
  } finally {
    store.close();
  }
}

process.exitCode = await main();
