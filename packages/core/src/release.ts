/**
 * The production press, and the only code in Autopilot that may run a production deploy.
 *
 * The whole safety argument of this system is that the loop cannot reach production. That
 * claim rests on two things, and both live here:
 *
 * 1. the engineer runner never reads `environments.production`, so no ticket can lead here;
 * 2. this function refuses to deploy without an approval recorded for **exactly** the commit
 *    that is being released.
 *
 * Rule 2 is why the approval is bound to a commit rather than to a ticket. The human presses
 * on what they reviewed. Anything merged after that press is unreviewed, the commit no
 * longer matches, and the press has to happen again.
 */

import type { Config } from "./config.ts";
import { Git } from "./git.ts";
import type { Store } from "./store.ts";
import { runCommand } from "./gate.ts";
import type { Tracker } from "./tracker.ts";

export type ReleaseStatus = "released" | "not-approved" | "moved-on" | "no-production" | "failed";

export interface ReleaseResult {
  status: ReleaseStatus;
  ticketId: string;
  commitSHA?: string;
  message: string;
}

export interface ReleaseOptions {
  config: Config;
  store: Store;
  ticketId: string;
  tracker?: Tracker;
  git?: Git;
  dryRun?: boolean;
}

export async function runRelease(options: ReleaseOptions): Promise<ReleaseResult> {
  const { config, store, ticketId } = options;
  const production = config.environments.production;

  if (!production?.deploy) {
    return {
      status: "no-production",
      ticketId,
      message:
        "this product has no environments.production.deploy, so there is nothing to release. " +
        "Add it to autopilot.config.json when the product has a production deploy.",
    };
  }

  const git = options.git ?? new Git(config.repo.root);
  // The default branch, never `HEAD`. See Git.headOf.
  const head = git.headOf(config.repo.defaultBranch);
  const run = store.runFor(ticketId);

  if (!run) {
    return {
      status: "not-approved",
      ticketId,
      commitSHA: head,
      message: `${ticketId} never shipped to staging, so there is nothing to promote.`,
    };
  }

  const approval = store.approvalFor(ticketId, head);
  if (!approval) {
    const forStaged = store.approvalFor(ticketId, run.commitSHA);
    if (forStaged) {
      // The press was real, but the code moved underneath it. Releasing now would ship
      // work nobody looked at.
      return {
        status: "moved-on",
        ticketId,
        commitSHA: head,
        message:
          `${ticketId} was approved at ${run.commitSHA.slice(0, 7)}, but ${config.repo.defaultBranch} is now at ` +
          `${head.slice(0, 7)}. Everything merged since that press is unreviewed. Press production again on the ` +
          "current staging build.",
      };
    }
    return {
      status: "not-approved",
      ticketId,
      commitSHA: head,
      message:
        `${ticketId} has no production approval at ${head.slice(0, 7)}. ` +
        "A human presses production in the console; nothing else can.",
    };
  }

  if (options.dryRun) {
    return {
      status: "released",
      ticketId,
      commitSHA: head,
      message: `(dry run) would run \`${production.deploy}\` for ${ticketId} at ${head.slice(0, 7)}, approved by ${approval.approvedBy}.`,
    };
  }

  const deploy = runCommand(production.deploy, {
    cwd: config.repo.root,
    forbiddenCommands: config.boundaries.forbiddenCommands,
  });

  if (!deploy.ok) {
    return {
      status: "failed",
      ticketId,
      commitSHA: head,
      message: `production deploy failed (exit ${deploy.exitCode}):\n${deploy.output.split("\n").slice(-20).join("\n")}`,
    };
  }

  const message =
    `${ticketId} released to production at ${head.slice(0, 7)}, approved by ${approval.approvedBy}` +
    `${production.url ? ` (${production.url})` : ""}.`;
  await options.tracker?.comment(ticketId, message);
  return { status: "released", ticketId, commitSHA: head, message };
}

/**
 * Record the human pressing production. Called by the console, never by a runner.
 *
 * The commit is read here rather than taken from the caller, and it is read from the *default
 * branch* rather than from `HEAD`. Reading `HEAD` was a real hole: a runner that stopped on a
 * conflict leaves the repo on the ticket branch, and a press taken then would have approved a
 * feature-branch commit nobody reviewed - the exact opposite of the guarantee.
 */
export function pressProduction(options: {
  config: Config;
  store: Store;
  ticketId: string;
  approvedBy: string;
  git?: Git;
}): { ticketId: string; commitSHA: string } {
  const git = options.git ?? new Git(options.config.repo.root);
  const commitSHA = git.headOf(options.config.repo.defaultBranch);
  options.store.approve({ ticketId: options.ticketId, commitSHA, approvedBy: options.approvedBy });
  return { ticketId: options.ticketId, commitSHA };
}
