#!/usr/bin/env node
/**
 * `autopilot` - one subcommand per stage of `docs/flow.md`.
 *
 * Three rules the whole CLI keeps:
 * - **`--dry-run` on everything that writes.** An autonomous loop nobody can rehearse is
 *   not a loop anybody will turn on.
 * - **`--fake` runs the entire thing offline**, with the file tracker and the scripted
 *   agent. No credential, no network, no model call.
 * - **Exit codes are the interface for a scheduler**: 0 did work, 2 nothing to do, 1 failed.
 */

import { parseArgs } from "node:util";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { repoRoot } from "./paths.ts";
import { loadConfig, type Config } from "./config.ts";
import { ClaudeCodeAgent, FakeAgent, type AgentRunner } from "./agent.ts";
import { FileTracker, LinearTracker, trackerFor, type Tracker } from "./tracker.ts";
import { Store, defaultStoreRoot } from "./store.ts";
import { readBundleDir, listBundleDirs, parseBundleJSON, type Bundle } from "./bundle.ts";
import { runTriage } from "./triage.ts";
import { runEngineer } from "./engineer.ts";
import { runSelfAudit } from "./selfaudit.ts";
import { runDigest, plainDigest, coherenceOf } from "./digest.ts";
import { runRelease } from "./release.ts";
import { runLoop } from "./loop.ts";
import { checkAnchor, formatAnchorReport } from "./anchor.ts";
import { runDoctor, formatDoctorReport, type TrackerProbe } from "./doctor.ts";

export const EXIT = { did: 0, failed: 1, nothing: 2 } as const;

/**
 * Every command, checked before the config is loaded. Without this an unknown command
 * reports "no config at ./autopilot.config.json", which sends someone looking for a config
 * problem when what they actually have is a typo.
 */
const COMMANDS = new Set([
  "doctor",
  "drain",
  "triage",
  "say",
  "engineer",
  "loop",
  "wake",
  "audit",
  "digest",
  "release",
  "check-anchor",
  "prune",
]);

const USAGE = `autopilot - an engineering org where the AI builds and the human reviews

  autopilot <command> [options]

Commands
  doctor                 check everything the loop needs, and say how to fix what is missing
  drain                  pull undrained bundles out of intake, oldest first
  triage [dir]           turn a Loupe bundle into tickets. Reads a session directory
  say "<text>"           conversational capture: the same triage, from a sentence
  engineer <ticket>      run one ticket end to end, to staging behind a flag
  loop                   the continuity engine: next unblocked ticket, self-audit when empty
  wake                   one cycle then the digest. The single command a scheduler calls
  audit                  run the self-audit now, without waiting for an empty backlog
  digest                 write the digest of what landed on staging
  release <ticket>       deploy production. Refuses without a human approval for this commit
  check-anchor           find values the code uses that DESIGN.md never declared
  prune                  delete acked bundles and their screenshots past the retention window

Options
  --config <path>        autopilot.config.json for the product        (default ./autopilot.config.json)
  --store <path>         where intake keeps bundles and approvals     (default ./.autopilot)
  --dry-run              do everything except write
  --fake                 file tracker and scripted agent: fully offline
  --plain                digest without a model call
  --cycles <n>           how many loop cycles to run                  (default 1)
  --help

Exit codes
  0  did work        2  nothing to do        1  failed
  check-anchor is the exception: 0 clean, 1 violations. A checker passes or it does not.
`;

interface Options {
  config?: string;
  store?: string;
  "dry-run"?: boolean;
  fake?: boolean;
  plain?: boolean;
  cycles?: string;
  help?: boolean;
}

function configPathFrom(options: Options): string {
  return resolve(options.config ?? "autopilot.config.json");
}

function storeFrom(options: Options): Store {
  const root = resolve(options.store ?? defaultStoreRoot());
  mkdirSync(root, { recursive: true });
  return new Store(root);
}

function trackerFrom(options: Options, config: Config, storeRoot: string): Tracker {
  if (options.fake) return new FileTracker(join(storeRoot, "tickets.json"));
  const linear: { apiKey: string; project: string; team?: string } = {
    apiKey: process.env.LINEAR_API_KEY ?? "",
    project: config.tracker.project,
  };
  if (config.tracker.team) linear.team = config.tracker.team;
  return new LinearTracker(linear);
}

