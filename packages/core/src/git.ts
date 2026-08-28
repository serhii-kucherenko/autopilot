/**
 * The git operations the engineer runner needs, and nothing else.
 *
 * ponytail: `execFile` on the `git` binary rather than a library. Nine commands, no
 * dependency, and the error messages are the ones a person already knows how to read.
 */

import { execFileSync } from "node:child_process";

export class GitError extends Error {
  override name = "GitError";
}

export class Git {
  readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  private run(args: string[]): string {
    try {
      return execFileSync("git", args, {
        cwd: this.cwd,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        // Captured, not inherited: `branchExists` probes with rev-parse, and its "Needed a
        // single revision" on stderr is expected, not something a log should show.
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (cause) {
      const e = cause as { stderr?: string; message: string };
      throw new GitError(`git ${args.join(" ")} failed: ${(e.stderr ?? e.message).trim()}`);
    }
  }

  isRepo(): boolean {
    try {
      return this.run(["rev-parse", "--is-inside-work-tree"]) === "true";
    } catch {
      return false;
    }
  }

  head(): string {
    return this.run(["rev-parse", "HEAD"]);
  }

  currentBranch(): string {
    return this.run(["rev-parse", "--abbrev-ref", "HEAD"]);
  }

  branchExists(name: string): boolean {
    try {
      this.run(["rev-parse", "--verify", `refs/heads/${name}`]);
      return true;
    } catch {
      return false;
    }
  }

  /** Start or resume the ticket's branch. Resuming matters: a crashed run must re-enter. */
  checkoutBranch(name: string): void {
    if (this.branchExists(name)) this.run(["checkout", name]);
    else this.run(["checkout", "-b", name]);
  }

  checkout(ref: string): void {
    this.run(["checkout", ref]);
  }

  /** Everything the working tree has changed, staged or not, including new files. */
  dirtyPaths(): string[] {
    const lines = this.run(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    return lines
      .split("\0")
      .filter((l) => l.length > 3)
      .map((l) => l.slice(3));
  }

  /** Paths a branch changed relative to another ref. This is what the boundary check reads. */
  changedPathsSince(ref: string): string[] {
    const out = this.run(["diff", "--name-only", `${ref}...HEAD`]);
    return out === "" ? [] : out.split("\n");
  }

  hasChanges(): boolean {
    return this.dirtyPaths().length > 0;
  }

  commitAll(message: string): string {
    this.run(["add", "-A"]);
    this.run(["commit", "-m", message]);
    return this.head();
  }

  /**
   * Merge the ticket branch into the default branch. `--no-ff` keeps one merge commit per
   * ticket, so a ticket is one revertible unit.
   */
  mergeInto(target: string, branch: string, message: string): string {
    this.run(["checkout", target]);
    this.run(["merge", "--no-ff", "-m", message, branch]);
    return this.head();
  }

  diffStat(ref: string): string {
    return this.run(["diff", "--stat", `${ref}...HEAD`]);
  }

  /** The raw diff text. The flag check needs the added lines, not just the file names. */
  diffText(ref: string): string {
    return this.run(["diff", `${ref}...HEAD`]);
  }
}

/**
 * A branch name from a ticket id. Lowercase and hyphenated, prefixed from the config, so
 * every branch the loop creates is recognisable as the loop's.
 */
export function branchNameFor(prefix: string, ticketId: string): string {
  return `${prefix}${ticketId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

/**
 * A feature flag name from a ticket id. `gate.featureFlags.required` means every merge is
 * behind one of these, so the name has to be derivable rather than invented per ticket.
 */
export function flagNameFor(ticketId: string): string {
  return `flag_${ticketId.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}
