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
import { loadConfig, type Config } from "./config.ts";
import { ClaudeCodeAgent, FakeAgent, type AgentRunner } from "./agent.ts";
import { FileTracker, LinearTracker, type Tracker } from "./tracker.ts";
import { Store, defaultStoreRoot } from "./store.ts";
import { readBundleDir, listBundleDirs, parseBundleJSON, type Bundle } from "./bundle.ts";
import { runTriage } from "./triage.ts";
import { runEngineer } from "./engineer.ts";
import { runSelfAudit } from "./selfaudit.ts";
import { runDigest, plainDigest, coherenceOf } from "./digest.ts";
import { runRelease } from "./release.ts";
import { runLoop } from "./loop.ts";
import { checkAnchor, formatAnchorReport } from "./anchor.ts";
import { runDoctor, formatDoctorReport } from "./doctor.ts";

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
    const report = runDoctor({
      ...(path ? { configPath: path } : {}),
      ...(options.fake ? { fake: true } : {}),
    });
    process.stdout.write(`${formatDoctorReport(report)}\n`);
    return report.ready ? EXIT.did : EXIT.failed;
  }

  if (command === "check-anchor") {
    const path = configPathFrom(options);
    const cfg = existsSync(path) ? loadConfig(path) : undefined;
    const report = checkAnchor({
      root: resolve(cfg?.repo.root ?? "."),
      // Out of bounds for the loop means out of scope for this check too.
      ...(cfg ? { exclude: cfg.boundaries.protectedPaths } : {}),
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
          onCycle: (cycle) => process.stdout.write(`${cycle.message}\n`),
        });
        if (report.pruned > 0) {
          process.stdout.write(
            `pruned ${report.pruned} acked bundle${report.pruned === 1 ? "" : "s"} past ${config.cadence.retentionDays} days\n`,
          );
        }
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
          const coherence = coherenceOf(config, store.undigestedSignals());
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
export async function cli(argv: string[]): Promise<number> {
  try {
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
    product: { name: productName, vision: "docs/vision.md", anchors: ["DESIGN.md", "docs/adr/"] },
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
