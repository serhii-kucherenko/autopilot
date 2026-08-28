import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli, EXIT, writeStarterConfig } from "../src/cli.ts";
import { runDoctor, formatDoctorReport } from "../src/doctor.ts";
import { forgetRepoRoot } from "../src/paths.ts";
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
  /*
   * Stated, not inherited. The CLI loads the checkout's own `.env` on every call, so on a
   * machine that has a real key this test would otherwise assert the opposite of its name -
   * and deleting the variable first does not help, because `cli()` puts it straight back.
   * Pointing AUTOPILOT_HOME at a checkout with no `.env` is what actually controls it.
   */
  const emptyHome = mkdtempSync(join(tmpdir(), "ap-nokey-"));
  mkdirSync(join(emptyHome, "prompts"), { recursive: true });
  mkdirSync(join(emptyHome, "schema"), { recursive: true });
  const priorHome = process.env.AUTOPILOT_HOME;
  const prior = process.env.LINEAR_API_KEY;
  process.env.AUTOPILOT_HOME = emptyHome;
  delete process.env.LINEAR_API_KEY;
  forgetRepoRoot();
  try {
    const { out } = await run(["doctor", "--config", configPath, "--fake"]);
    assert.match(out, /LINEAR_API_KEY: not set, and not needed/);
    assert.match(out, /node: v/);
  } finally {
    if (prior === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = prior;
    if (priorHome === undefined) delete process.env.AUTOPILOT_HOME;
    else process.env.AUTOPILOT_HOME = priorHome;
    forgetRepoRoot();
  }
});

test("doctor names the fix for a missing Linear key, with the URL", async () => {
  const before = process.env.LINEAR_API_KEY;
  delete process.env.LINEAR_API_KEY;
  try {
    const text = formatDoctorReport(await runDoctor({}));
    assert.match(text, /linear\.app\/settings\/account\/security/);
    assert.match(text, /export LINEAR_API_KEY/);
    assert.match(text, /Not ready for a real product/);
    assert.match(text, /pnpm demo/, "a first-time reader must learn the demo needs none of this");
  } finally {
    if (before !== undefined) process.env.LINEAR_API_KEY = before;
  }
});

test("doctor rejects a config whose repo.root does not exist", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ap-doc-"));
  const path = join(dir, "autopilot.config.json");
  writeStarterConfig(path, "Ghost", join(dir, "no-such-repo"));
  const report = await runDoctor({ configPath: path, fake: true });
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

test("the starter config it writes is valid against the schema", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ap-starter-"));
  const path = join(dir, "autopilot.config.json");
  writeStarterConfig(path, "Reco", dir);
  const report = await runDoctor({ configPath: path, fake: true });
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
  const report = await runDoctor({ configPath, fake: true });
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
  const full = (await runDoctor({ configPath, fake: true })).checks.find((c) => c.name === "anchor")!;
  assert.equal(full.status, "ok");
});

/*
 * `wake` - the one command a scheduler calls.
 *
 * `integrations/README.md` has had a Scheduler box in its diagram since the first commit and
 * the folder has only ever held a README. Nothing shipped wakes the loop, which makes
 * "keeps working between your touches" the one claim in the README that no code backs.
 *
 * A scheduler wants one command, one exit code and no shell glue. `loop` then `digest` is two
 * of each, so every person wiring this up would write the same wrapper script and get the
 * exit code wrong in the same way.
 */

function seedTicket(storePath: string): void {
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
}

test("wake is one command a cron line can call, and it reports nothing-to-do on an empty backlog", async () => {
  const { configPath, storePath } = workspace();
  const { code, out } = await run(["wake", "--config", configPath, "--store", storePath, "--fake", "--plain"]);
  assert.equal(code, EXIT.nothing, `an idle wake is not a failure. Output:\n${out}`);
  assert.match(out, /idle|nothing|empty/i, "it must say why it did nothing");
});

test("wake runs the cycle and the digest in one process, so a scheduler needs no wrapper script", async () => {
  const { configPath, storePath } = workspace();
  seedTicket(storePath);
  const { out } = await run(["wake", "--config", configPath, "--store", storePath, "--fake", "--plain", "--dry-run"]);
  assert.match(out, /AP-1/, "the cycle ran");
  assert.match(out, /digest|Nothing landed/i, "and the digest ran in the same command");
});

test("wake is documented, because an undocumented entry point is one nobody wires up", async () => {
  const { out } = await run(["help"]);
  assert.match(out, /\bwake\b/);
});

/*
 * `check-anchor`'s exclude list is its own, not the agent's.
 *
 * It used to reuse `boundaries.protectedPaths`, on the reasoning that out of bounds for the
 * loop is out of scope for the check. That held only while protectedPaths listed secrets and
 * build output. The moment self-hosting protected first-party source - the gate, the runner,
 * the prompts - the checker silently stopped scanning them: 44 files became 40 with no
 * mention of it. Protecting a file from the agent says nothing about whether it uses a colour
 * DESIGN.md never declared.
 *
 * A replacement `anchorCheck.exclude` field was written and then deleted: every tree it would
 * have skipped is either already in the check's own SKIPPED_DIRECTORIES or does not exist in
 * the repo that named it. A config field with no user is one more way for a checker to go
 * quiet, which is the failure this test is about.
 */
