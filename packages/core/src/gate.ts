/**
 * The quality gate. `docs/architecture.md`: "the only thing standing between an
 * autonomous merge and a broken staging".
 *
 * Two properties matter more than speed here:
 * - a failing gate is never softened. There is no `--force`, no retry-until-green, no
 *   "warn instead of fail". The runner's only options are fix it or stop.
 * - every command is boundary-checked before it runs, so a config or a prompt cannot
 *   sneak `rm -rf` past the gate under the name of a test command.
 */

import { spawnSync } from "node:child_process";
import { assertCommandAllowed } from "./boundaries.ts";

export interface CommandResult {
  command: string;
  ok: boolean;
  exitCode: number;
  output: string;
  skipped?: boolean;
}

export interface GateResult {
  ok: boolean;
  results: CommandResult[];
  /** The first failure, for the message a human or the digest reads. */
  failure?: CommandResult;
}

export interface GateOptions {
  cwd: string;
  forbiddenCommands?: string[];
  dryRun?: boolean;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export const DEFAULT_COMMAND_TIMEOUT_MS = 20 * 60 * 1000;

export function runCommand(command: string, options: GateOptions): CommandResult {
  assertCommandAllowed(command, options.forbiddenCommands ?? []);

  if (options.dryRun) {
    return { command, ok: true, exitCode: 0, output: "(dry run, not executed)", skipped: true };
  }

  const run = spawnSync(command, {
    cwd: options.cwd,
    shell: true,
    encoding: "utf8",
    timeout: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    env: { ...process.env, ...options.env },
    maxBuffer: 32 * 1024 * 1024,
  });

  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
  if (run.error) {
    return { command, ok: false, exitCode: 1, output: `${output}\n${run.error.message}`.trim() };
  }
  return { command, ok: run.status === 0, exitCode: run.status ?? 1, output };
}

/**
 * Run every gate command in order and stop at the first failure. Stopping early is
 * deliberate: the first failure is the one worth reading, and running a slow suite after
 * lint already failed wastes the loop's time.
 */
export function runGate(commands: string[], options: GateOptions): GateResult {
  const results: CommandResult[] = [];
  for (const command of commands) {
    const result = runCommand(command, options);
    results.push(result);
    if (!result.ok) return { ok: false, results, failure: result };
  }
  return { ok: true, results };
}

/** What the digest and the ticket comment say about a gate run. */
export function summariseGate(gate: GateResult): string {
  if (gate.ok) {
    const ran = gate.results.filter((r) => !r.skipped).length;
    return `quality gate passed (${ran}/${gate.results.length} commands run)`;
  }
  const f = gate.failure!;
  const tail = f.output.split("\n").slice(-20).join("\n");
  return `quality gate FAILED on \`${f.command}\` (exit ${f.exitCode}):\n${tail}`;
}
