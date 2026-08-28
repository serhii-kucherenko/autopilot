/**
 * The boundary check, enforced by Autopilot rather than by trusting the prompt.
 *
 * ADR 0002: "a prompt is guidance; a diff check is a gate". Everything here runs on the
 * real diff after the agent finishes, and on the real command line before a gate command
 * runs. Nothing here asks the agent whether it behaved.
 */

export interface Violation {
  path: string;
  pattern: string;
}

function normalise(path: string): string {
  return path.replace(/^\.\//, "").replace(/^\/+/, "");
}

/**
 * Glob subset, chosen to cover exactly what `boundaries.protectedPaths` needs:
 * a trailing `/` protects a whole subtree, `*` stays inside one segment, `**` crosses.
 */
export function matchesPattern(path: string, pattern: string): boolean {
  const p = normalise(path);
  const pat = normalise(pattern);

  if (pat.endsWith("/")) return p === pat.slice(0, -1) || p.startsWith(pat);

  const rx = pat
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map((part) => {
      if (part === "**/") return "(?:[^/]+/)*";
      if (part === "**") return ".*";
      if (part === "*") return "[^/]*";
      if (part === "?") return "[^/]";
      return part.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    })
    .join("");

  return new RegExp(`^${rx}$`).test(p);
}

export function protectedViolations(changedPaths: string[], patterns: string[]): Violation[] {
  const violations: Violation[] = [];
  for (const path of changedPaths) {
    const pattern = patterns.find((p) => matchesPattern(path, p));
    if (pattern) violations.push({ path, pattern });
  }
  return violations;
}

/**
 * Whether a shell line uses a forbidden command. Whitespace in the line is collapsed
 * first, so `rm  -rf` and `rm\t-rf` cannot slip past a check written as `rm -rf`.
 */
export function forbiddenUse(command: string, forbidden: string[]): string | undefined {
  const flat = command.replace(/\s+/g, " ");
  return forbidden.find((f) => flat.includes(f.replace(/\s+/g, " ")));
}

export class BoundaryError extends Error {
  override name = "BoundaryError";
  readonly violations: Violation[];
  constructor(message: string, violations: Violation[] = []) {
    super(message);
    this.violations = violations;
  }
}

/** Throw if a diff touched anything out of bounds. Called after the agent runs. */
export function assertDiffInBounds(changedPaths: string[], patterns: string[]): void {
  const violations = protectedViolations(changedPaths, patterns);
  if (violations.length === 0) return;
  const lines = violations.map((v) => `  ${v.path} (matches protected ${v.pattern})`);
  throw new BoundaryError(
    `the agent touched protected paths, so nothing was merged:\n${lines.join("\n")}`,
    violations,
  );
}

/** Throw if a command is out of bounds. Called before the command runs. */
export function assertCommandAllowed(command: string, forbidden: string[]): void {
  const hit = forbiddenUse(command, forbidden);
  if (hit) throw new BoundaryError(`command refused, it uses the forbidden \`${hit}\`: ${command}`);
}
