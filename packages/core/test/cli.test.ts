import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli, EXIT, writeStarterConfig } from "../src/cli.ts";
import { runDoctor, formatDoctorReport } from "../src/doctor.ts";
import { Store } from "../src/store.ts";
import { parseBundle } from "../src/bundle.ts";

/** Capture what the CLI writes, so the tests read the real user-facing output. */
function capture(): { out: () => string; err: () => string; restore: () => void } {
  let out = "";
  let err = "";
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => {
    out += chunk;
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    err += chunk;
    return true;
  }) as typeof process.stderr.write;
  return {
    out: () => out,
    err: () => err,
    restore: () => {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    },
  };
}

function workspace(): { root: string; configPath: string; storePath: string } {
  const root = mkdtempSync(join(tmpdir(), "ap-cli-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "loop@autopilot.test");
  git("config", "user.name", "Autopilot");
  git("config", "commit.gpgsign", "false");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "app.ts"), "export const x = 1;\n");
  writeFileSync(join(root, "DESIGN.md"), "# DESIGN\n\nInk is #111318. Spacing scale: 8px, 16px.\n");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");

  const configPath = join(root, "autopilot.config.json");
  writeStarterConfig(configPath, "Reco", root);
  return { root, configPath, storePath: join(root, ".autopilot") };
}

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const cap = capture();
  try {
    const code = await cli(args);
    return { code, out: cap.out(), err: cap.err() };
  } finally {
    cap.restore();
  }
}

test("no command prints usage and reports nothing to do", async () => {
  const { code, out } = await run([]);
  assert.equal(code, EXIT.nothing);
  assert.match(out, /one subcommand per stage|autopilot <command>/);
  assert.match(out, /Exit codes/);
});

test("every command in the usage text has a real branch", async () => {
  const { out } = await run(["help"]);
  for (const command of ["doctor", "drain", "triage", "say", "engineer", "loop", "audit", "digest", "release", "check-anchor"]) {
    assert.match(out, new RegExp(`\\b${command}\\b`), `${command} must be documented`);
  }
});

test("an unknown command fails and shows what does exist", async () => {
  const { code, err } = await run(["frobnicate"]);
  assert.equal(code, EXIT.failed);
  assert.match(err, /unknown command `frobnicate`/);
});

test("doctor with --fake needs no Linear key and says why", async () => {
  const { configPath } = workspace();
  const { out } = await run(["doctor", "--config", configPath, "--fake"]);
  assert.match(out, /LINEAR_API_KEY: not set, and not needed/);
  assert.match(out, /node: v/);
});

test("doctor names the fix for a missing Linear key, with the URL", () => {
  const before = process.env.LINEAR_API_KEY;
  delete process.env.LINEAR_API_KEY;
  try {
    const text = formatDoctorReport(runDoctor({}));
    assert.match(text, /linear\.app\/settings\/account\/security/);
    assert.match(text, /export LINEAR_API_KEY/);
    assert.match(text, /Not ready for a real product/);
    assert.match(text, /pnpm demo/, "a first-time reader must learn the demo needs none of this");
  } finally {
    if (before !== undefined) process.env.LINEAR_API_KEY = before;
  }
});

test("doctor rejects a config whose repo.root does not exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "ap-doc-"));
  const path = join(dir, "autopilot.config.json");
  writeStarterConfig(path, "Ghost", join(dir, "no-such-repo"));
  const report = runDoctor({ configPath: path, fake: true });
  const config = report.checks.find((c) => c.name === "autopilot.config.json")!;
  assert.equal(config.status, "missing");
  assert.match(config.detail, /does not exist/);
});

test("check-anchor is clean on a repo that keeps to its own DESIGN.md", async () => {
  const { root, configPath } = workspace();
  writeFileSync(join(root, "src", "ok.css"), ".x { color: #111318; padding: 16px; }\n");
  const { code, out } = await run(["check-anchor", "--config", configPath]);
  assert.equal(code, EXIT.did, out);
  assert.match(out, /Anchor clean/);
});