/**
 * The offline agent. It answers every prompt with a refusal that parses, so `--fake` without
 * a scripted reply is honest about doing nothing rather than pretending to work.
 * `scripts/demo.mts` supplies a real script instead.
 */
function fakeAgent(): AgentRunner {
  return new FakeAgent([
    '```json\n{ "outcome": "blocked", "summary": "--fake with no script", "runbook": "run `pnpm demo` for a scripted offline cycle" }\n```',
  ]);
}

function agentFrom(options: Options): AgentRunner {
  return options.fake ? fakeAgent() : new ClaudeCodeAgent();
}

function bundlesFrom(config: Config, target: string | undefined): Bundle[] {
  if (target) {
    if (existsSync(join(target, "bundle.json"))) return [readBundleDir(target)];
    if (existsSync(target)) return [parseBundleJSON(readFileSync(target, "utf8"))];
    throw new Error(`no bundle at ${target}`);
  }
  const dir = config.capture.loupe.bundleDir;
  if (!dir) throw new Error("no bundle given, and capture.loupe.bundleDir is not set in the config");
  const found = listBundleDirs(dir.replace(/^~/, process.env.HOME ?? "~"));
  if (found.length === 0) throw new Error(`no bundles under ${dir}`);
  return found.map(readBundleDir);
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      store: { type: "string" },
      "dry-run": { type: "boolean" },
      fake: { type: "boolean" },
      plain: { type: "boolean" },
      cycles: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  const options = values as Options;
  const command = positionals[0];

  if (options.help || !command || command === "help") {
    process.stdout.write(USAGE);
    return command ? EXIT.did : EXIT.nothing;
  }

  if (!COMMANDS.has(command)) {
    process.stderr.write(`unknown command \`${command}\`\n\n${USAGE}`);
    return EXIT.failed;
  }

  const dryRun = Boolean(options["dry-run"]);

  if (command === "doctor") {
    const path = existsSync(configPathFrom(options)) || options.config ? configPathFrom(options) : undefined;
    const report = await runDoctor({
      ...(path ? { configPath: path } : {}),
      ...(options.fake ? { fake: true } : {}),
      // The real probe. `doctor` is the one command whose whole job is finding out, so it is
      // the one place a network call earns its keep.
      ...(options.fake ? {} : { probeTracker: probeLinear }),
    });
    process.stdout.write(`${formatDoctorReport(report)}\n`);
    return report.ready ? EXIT.did : EXIT.failed;
  }

  if (command === "check-anchor") {
    const path = configPathFrom(options);
    const cfg = existsSync(path) ? loadConfig(path) : undefined;
    const report = checkAnchor({
      root: resolve(cfg?.repo.root ?? "."),
      /*
       * Nothing from the config narrows this, deliberately.
       *
       * It used to pass `boundaries.protectedPaths`, reasoning that out of bounds for the loop
       * is out of scope for the check. That held only while protectedPaths listed secrets and
       * build output. When self-hosting protected first-party source - the gate, the runner,
       * the prompts - the checker silently stopped scanning them, and 44 files became 40 with
       * no mention of it. Whether the agent may edit a file says nothing about whether the
       * file has to keep the design system.
       *
       * A replacement `anchorCheck.exclude` field was written and then deleted: every tree it
       * would have skipped is either already in `SKIPPED_DIRECTORIES` or does not exist. A
       * config field with no user is one more way for a checker to go quiet, which is the
       * failure this comment is about. `checkAnchor` still takes `exclude` for callers that
       * genuinely need it; the config does not reach it.
       */
    });
    process.stdout.write(`${formatAnchorReport(report)}\n`);
    // A checker exits 0 when it passes. It is the one command that does not use `nothing`
    // for an empty result, because "found no violations" is a pass, not a no-op - and CI,
    // which is its main caller, reads any non-zero code as a failure.
    return report.designMissing || report.violations.length > 0 ? EXIT.failed : EXIT.did;
  }

  const config = loadConfig(configPathFrom(options));
  const store = storeFrom(options);
  const tracker = trackerFrom(options, config, store.root);
  const agent = agentFrom(options);

  try {
    switch (command) {
      case "prune": {
        const days = config.cadence.retentionDays;
        if (dryRun) {
          process.stdout.write(`(dry run) would delete acked bundles older than ${days} days.\n`);
          return EXIT.nothing;
        }
        const gone = store.prune(days);
        process.stdout.write(
          gone === 0
            ? `Nothing to delete. Acked bundles are kept for ${days} days.\n`
            : `Deleted ${gone} acked bundle${gone === 1 ? "" : "s"} and their screenshots, past ${days} days.\n`,
        );
        return gone > 0 ? EXIT.did : EXIT.nothing;
      }

      case "drain": {
        const undrained = store.undrained();
        if (undrained.length === 0) {
          process.stdout.write("Nothing waiting in intake.\n");
          return EXIT.nothing;
        }
        for (const stored of undrained) {
          const count = stored.bundle.annotations.length;
          process.stdout.write(
            `${stored.bundle.sessionID}  ${stored.bundle.app.name}  ${count} annotation${count === 1 ? "" : "s"}  received ${stored.receivedAt}\n`,
          );
        }
        process.stdout.write(`\n${undrained.length} waiting. Run \`autopilot triage\` to file them.\n`);
        return EXIT.did;
      }

      case "triage":
      case "say": {
        const isSay = command === "say";
        const text = positionals.slice(1).join(" ");
        if (isSay && !text) {
          process.stderr.write('say needs something to say: autopilot say "the search feels slow"\n');
          return EXIT.failed;
        }

        const input = isSay ? { text } : { bundles: bundlesFrom(config, positionals[1]) };

        // A bundle read off disk goes into the store first. `put` is idempotent on the
        // device-generated id, so this costs nothing on a repeat and is what lets the ack
        // make a re-run a no-op instead of a duplicate.
        if (!isSay && !dryRun) {
          for (const bundle of input.bundles ?? []) store.put(bundle);
        }

        const result = await runTriage({
          config,
          tracker,
          agent,
          input,
          store,
          ...(dryRun ? { dryRun: true } : {}),
        });

        if (result.alreadyTriaged.length > 0) {
          process.stdout.write(
            `Already triaged and drained, so nothing was filed again: ${result.alreadyTriaged.join(", ")}\n`,
          );
          if (result.created.length === 0) return EXIT.nothing;
        }

        for (const ticket of result.created) {
          process.stdout.write(`${ticket.id}  [${ticket.lane}, p${ticket.priority}]  ${ticket.title}\n`);
        }
        for (const link of result.linkedToExisting) {
          process.stdout.write(`linked to ${link.ticket}: ${link.why}\n`);
        }
        if (result.question) process.stdout.write(`\nTriage asks: ${result.question}\n`);

        /*
         * The ack is the only thing that marks a bundle drained, so it happens after the
         * tickets exist - and only if they do.
         *
         * Acking unconditionally drained a bundle whose triage returned nothing but a
         * question, so the annotations disappeared from intake and nothing re-triaged them
         * once the question was answered. The person did the work and got nothing, which
         * `docs/intake.md` calls the worst possible failure.
         */
        if (!isSay && !dryRun && result.created.length > 0) {
          for (const bundle of input.bundles ?? []) store.ack(bundle.sessionID);
        } else if (!isSay && result.created.length === 0) {
          process.stdout.write(
            "\nNothing was filed, so the bundle stays in intake. Answer the question and run triage again.\n",
          );
        }
        return result.created.length > 0 || result.question ? EXIT.did : EXIT.nothing;
      }

      case "engineer": {
        const id = positionals[1];
        if (!id) {
          process.stderr.write("engineer needs a ticket id: autopilot engineer SER-123\n");
          return EXIT.failed;
        }
        const ticket = await tracker.get(id);
        if (!ticket) {
          process.stderr.write(`no ticket ${id} in the ${config.tracker.project} project\n`);
          return EXIT.failed;
        }
        const outcome = await runEngineer({
          config,
          tracker,
          agent,
          store,
          ticket,
          ...(dryRun ? { dryRun: true } : {}),
        });
        process.stdout.write(`${outcome.status}: ${outcome.summary}\n\n${outcome.detail}\n`);
        // A rehearsal that did exactly what it was asked is not a failure. It shipped
        // nothing, which is what `nothing to do` means, and a wrapper reading exit 1 would
        // report a working dry run as broken.
        if (dryRun) return EXIT.nothing;
        return outcome.status === "shipped" ? EXIT.did : EXIT.failed;
      }

      case "loop": {
        const cycles = Number(options.cycles ?? "1");
        if (!Number.isInteger(cycles) || cycles < 1) {
          process.stderr.write("--cycles needs a whole number of 1 or more\n");
          return EXIT.failed;
        }
        const report = await runLoop({
          config,
          tracker,
          agent,
          store,
          maxCycles: cycles,
          ...(dryRun ? { dryRun: true } : {}),
          onCycle: (cycle) => {
            process.stdout.write(`${cycle.message}\n`);
            // The reason to rehearse is to read the prompt before letting an agent loose on
            // a product. Printing only the summary answered none of that.
            if (dryRun && cycle.engineer?.detail) {
              process.stdout.write(`\n${cycle.engineer.detail}\n`);
            }
          },
        });
        if (report.pruned > 0) {
          process.stdout.write(
            `pruned ${report.pruned} acked bundle${report.pruned === 1 ? "" : "s"} past ${config.cadence.retentionDays} days\n`,
          );
        }
        return report.exitCode;
      }

      /*
       * `wake` exists so a scheduler needs no shell.
       *
       * `integrations/README.md` has always had a Scheduler box and the folder has always held
       * only a README. Anyone wiring this up had to call `loop` then `digest` and decide what
       * to do with two exit codes, which is a wrapper script every user would write once and
       * get subtly wrong. One command, one exit code, no glue.
       *
       * The digest runs even when the cycle failed. A failed run is the case a person most
       * needs told about, so suppressing the message on failure would hide exactly the wake
       * worth reading.
       */
      case "wake": {
        const report = await runLoop({
          config,
          tracker,
          agent,
          store,
          maxCycles: 1,
          ...(dryRun ? { dryRun: true } : {}),
          onCycle: (cycle) => process.stdout.write(`${cycle.message}\n`),
        });
        if (report.pruned > 0) {
          process.stdout.write(
            `pruned ${report.pruned} acked bundle${report.pruned === 1 ? "" : "s"} past ${config.cadence.retentionDays} days\n`,
          );
        }

        const runs = store.undigestedRuns();
        if (options.plain) {
          const text = plainDigest(runs, await tracker.listOpen(), config, coherenceOf(config, store.undigestedSignals(), store.tally()));
          if (!text) {
            process.stdout.write("Nothing landed on staging. Silence is correct.\n");
          } else {
            process.stdout.write(`\n${text}\n`);
            if (!dryRun) {
              store.markDigested(runs.map((r) => r.ticketId));
              store.markSignalsDigested();
            }
          }
        } else {
          const digest = await runDigest({ config, tracker, agent, store, ...(dryRun ? { dryRun: true } : {}) });
          process.stdout.write(
            digest.silent ? "Nothing landed on staging. Silence is correct.\n" : `\n${digest.message}\n`,
          );
        }

        // The loop's own code, unchanged: a scheduler reads this and nothing else.
        return report.exitCode;
      }

      case "audit": {
        const result = await runSelfAudit({ config, tracker, agent, ...(dryRun ? { dryRun: true } : {}) });
        if (result.nothingToDo) {
          process.stdout.write("Nothing worth filing. An idle loop is a correct outcome.\n");
          return EXIT.nothing;
        }
        for (const ticket of result.created) {
          process.stdout.write(`${ticket.id}  [p${ticket.priority}]  ${ticket.title}\n`);
        }
        if (result.note) process.stdout.write(`\nNote for the digest: ${result.note}\n`);
        return EXIT.did;
      }

      case "digest": {
        if (options.plain) {
          const runs = store.undigestedRuns();
          const coherence = coherenceOf(config, store.undigestedSignals(), store.tally());
          const text = plainDigest(runs, await tracker.listOpen(), config, coherence);
          if (!text) {
            process.stdout.write("Nothing landed on staging. Silence is correct.\n");
            return EXIT.nothing;
          }
          process.stdout.write(`${text}\n`);
          if (!dryRun) {
            store.markDigested(runs.map((r) => r.ticketId));
            store.markSignalsDigested();
          }
          return EXIT.did;
        }
        const result = await runDigest({ config, tracker, agent, store, ...(dryRun ? { dryRun: true } : {}) });
        if (result.silent) {
          process.stdout.write("Nothing landed on staging. Silence is correct.\n");
          return EXIT.nothing;
        }
        process.stdout.write(`${result.message}\n`);
        return EXIT.did;
      }

      case "release": {
        const id = positionals[1];
        if (!id) {
          process.stderr.write("release needs a ticket id: autopilot release SER-123\n");
          return EXIT.failed;
        }
        const result = await runRelease({
          config,
          store,
          tracker,
          ticketId: id,
          ...(dryRun ? { dryRun: true } : {}),
        });
        const out = result.status === "released" ? process.stdout : process.stderr;
        out.write(`${result.message}\n`);
        return result.status === "released" ? EXIT.did : EXIT.failed;
      }

      default:
        // Unreachable: COMMANDS is checked above. Kept so adding a command to that set
        // without a branch fails loudly instead of silently doing nothing.
        process.stderr.write(`\`${command}\` is listed as a command but has no implementation\n`);
        return EXIT.failed;
    }
  } finally {
    store.close();
  }
}

