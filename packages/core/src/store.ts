/**
 * Intake storage. ADR 0004: SQLite for metadata, PNGs beside it on disk, the device's
 * `sessionID` as the primary key so an upload is idempotent for free.
 *
 * The driver is `node:sqlite` from the standard library. Node 22.5+ is already the engine
 * floor, so this costs no dependency and no native build.
 *
 * ponytail: single writer. That is the known ceiling from ADR 0004; the upgrade path is
 * swapping this class for a Postgres one behind the same methods.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Bundle } from "./bundle.ts";

export interface StoredBundle {
  bundle: Bundle;
  receivedAt: string;
  ackedAt?: string;
}

export interface Approval {
  ticketId: string;
  commitSHA: string;
  approvedBy: string;
  approvedAt?: string;
}

export interface StagedRun {
  ticketId: string;
  commitSHA: string;
  branch: string;
  flag: string;
  summary: string;
  unsure?: string;
  stagingURL?: string;
  createdAt?: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bundles (
  session_id  TEXT PRIMARY KEY,
  app_name    TEXT NOT NULL,
  received_at TEXT NOT NULL,
  acked_at    TEXT,
  json        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bundles_undrained ON bundles (acked_at, received_at);

CREATE TABLE IF NOT EXISTS approvals (
  ticket_id   TEXT NOT NULL,
  commit_sha  TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  PRIMARY KEY (ticket_id, commit_sha)
);

CREATE TABLE IF NOT EXISTS runs (
  ticket_id   TEXT PRIMARY KEY,
  commit_sha  TEXT NOT NULL,
  branch      TEXT NOT NULL,
  flag        TEXT NOT NULL,
  summary     TEXT NOT NULL,
  unsure      TEXT,
  staging_url TEXT,
  created_at  TEXT NOT NULL,
  digested_at TEXT
);
`;

export class Store {
  private readonly db: DatabaseSync;
  readonly root: string;
  readonly imagesDir: string;

  constructor(root: string) {
    this.root = root;
    this.imagesDir = join(root, "images");
    mkdirSync(this.imagesDir, { recursive: true });
    this.db = new DatabaseSync(join(root, "autopilot.db"));
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  /**
   * Store one bundle. Inline base64 screenshots are written to disk and replaced by their
   * path, so a row stays small and the images can be pruned as files.
   */
  put(bundle: Bundle, options: { receivedAt?: string } = {}): { id: string; created: boolean } {
    const existing = this.db
      .prepare("SELECT session_id FROM bundles WHERE session_id = ?")
      .get(bundle.sessionID);
    if (existing) return { id: bundle.sessionID, created: false };

    const dir = join(this.imagesDir, bundle.sessionID);
    const annotations = bundle.annotations.map((a) => {
      if (!a.screenshotBase64) return a;
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${a.id}.png`);
      writeFileSync(path, Buffer.from(a.screenshotBase64, "base64"));
      const { screenshotBase64: _dropped, ...rest } = a;
      return { ...rest, screenshotPath: path };
    });

    const stored: Bundle = { ...bundle, annotations };
    const receivedAt = options.receivedAt ?? new Date().toISOString();
    this.db
      .prepare("INSERT INTO bundles (session_id, app_name, received_at, json) VALUES (?, ?, ?, ?)")
      .run(bundle.sessionID, bundle.app.name, receivedAt, JSON.stringify(stored));

    return { id: bundle.sessionID, created: true };
  }

  private row(r: Record<string, unknown>): StoredBundle {
    const stored: StoredBundle = {
      bundle: JSON.parse(r.json as string) as Bundle,
      receivedAt: r.received_at as string,
    };
    if (r.acked_at) stored.ackedAt = r.acked_at as string;
    return stored;
  }

  get(sessionID: string): StoredBundle | undefined {
    const r = this.db.prepare("SELECT * FROM bundles WHERE session_id = ?").get(sessionID);
    return r ? this.row(r as Record<string, unknown>) : undefined;
  }

  /** Everything not yet acknowledged, oldest first, as `docs/intake.md` specifies. */
  undrained(): StoredBundle[] {
    return this.db
      .prepare("SELECT * FROM bundles WHERE acked_at IS NULL ORDER BY received_at ASC, session_id ASC")
      .all()
      .map((r) => this.row(r as Record<string, unknown>));
  }

  /**
   * Mark a bundle drained. The ack is the only thing that marks it done, so a triage run
   * that crashes halfway can simply run again.
   */
  ack(sessionID: string, at = new Date().toISOString()): boolean {
    const known = this.db
      .prepare("SELECT acked_at FROM bundles WHERE session_id = ?")
      .get(sessionID) as { acked_at: string | null } | undefined;
    if (!known) return false;
    if (known.acked_at) return true;
    this.db.prepare("UPDATE bundles SET acked_at = ? WHERE session_id = ?").run(at, sessionID);
    return true;
  }

  /**
   * Delete acked bundles older than `days`, and their images. Bundles hold screenshots of
   * a running product, so retention is a safety property, not housekeeping.
   */
  prune(days: number, now = new Date()): number {
    const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
    const doomed = this.db
      .prepare("SELECT session_id FROM bundles WHERE acked_at IS NOT NULL AND acked_at < ?")
      .all(cutoff) as { session_id: string }[];

    for (const { session_id } of doomed) {
      const dir = join(this.imagesDir, session_id);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      this.db.prepare("DELETE FROM bundles WHERE session_id = ?").run(session_id);
    }
    return doomed.length;
  }

  /** Record the human pressing production. Bound to one ticket and one commit. */
  approve(approval: Approval): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO approvals (ticket_id, commit_sha, approved_by, approved_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        approval.ticketId,
        approval.commitSHA,
        approval.approvedBy,
        approval.approvedAt ?? new Date().toISOString(),
      );
  }

  /**
   * The approval for exactly this ticket at exactly this commit. Binding to the commit is
   * what stops work merged after the press inheriting it.
   */
  approvalFor(ticketId: string, commitSHA: string): Approval | undefined {
    const r = this.db
      .prepare("SELECT * FROM approvals WHERE ticket_id = ? AND commit_sha = ?")
      .get(ticketId, commitSHA) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      ticketId: r.ticket_id as string,
      commitSHA: r.commit_sha as string,
      approvedBy: r.approved_by as string,
      approvedAt: r.approved_at as string,
    };
  }

  recordRun(run: StagedRun): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO runs
         (ticket_id, commit_sha, branch, flag, summary, unsure, staging_url, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.ticketId,
        run.commitSHA,
        run.branch,
        run.flag,
        run.summary,
        run.unsure ?? null,
        run.stagingURL ?? null,
        run.createdAt ?? new Date().toISOString(),
      );
  }

  /** What shipped to staging since the last digest. */
  undigestedRuns(): StagedRun[] {
    return (
      this.db
        .prepare("SELECT * FROM runs WHERE digested_at IS NULL ORDER BY created_at ASC, ticket_id ASC")
        .all() as Record<string, unknown>[]
    ).map((r) => {
      const run: StagedRun = {
        ticketId: r.ticket_id as string,
        commitSHA: r.commit_sha as string,
        branch: r.branch as string,
        flag: r.flag as string,
        summary: r.summary as string,
        createdAt: r.created_at as string,
      };
      if (r.unsure) run.unsure = r.unsure as string;
      if (r.staging_url) run.stagingURL = r.staging_url as string;
      return run;
    });
  }

  runFor(ticketId: string): StagedRun | undefined {
    return this.allRuns().find((r) => r.ticketId === ticketId);
  }

  allRuns(): StagedRun[] {
    return (this.db.prepare("SELECT * FROM runs").all() as Record<string, unknown>[]).map((r) => {
      const run: StagedRun = {
        ticketId: r.ticket_id as string,
        commitSHA: r.commit_sha as string,
        branch: r.branch as string,
        flag: r.flag as string,
        summary: r.summary as string,
        createdAt: r.created_at as string,
      };
      if (r.unsure) run.unsure = r.unsure as string;
      if (r.staging_url) run.stagingURL = r.staging_url as string;
      return run;
    });
  }

  markDigested(ticketIds: string[], at = new Date().toISOString()): void {
    const update = this.db.prepare("UPDATE runs SET digested_at = ? WHERE ticket_id = ?");
    for (const id of ticketIds) update.run(at, id);
  }

  close(): void {
    this.db.close();
  }
}

/** Where intake keeps its state when nothing says otherwise. */
export function defaultStoreRoot(): string {
  return process.env.AUTOPILOT_STORE ?? join(process.cwd(), ".autopilot");
}