test("check-anchor fails on a raw hex and points at the line", async () => {
  const { root, configPath } = workspace();
  writeFileSync(join(root, "src", "bad.css"), ".x { color: #ff00aa; }\n");
  const { code, out } = await run(["check-anchor", "--config", configPath]);
  assert.equal(code, EXIT.failed);
  assert.match(out, /src\/bad\.css:1/);
  assert.match(out, /#ff00aa is not in DESIGN\.md/);
});

test("drain says nothing is waiting, with exit 2 rather than an error", async () => {
  const { configPath, storePath } = workspace();
  const { code, out } = await run(["drain", "--config", configPath, "--store", storePath, "--fake"]);
  assert.equal(code, EXIT.nothing);
  assert.match(out, /Nothing waiting in intake/);
});

test("drain lists what intake is holding, oldest first", async () => {
  const { configPath, storePath } = workspace();
  mkdirSync(storePath, { recursive: true });
  const store = new Store(storePath);
  for (const id of ["s2", "s1"]) {
    store.put(
      parseBundle({
        sessionID: id,
        app: { name: "Reco" },
        annotations: [{ id: `${id}-a`, comment: "stale results", trace: [] }],
      }),
      { receivedAt: id === "s1" ? "2026-08-01T00:00:00Z" : "2026-08-02T00:00:00Z" },
    );
  }
  store.close();

  const { code, out } = await run(["drain", "--config", configPath, "--store", storePath, "--fake"]);
  assert.equal(code, EXIT.did);
  assert.ok(out.indexOf("s1") < out.indexOf("s2"), "oldest first");
  assert.match(out, /1 annotation\b/);
  assert.match(out, /2 waiting/);
});

test("say with no text is refused rather than triaging an empty string", async () => {
  const { configPath, storePath } = workspace();
  const { code, err } = await run(["say", "--config", configPath, "--store", storePath, "--fake"]);
  assert.equal(code, EXIT.failed);
  assert.match(err, /needs something to say/);
});

test("engineer with no ticket id is refused", async () => {
  const { configPath, storePath } = workspace();
  const { code, err } = await run(["engineer", "--config", configPath, "--store", storePath, "--fake"]);
  assert.equal(code, EXIT.failed);
  assert.match(err, /needs a ticket id/);
});

test("release with no ticket id is refused", async () => {
  const { configPath, storePath } = workspace();
  const { code, err } = await run(["release", "--config", configPath, "--store", storePath, "--fake"]);
  assert.equal(code, EXIT.failed);
  assert.match(err, /needs a ticket id/);
});

test("release refuses an unapproved ticket through the CLI too", async () => {
  const { root, configPath, storePath } = workspace();
  const { code, err } = await run(["release", "AP-1", "--config", configPath, "--store", storePath, "--fake"]);
  assert.equal(code, EXIT.failed);
  assert.match(err, /never shipped to staging|no production approval|no environments\.production/);
  assert.equal(existsSync(join(root, "PRODUCTION_RELEASED")), false);
});

test("digest --plain is silent on a quiet day, with exit 2", async () => {
  const { configPath, storePath } = workspace();
  const { code, out } = await run(["digest", "--plain", "--config", configPath, "--store", storePath, "--fake"]);
  assert.equal(code, EXIT.nothing);
  assert.match(out, /Silence is correct/);
});

test("digest --plain reports what landed, without a model call", async () => {
  const { configPath, storePath } = workspace();
  mkdirSync(storePath, { recursive: true });
  const store = new Store(storePath);
  store.recordRun({ ticketId: "AP-1", commitSHA: "aaa", branch: "auto/ap-1", flag: "flag_ap_1", summary: "Search ranks by recency" });
  store.close();

  const { code, out } = await run(["digest", "--plain", "--config", configPath, "--store", storePath, "--fake"]);
  assert.equal(code, EXIT.did);
  assert.match(out, /Search ranks by recency/);
});

test("a bad config is reported with the field, not a stack trace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ap-cli-bad-"));
  const path = join(dir, "autopilot.config.json");
  writeFileSync(path, JSON.stringify({ product: { name: "X" } }));
  const { code, err } = await run(["drain", "--config", path, "--fake"]);
  assert.equal(code, EXIT.failed);
  assert.match(err, /is invalid/);
  assert.equal(err.includes("    at "), false, "no stack trace in a user-facing error");
});

test("--cycles must be a whole number", async () => {
  const { configPath, storePath } = workspace();
  const { code, err } = await run(["loop", "--cycles", "zero", "--config", configPath, "--store", storePath, "--fake"]);
  assert.equal(code, EXIT.failed);
  assert.match(err, /whole number/);
});

test("the starter config it writes is valid against the schema", () => {
  const dir = mkdtempSync(join(tmpdir(), "ap-starter-"));
  const path = join(dir, "autopilot.config.json");
  writeStarterConfig(path, "Reco", dir);
  const report = runDoctor({ configPath: path, fake: true });
  assert.equal(report.checks.find((c) => c.name === "autopilot.config.json")!.status, "ok");
});