/** Exported so tests can drive the CLI without spawning a process. */
/*
 * Read `.env` from the Autopilot checkout before anything looks at `process.env`.
 *
 * A key was put in `repo/.env` - the obvious place, and already gitignored - and `doctor` still
 * reported it missing, because nothing loaded the file. Telling a person their correct instinct
 * was wrong is worse than reading the file.
 *
 * Three deliberate choices:
 * - `process.loadEnvFile` rather than a dependency. It is stdlib, and a real environment
 *   variable already wins over the file, so a plist entry or an export overrides a stale
 *   `.env` rather than the other way round.
 * - the Autopilot checkout only, never the current directory. The loop runs inside other
 *   people's repos and the gate passes `process.env` to every command it shells out to, so
 *   hoovering up a product's own `.env` would hand its secrets to the agent.
 * - a missing file is silence. Not having one is the normal case.
 */
/**
 * Read-only, and the cheapest question that proves the key works.
 *
 * A server that answered and refused is a different finding from a network that never
 * answered: the first means the key or the project name is wrong and doctor should say so;
 * the second means try again on a better connection. Only the transport failure is rethrown,
 * and doctor turns that into a warning rather than a block.
 */
async function probeLinear(apiKey: string, project: string, team?: string): Promise<TrackerProbe> {
  const tracker = trackerFor({ project, ...(team ? { team } : {}), apiKey });
  try {
    const open = await tracker.listOpen();
    return {
      ok: true,
      detail: `reached the tracker, ${open.length} open ticket${open.length === 1 ? "" : "s"} in ${project}`,
    };
  } catch (cause) {
    const message = (cause as Error).message;
    const answered = message.startsWith("Linear returned") || message.startsWith("Linear rejected");
    if (!answered) throw cause;
    return { ok: false, detail: `set, but the tracker rejected it: ${message}` };
  }
}

