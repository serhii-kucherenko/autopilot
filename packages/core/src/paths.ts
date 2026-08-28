/**
 * Where the Autopilot checkout is.
 *
 * `prompts/` and `schema/` are the product, so they live once at the repo root rather than
 * being copied into this package. Finding that root is fiddlier than it looks, and this file
 * exists because two obvious ways both broke:
 *
 * - `new URL("../../../prompts/", import.meta.url)` - a bundler reads the URL form as a
 *   module specifier and fails the build outright.
 * - `join(import.meta.dirname, "..", "..", "..")` - a bundler rewrites `import.meta`, so
 *   `dirname` arrives `undefined` at runtime and the path throws.
 *
 * `apps/console` imports this package, so both had to go. Walking up from the working
 * directory for the two directories that only exist at the root works everywhere: under
 * Node, under a bundler, from the repo root, from a package, and from the console.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export class LayoutError extends Error {
  override name = "LayoutError";
}

/** Both must be present. Either alone could be a coincidence in someone else's tree. */
const MARKERS = ["prompts", "schema"] as const;

function looksLikeRoot(dir: string): boolean {
  return MARKERS.every((marker) => existsSync(join(dir, marker)));
}

let cached: string | undefined;

export function repoRoot(startFrom = process.cwd()): string {
  if (cached) return cached;

  const override = process.env.AUTOPILOT_HOME;
  if (override) {
    const at = resolve(override);
    if (!looksLikeRoot(at)) {
      throw new LayoutError(
        `AUTOPILOT_HOME points at ${at}, which has no prompts/ and schema/ directories.`,
      );
    }
    cached = at;
    return at;
  }

  let dir = resolve(startFrom);
  for (;;) {
    if (looksLikeRoot(dir)) {
      cached = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new LayoutError(
    `cannot find the Autopilot checkout above ${resolve(startFrom)}. ` +
      "It is the directory holding prompts/ and schema/. Set AUTOPILOT_HOME to it.",
  );
}

/** Only for tests, which need to look up more than one tree in a single process. */
export function forgetRepoRoot(): void {
  cached = undefined;
}

export function promptPath(name: string): string {
  return join(repoRoot(), "prompts", `${name}.md`);
}

export function schemaPath(): string {
  return join(repoRoot(), "schema", "autopilot.config.schema.json");
}
