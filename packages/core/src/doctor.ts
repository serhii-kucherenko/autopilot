/**
 * `autopilot doctor` - what is missing, and exactly how to fix each thing.
 *
 * The rule this file follows is the one `prompts/digest.md` states for blockers: never a
 * bare "install X". Every failing check carries the command or the URL, and what it costs.
 * A setup step someone has to research is a setup step that does not happen.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { ConfigError, loadConfig } from "./config.ts";

export type CheckStatus = "ok" | "missing" | "warn";

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  checks: Check[];
  /** True when nothing required is missing. Warnings do not block. */
  ready: boolean;
}

function version(bin: string, args: string[] = ["--version"]): string | undefined {
  try {
    return execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 5;

function nodeCheck(): Check {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const ok = major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR);
  if (ok) return { name: "node", status: "ok", detail: `v${process.versions.node}` };
  return {
    name: "node",
    status: "missing",
    detail: `v${process.versions.node}, but Autopilot needs v${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} or newer`,
    fix: `node:sqlite arrived in ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} and the intake store depends on it. Install a current Node: https://nodejs.org/en/download`,
  };
}

function claudeCheck(): Check {
  const bin = process.env.AUTOPILOT_CLAUDE_BIN ?? "claude";
  const found = version(bin);
  if (found) return { name: "claude CLI", status: "ok", detail: found };
  return {
    name: "claude CLI",
    status: "missing",
    detail: `\`${bin}\` is not on PATH`,
    fix:
      "Every prompt runs through the Claude Code CLI in headless mode (ADR 0002). Install it with " +
      "`npm i -g @anthropic-ai/claude-code`, then run `claude` once to sign in. " +
      "Set AUTOPILOT_CLAUDE_BIN if it lives somewhere unusual. `--fake` runs the loop without it.",
  };
}

function pnpmCheck(): Check {
  const found = version("pnpm");
  if (found) return { name: "pnpm", status: "ok", detail: `v${found}` };
  return {
    name: "pnpm",
    status: "warn",
    detail: "pnpm is not on PATH",
    fix: "Autopilot itself is a pnpm workspace: `npm i -g pnpm`. A product repo may use anything.",
  };
}

function gitCheck(): Check {
  const found = version("git");
  if (found) return { name: "git", status: "ok", detail: found };
  return {
    name: "git",
    status: "missing",
    detail: "git is not on PATH",
    fix: "The engineer runner branches, commits and merges. Install git: https://git-scm.com/downloads",
  };
}

function linearCheck(fake: boolean): Check {
  if (process.env.LINEAR_API_KEY) {
    return { name: "LINEAR_API_KEY", status: "ok", detail: "set" };
  }
  if (fake) {
    return {
      name: "LINEAR_API_KEY",
      status: "ok",
      detail: "not set, and not needed: --fake uses the file tracker",
    };
  }
  return {
    name: "LINEAR_API_KEY",
    status: "missing",
    detail: "not set",
    fix:
      "Create a personal API key at https://linear.app/settings/account/security " +
      '(press "New API key", name it "autopilot", copy the value - it is shown once), then ' +
      "`export LINEAR_API_KEY=lin_api_...`. You know it worked when `autopilot doctor` says set. " +
      "An API key rather than OAuth because the loop wakes on a schedule with nobody there (ADR 0005). " +
      "Or run with --fake and no key at all.",
  };
}

function configCheck(path: string | undefined): Check {
  if (!path) {
    return {
      name: "autopilot.config.json",
      status: "warn",
      detail: "no --config given, so nothing was validated",
      fix: "Point at a product's config: `autopilot doctor --config ../reco/autopilot.config.json`.",
    };
  }
  if (!existsSync(path)) {
    return {
      name: "autopilot.config.json",
      status: "missing",
      detail: `no file at ${path}`,
      fix: "Copy `schema/example.reco.json` into the product repo as `autopilot.config.json` and edit it. See schema/README.md.",
    };
  }
  try {
    const config = loadConfig(path);
    const repoOk = existsSync(config.repo.root);
    if (!repoOk) {
      return {
        name: "autopilot.config.json",
        status: "missing",
        detail: `valid, but repo.root "${config.repo.root}" does not exist`,
        fix: "Point repo.root at the product's checkout. It is where the agent's file tools are rooted.",
      };
    }
    return {
      name: "autopilot.config.json",
      status: "ok",
      detail: `${config.product.name}, ${config.gate.commands.length} gate command${config.gate.commands.length === 1 ? "" : "s"}, ${config.boundaries.maxTicketsInFlight} ticket in flight`,
    };
  } catch (cause) {
    return {
      name: "autopilot.config.json",
      status: "missing",
      detail: cause instanceof ConfigError ? cause.message : String(cause),
      fix: "Fix the fields named above. `schema/autopilot.config.schema.json` is the contract.",
    };
  }
}

export function runDoctor(options: { configPath?: string; fake?: boolean } = {}): DoctorReport {
  const checks: Check[] = [
    nodeCheck(),
    gitCheck(),
    pnpmCheck(),
    claudeCheck(),
    linearCheck(options.fake ?? false),
    configCheck(options.configPath),
  ];
  return { checks, ready: checks.every((c) => c.status !== "missing") };
}

export function formatDoctorReport(report: DoctorReport): string {
  const mark = { ok: "ok  ", missing: "MISS", warn: "warn" } as const;
  const lines = report.checks.flatMap((c) => {
    const head = `[${mark[c.status]}] ${c.name}: ${c.detail}`;
    return c.status === "ok" || !c.fix ? [head] : [head, ...c.fix.split("\n").map((l) => `        ${l}`)];
  });
  return [
    ...lines,
    "",
    report.ready
      ? "Ready. Run `autopilot loop --config <path>` to start, or add --dry-run to rehearse it."
      : "Not ready for a real product. Fix the MISS lines above; anything marked warn is optional.",
    // Somebody reading this for the first time has nothing set up and no reason to know
    // that the whole loop already runs without any of it.
    report.ready ? "" : "Nothing above is needed for `pnpm demo`, which runs a full cycle offline.",
  ]
    .filter((line, index, all) => line !== "" || all[index - 1] !== "")
    .join("\n");
}