function loadCheckoutEnv(): void {
  try {
    process.loadEnvFile(join(repoRoot(), ".env"));
  } catch {
    // No .env, or an unreadable one. Neither is worth a word: `doctor` is what reports a
    // missing key, and it names the fix.
  }
}

export async function cli(argv: string[]): Promise<number> {
  try {
    loadCheckoutEnv();
    return await main(argv);
  } catch (cause) {
    process.stderr.write(`${(cause as Error).message}\n`);
    return EXIT.failed;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href;

if (invokedDirectly) {
  process.exitCode = await cli(process.argv.slice(2));
}

/** Write a starter config beside a product repo. Used by the demo and by hand. */
export function writeStarterConfig(path: string, productName: string, repoRoot: string): void {
  const starter = {
    $schema: "https://github.com/serhii-kucherenko/autopilot/schema/autopilot.config.schema.json",
    product: {
      name: productName,
      vision: "docs/vision.md",
      // CONTEXT.md is in the default anchor for the reason ADR 0010 gives: a word that means
      // two things is the same drift as a decision nobody recorded, and the agent can only
      // use the product's words if it is told to read them.
      anchors: ["DESIGN.md", "CONTEXT.md", "docs/adr/"],
    },
    tracker: { kind: "linear", project: productName },
    repo: { root: repoRoot, defaultBranch: "main", branchPrefix: "auto/" },
    environments: { staging: { deploy: "echo replace-me" } },
    gate: { commands: ["pnpm lint", "pnpm typecheck", "pnpm test"] },
    boundaries: {
      // `**/` matters: a bare `.env*` protects only a root-level file, because `*` never
      // crosses a slash. `apps/web/.env.local` would have sailed straight through.
      protectedPaths: ["**/.env*", "**/*.pem", "**/id_rsa*"],
      forbiddenCommands: ["git push --force", "rm -rf"],
      maxTicketsInFlight: 1,
    },
    cadence: { engineerInterval: "30m", digest: "daily 08:00", selfAuditOnEmptyBacklog: true },
  };
  writeFileSync(path, `${JSON.stringify(starter, null, 2)}\n`);
}
