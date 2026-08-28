/**
 * Server-only wiring. Everything the console reads or writes goes through here, so the two
 * rules in `DESIGN.md` are enforceable in one place:
 *
 * - **the console never writes to Linear.** It reads the queue. The runners are the only
 *   writers, so there is one writer and one truth.
 * - **the console never deploys.** The press records an approval; `autopilot release`
 *   deploys, and only with an approval matching the exact commit.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import {
  Store,
  FileTracker,
  LinearTracker,
  loadConfig,
  parseConfig,
  type Config,
  type Tracker,
  type Ticket,
} from "@autopilot/core";

/** Where the demo and the tests keep everything. Overridden by `AUTOPILOT_STORE`. */
export function storeRoot(): string {
  return resolve(process.env.AUTOPILOT_STORE ?? join(process.cwd(), ".autopilot"));
}

export function openStore(): Store {
  return new Store(storeRoot());
}

/**
 * The product config. Falls back to a minimal in-memory one so the console boots and
 * explains itself on a fresh clone rather than crashing on a missing file.
 */
export function config(): Config {
  const path = resolve(process.env.AUTOPILOT_CONFIG ?? join(process.cwd(), "autopilot.config.json"));
  if (existsSync(path)) return loadConfig(path);
  return parseConfig({
    product: { name: "no product configured", vision: "docs/vision.md" },
    tracker: { kind: "linear", project: "unconfigured" },
    repo: { root: ".", defaultBranch: "main" },
    environments: { staging: { deploy: "echo no staging deploy configured" } },
    gate: { commands: ["echo no gate configured"] },
  });
}

/**
 * Read-only view of the queue. `AUTOPILOT_FAKE=1` reads the file tracker the demo writes,
 * which is what makes the whole console runnable with no credential.
 */
export function tracker(cfg: Config): Tracker {
  if (process.env.AUTOPILOT_FAKE === "1" || !process.env.LINEAR_API_KEY) {
    return new FileTracker(join(storeRoot(), "tickets.json"));
  }
  const options: { apiKey: string; project: string; team?: string } = {
    apiKey: process.env.LINEAR_API_KEY,
    project: cfg.tracker.project,
  };
  if (cfg.tracker.team) options.team = cfg.tracker.team;
  return new LinearTracker(options);
}

/** Open tickets, best effort. A tracker that cannot be reached must not blank the screen. */
export async function openTickets(cfg: Config): Promise<{ tickets: Ticket[]; error?: string }> {
  try {
    return { tickets: await tracker(cfg).listOpen() };
  } catch (cause) {
    return { tickets: [], error: (cause as Error).message };
  }
}

/**
 * `docs/intake.md` requirement 2: not an open inbox. A per-build token in a header, present
 * only in dev and staging builds. Compared in constant time, and a missing token on the
 * server refuses every upload rather than defaulting to open.
 */
export function intakeAuthorised(request: Request): { ok: true } | { ok: false; why: string } {
  const expected = process.env.AUTOPILOT_INTAKE_TOKEN;
  if (!expected) {
    return {
      ok: false,
      why:
        "AUTOPILOT_INTAKE_TOKEN is not set on the server, so uploads are refused. " +
        "Set it here and in the app's dev or staging build. Never in a release build.",
    };
  }

  const header = request.headers.get("authorization") ?? "";
  const offered = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const a = Buffer.from(offered);
  const b = Buffer.from(expected);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  return ok ? { ok: true } : { ok: false, why: "bad or missing intake token" };
}

/** The image bytes for one annotation's crop, or nothing. Paths are never trusted. */
export function cropBytes(sessionID: string, annotationID: string): Buffer | undefined {
  const store = openStore();
  try {
    const stored = store.get(sessionID);
    const annotation = stored?.bundle.annotations.find((a) => a.id === annotationID);
    const path = annotation?.screenshotPath;
    if (!path) return undefined;

    // The path comes out of the store, but check it anyway: a bundle is device-supplied
    // data, and one that escaped the images directory would be a file-read primitive.
    const inside = resolve(path).startsWith(resolve(store.imagesDir));
    if (!inside || !existsSync(path)) return undefined;
    return readFileSync(path);
  } finally {
    store.close();
  }
}