test("check-anchor exits 0 when clean, because a checker passes or it does not", async () => {
  const { root, configPath } = workspace();
  writeFileSync(join(root, "src", "ok.css"), ".x { color: #111318; padding: 16px; }\n");
  const clean = await run(["check-anchor", "--config", configPath]);
  assert.equal(clean.code, EXIT.did, clean.out);

  writeFileSync(join(root, "src", "bad.css"), ".x { color: #ff00aa; }\n");
  assert.equal((await run(["check-anchor", "--config", configPath])).code, EXIT.failed);
});

/*
 * The three defects a rehearsal against a real product found.
 *
 * SER-625's runbook told a reader to rehearse with `loop --dry-run` before deciding whether
 * to let a coding agent touch a product they use daily. Running exactly that against Reco
 * printed one line and no prompt, exited 1 as though it had failed, and said nothing about
 * the two anchor files Reco does not have - while the prompt it built told the agent to go
 * read them. All three are the same failure: the rehearsal answered none of the questions a
 * person rehearses to answer.
 */

test("engineer --dry-run reports nothing-to-do, because a rehearsal that worked is not a failure", async () => {
  const { root, configPath, storePath } = workspace();
  const tickets = join(storePath, "tickets.json");
  mkdirSync(storePath, { recursive: true });
  writeFileSync(
    tickets,
    JSON.stringify({
      nextNumber: 2,
      tickets: [
        {
          id: "AP-1",
          title: "The library grid loses its scroll position",
          description: "Done when: returning from a reader restores the row.",
          lane: "ai",
          priority: 2,
          state: "Backlog",
          stateType: "backlog",
          labels: ["lane:ai"],
          blockedBy: [],
        },
      ],
      comments: {},
    }),
  );

  const { code, out } = await run([
    "engineer", "AP-1", "--config", configPath, "--store", storePath, "--dry-run", "--fake",
  ]);
  assert.equal(code, EXIT.nothing, `a dry run must not exit failed. Output:\n${out}`);
  assert.match(out, /Prompt: The Engineer/, "the rehearsal must show the prompt");
  assert.ok(existsSync(root));
});

test("loop --dry-run prints the prompt, because that is the whole point of rehearsing", async () => {
  const { configPath, storePath } = workspace();
  mkdirSync(storePath, { recursive: true });
  writeFileSync(
    join(storePath, "tickets.json"),
    JSON.stringify({
      nextNumber: 2,
      tickets: [
        {
          id: "AP-1",
          title: "The library grid loses its scroll position",
          description: "Done when: returning from a reader restores the row.",
          lane: "ai",
          priority: 2,
          state: "Backlog",
          stateType: "backlog",
          labels: ["lane:ai"],
          blockedBy: [],
        },
      ],
      comments: {},
    }),
  );

  const { code, out } = await run([
    "loop", "--config", configPath, "--store", storePath, "--dry-run", "--fake",
  ]);
  assert.match(out, /Prompt: The Engineer/, "a dry run that shows no prompt informs no decision");
  assert.match(out, /AP-1/, "and it must still say which ticket it rehearsed");
  assert.equal(code, EXIT.nothing, `a rehearsal did not fail. Output:\n${out.slice(0, 400)}`);
});

test("doctor names each anchor file the product does not have, because the prompt sends the agent to read them", async () => {
  const { root, configPath } = workspace();
  // The workspace has DESIGN.md and none of the other three - Reco exactly.
  const report = runDoctor({ configPath, fake: true });
  const anchor = report.checks.find((c) => c.name === "anchor")!;
  assert.ok(anchor, "doctor must check the anchor at all");
  assert.equal(anchor.status, "warn", "the loop still runs; it just has less to push against");
  assert.match(anchor.detail, /docs\/adr\//);
  assert.match(anchor.detail, /docs\/vision\.md/);
  assert.match(anchor.detail, /CONTEXT\.md/, "the glossary is anchored too (ADR 0010)");
  assert.doesNotMatch(anchor.detail, /DESIGN\.md/, "what exists is not a finding");

  mkdirSync(join(root, "docs", "adr"), { recursive: true });
  writeFileSync(join(root, "docs", "adr", "0001-x.md"), "# 0001\n");
  writeFileSync(join(root, "docs", "vision.md"), "Reco is for reading.\n");
  writeFileSync(join(root, "CONTEXT.md"), "# Reco\n\n## Language\n\n**Shelf**:\nA row of books.\n");
  const full = runDoctor({ configPath, fake: true }).checks.find((c) => c.name === "anchor")!;
  assert.equal(full.status, "ok");
});
