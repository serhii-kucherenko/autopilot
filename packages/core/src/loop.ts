/**
 * The continuity engine (`docs/architecture.md`, layer 4).
 *
 * One cycle: take the next unblocked ticket, run it end to end, and on an empty backlog run
 * a self-audit to refill rather than idling. This is the "keeps working between your
 * touches" property, and `integrations/README.md` names the one thing it must get right:
 *
 * > It must be idempotent: waking twice while a ticket is in flight must not start it
 * > twice. The lock is the ticket state in Linear, not a local file.
 *
 * That is why `pickNext` resumes a started ticket before starting a new one, and why this
 * file holds no lock of its own. A second scheduler firing mid-ticket re-enters the same
 * ticket on the same branch.
 */

import type { Config } from "./config.ts";
import type { AgentRunner } from "./agent.ts";
import type { Tracker } from "./tracker.ts";
import { pickNext } from "./tracker.ts";
import type { Store } from "./store.ts";
import { Git } from "./git.ts";
import { runEngineer, type EngineerOutcome } from "./engineer.ts";
import { runSelfAudit, type SelfAuditResult } from "./selfaudit.ts";

export type CycleKind = "ticket" | "self-audit" | "idle";

export interface Cycle {
  kind: CycleKind;
  engineer?: EngineerOutcome;
  audit?: SelfAuditResult;
  message: string;
}

export interface LoopReport {
  cycles: Cycle[];
  /** 0 did work, 2 nothing to do, 1 something failed. A scheduler reads this. */
  exitCode: 0 | 1 | 2;
  /** Acked bundles deleted this run, with their screenshots. */
  pruned: number;
}

export interface LoopOptions {
  config: Config;
  tracker: Tracker;
  agent: AgentRunner;
  store?: Store;
  git?: Git;
  /** How many cycles to run. One is what a scheduled wake does. */
  maxCycles?: number;
  dryRun?: boolean;
  onCycle?: (cycle: Cycle) => void;
}

/**
 * Statuses that end the run rather than continuing to the next ticket.
 *
 * `blocked` and `no-change` are here for a reason a test found: the engineer parks such a
 * ticket back in the backlog, so the very next cycle picks the same top-priority ticket again.
 * `--cycles 5` re-ran one blocked ticket five times and posted five identical runbook
 * comments. An agent that produced nothing once will produce nothing again; both cases need a
 * person, so the loop says so and stops.
 *
 * `conflict` is deliberately NOT here. A conflict is a decision for the human that the digest
 * carries, and `docs/coherence.md` says the agent "moves to the next ticket" - so the loop
 * does, and the parked ticket is skipped for the rest of this run.
 */
const STOP_AFTER: EngineerOutcome["status"][] = [
  "agent-failed",
  "gate-failed",
  "out-of-bounds",
  "deploy-failed",
  "blocked",
  "no-change",
];

export async function runLoop(options: LoopOptions): Promise<LoopReport> {
  const { config, tracker, agent } = options;
  const maxCycles = options.maxCycles ?? 1;
  const cycles: Cycle[] = [];
  let exitCode: 0 | 1 | 2 = 2;

  /**
   * Tickets this run has already parked. A conflicted ticket goes back to the backlog, so
   * without this the next cycle would pick the same one straight back up.
   */
  const parked = new Set<string>();

  /*
   * Retention runs here, on every wake.
   *
   * `docs/intake.md` says bundles are deleted a fixed period after they are acked, and that
   * the store is sensitive because it holds screenshots of a running product. That was true in
   * prose and false in code: `Store.prune` existed and nothing ever called it, so the pictures
   * accumulated forever. The loop is the only scheduled thing in the system, which makes it
   * the only place this can happen without adding a second cron.
   */
  const pruned =
    options.store && !options.dryRun ? options.store.prune(config.cadence.retentionDays) : 0;

  for (let i = 0; i < maxCycles; i += 1) {
    const open = (await tracker.listOpen()).filter((t) => !parked.has(t.id));
    const ticket = pickNext(open);

    if (ticket) {
      const engineer = await runEngineer({
        config,
        tracker,
        agent,
        ticket,
        ...(options.store ? { store: options.store } : {}),
        ...(options.git ? { git: options.git } : {}),
        ...(options.dryRun ? { dryRun: true } : {}),
      });

      const cycle: Cycle = {
        kind: "ticket",
        engineer,
        message: `${ticket.id} ${engineer.status}: ${engineer.summary}`,
      };
      cycles.push(cycle);
      options.onCycle?.(cycle);

      if (STOP_AFTER.includes(engineer.status)) {
        // Do not march on to the next ticket after a failure. The loop would bury the one
        // thing worth reading under the next five cycles.
        return { cycles, exitCode: 1, pruned };
      }
      if (engineer.status === "conflict") parked.add(ticket.id);
      exitCode = 0;
      continue;
    }

    if (!config.cadence.selfAuditOnEmptyBacklog) {
      const cycle: Cycle = { kind: "idle", message: "the backlog is empty and self-audit is off" };
      cycles.push(cycle);
      options.onCycle?.(cycle);
      return { cycles, exitCode: exitCode === 0 ? 0 : 2, pruned };
    }

    const audit = await runSelfAudit({
      config,
      tracker,
      agent,
      ...(options.dryRun ? { dryRun: true } : {}),
    });

    const cycle: Cycle = {
      kind: "self-audit",
      audit,
      message: audit.nothingToDo
        ? "the backlog is empty and the self-audit found nothing. An idle loop is a correct outcome."
        : `the self-audit filed ${audit.created.length} ticket${audit.created.length === 1 ? "" : "s"}`,
    };
    cycles.push(cycle);
    options.onCycle?.(cycle);

    if (audit.nothingToDo) {
      // Genuinely nothing to do. Say so and stop; manufacturing work is the failure mode
      // prompts/self-audit.md exists to prevent.
      return { cycles, exitCode: exitCode === 0 ? 0 : 2, pruned };
    }
    exitCode = 0;
  }

  return { cycles, exitCode, pruned };
}