test("protecting source from the agent does not remove it from the anchor check", async () => {
  const { root, configPath } = workspace();
  writeFileSync(join(root, "src", "guarded.css"), ".x { color: #ff00ff; }\n");

  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    boundaries: { protectedPaths: string[] };
  };
  config.boundaries.protectedPaths = [...config.boundaries.protectedPaths, "src/guarded.css"];
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const { code, out } = await run(["check-anchor", "--config", configPath]);
  assert.equal(code, EXIT.failed, `an undeclared colour must still be found. Output:\n${out}`);
  assert.match(out, /guarded\.css/, "the file the agent may not edit is still checked");
});


/*
 * `.env` in the Autopilot checkout is read, because that is where people put a key.
 *
 * Serhii added `LINEAR_API_KEY` to `repo/.env` - the obvious place, already gitignored - and
 * `doctor` still said `not set`, because nothing loaded the file. Telling a person their
 * correct instinct was wrong is worse than reading the file.
 *
 * A real environment variable still wins, which is what `process.loadEnvFile` does natively,
 * so a plist or an exported value overrides a stale file rather than the other way round.
 */
test("a key in the checkout's .env is picked up, and a real env var still beats it", async () => {
  const home = mkdtempSync(join(tmpdir(), "ap-home-"));
  mkdirSync(join(home, "prompts"), { recursive: true });
  mkdirSync(join(home, "schema"), { recursive: true });
  writeFileSync(join(home, ".env"), "AUTOPILOT_ENV_PROBE=from_the_file\n");

  const priorHome = process.env.AUTOPILOT_HOME;
  const priorProbe = process.env.AUTOPILOT_ENV_PROBE;
  process.env.AUTOPILOT_HOME = home;
  delete process.env.AUTOPILOT_ENV_PROBE;
  forgetRepoRoot();
  try {
    await run(["help"]);
    assert.equal(process.env.AUTOPILOT_ENV_PROBE, "from_the_file", "the checkout's .env must be read");

    process.env.AUTOPILOT_ENV_PROBE = "from_the_real_environment";
    forgetRepoRoot();
    await run(["help"]);
    assert.equal(
      process.env.AUTOPILOT_ENV_PROBE,
      "from_the_real_environment",
      "an exported value or a plist entry must win over a stale file",
    );
  } finally {
    if (priorHome === undefined) delete process.env.AUTOPILOT_HOME;
    else process.env.AUTOPILOT_HOME = priorHome;
    if (priorProbe === undefined) delete process.env.AUTOPILOT_ENV_PROBE;
    else process.env.AUTOPILOT_ENV_PROBE = priorProbe;
    forgetRepoRoot();
  }
});

test("a checkout with no .env is not an error", async () => {
  const home = mkdtempSync(join(tmpdir(), "ap-home-"));
  mkdirSync(join(home, "prompts"), { recursive: true });
  mkdirSync(join(home, "schema"), { recursive: true });
  const prior = process.env.AUTOPILOT_HOME;
  process.env.AUTOPILOT_HOME = home;
  forgetRepoRoot();
  try {
    const { code } = await run(["help"]);
    assert.equal(code, EXIT.did, "a missing .env is the normal case, not a failure");
  } finally {
    if (prior === undefined) delete process.env.AUTOPILOT_HOME;
    else process.env.AUTOPILOT_HOME = prior;
    forgetRepoRoot();
  }
});

/*
 * `doctor` must say whether the key WORKS, not whether the variable exists.
 *
 * A key was added to `.env`, doctor said `set`, and proving it actually reached Linear needed
 * a hand-written probe. A typo'd or revoked key passes an existence check and then fails on a
 * schedule at 3am with nobody watching, which is the exact situation doctor exists to prevent.
 *
 * The probe is injected so the suite stays offline. That property is stated in the README and
 * is worth more than the convenience of a real call in a test.
 */
test("doctor reports a key that is present but rejected, rather than calling it ok", async () => {
  const { configPath } = workspace();
  const report = await runDoctor({
    configPath,
    apiKey: "lin_api_wrong",
    probeTracker: () => Promise.resolve({ ok: false, detail: "Linear rejected the key (401)" }),
  });
  const check = report.checks.find((c) => c.name === "LINEAR_API_KEY")!;
  assert.equal(check.status, "missing", "a rejected key is not a working setup");
  assert.match(check.detail, /rejected/i);
  assert.equal(report.ready, false);
});

test("doctor says the key reached the tracker when it did, and names the project", async () => {
  const { configPath } = workspace();
  const report = await runDoctor({
    configPath,
    apiKey: "lin_api_right",
    probeTracker: () => Promise.resolve({ ok: true, detail: "reached Linear, 1 open ticket in Reco" }),
  });
  const check = report.checks.find((c) => c.name === "LINEAR_API_KEY")!;
  assert.equal(check.status, "ok");
  assert.match(check.detail, /reached Linear/);
});

test("doctor does not fail a setup just because the network is down", async () => {
  const { configPath } = workspace();
  const report = await runDoctor({
    configPath,
    apiKey: "lin_api_right",
    probeTracker: () => Promise.reject(new Error("getaddrinfo ENOTFOUND api.linear.app")),
  });
  const check = report.checks.find((c) => c.name === "LINEAR_API_KEY")!;
  assert.equal(check.status, "warn", "unreachable is not the same as wrong");
  assert.match(check.detail, /could not be checked|ENOTFOUND/i);
  assert.equal(report.ready, true, "a warn must not block");
});
