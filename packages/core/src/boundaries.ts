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
 * One command line, split into its program and the set of short flag letters it carries.
 *
 * A plain substring test - what this used to be - is defeated by every spelling a person
 * actually types: `rm -fr`, `rm -r -f`, `git push -f`. Comparing the program plus the *set* of
 * flag letters catches all of those, which is what the documented guarantee needs.
 */
function shape(command: string): { program: string; flags: Set<string>; words: string[] } {
  const words = command.trim().split(/\s+/).filter(Boolean);
  const program = words[0] ?? "";
  const flags = new Set<string>();
  for (const word of words.slice(1)) {
    if (word.startsWith("--")) flags.add(word.slice(2));
    else if (word.startsWith("-") && word.length > 1) for (const letter of word.slice(1)) flags.add(letter);
  }
  return { program, flags, words };
}

/**
 * Whether a shell line uses a forbidden command.
 *
 * Each `&&`, `||`, `;` or `|` separated segment is compared against each rule by program plus
 * flags, so `rm -rf` also catches `rm -fr`, `rm  -r  -f` and `rm -r -f build`, and
 * `git push --force` also catches `git push -f`.
 */
export function forbiddenUse(command: string, forbidden: string[]): string | undefined {
  const segments = command.split(/&&|\|\||[;|\n]/);

  for (const rule of forbidden) {
    const wanted = shape(rule);
    if (wanted.program === "") continue;

    for (const segment of segments) {
      const seen = shape(segment);
      if (seen.program !== wanted.program) continue;

      // A rule's non-flag words after the program (`git push` in `git push --force`) must all
      // appear, in order, so `git pull` does not match a rule about `git push`.
      const wantedWords = wanted.words.slice(1).filter((w) => !w.startsWith("-"));
      const seenWords = seen.words.slice(1).filter((w) => !w.startsWith("-"));
      const wordsPresent = wantedWords.every((w, i) => seenWords[i] === w);
      if (!wordsPresent) continue;

      // `-f` and `--force` are the same intent, so a rule flag matches either spelling.
      const flagsPresent = [...wanted.flags].every(
        (flag) => seen.flags.has(flag) || seen.flags.has(flag[0]!) || [...seen.flags].some((f) => f[0] === flag[0]),
      );
      if (flagsPresent) return rule;
    }
  }
  return undefined;
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
