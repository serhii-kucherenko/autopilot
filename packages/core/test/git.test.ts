import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Git } from "../src/git.ts";
import { protectedViolations } from "../src/boundaries.ts";

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "ap-git-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "list.ts"), "a\n");
  writeFileSync(join(root, "README.md"), "# r\n");
  git("init", "-q", "-b", "main");
  git("config", "user.email", "git@autopilot.test");
  git("config", "user.name", "Autopilot");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  return root;
}

/*
 * `dirtyPaths` fed the boundary check the wrong path, and the boundary check is the thing
 * standing between an autonomous agent and a protected file.
 *
 * `git status --porcelain=v1 -z` writes ` M README.md` for a modified, unstaged file: two
 * status columns then a space. The helper trimmed the command's whole output before splitting,
 * which ate that leading space on the FIRST entry only, so its path came back one character
 * short - `EADME.md`. A one-character bug, in the one place a name has to match exactly.
 *
 * It failed closed, which is why nothing caught it: a second check after the commit still threw.
 * But it threw, rather than returning `out-of-bounds`, so the loop crashed instead of recording
 * the signal and commenting on the ticket - and a crash is not a measurement.
 */
test("dirtyPaths returns the real path of a modified file, not one missing its first letter", () => {
  const root = repo();
  writeFileSync(join(root, "README.md"), "# changed\n");
  assert.deepEqual(new Git(root).dirtyPaths(), ["README.md"]);
});

test("dirtyPaths is right whichever file comes first, and for every status column", () => {
  const root = repo();
  writeFileSync(join(root, "README.md"), "# changed\n");
  writeFileSync(join(root, "src", "list.ts"), "b\n");
  writeFileSync(join(root, "new.txt"), "untracked\n");
  const paths = new Git(root).dirtyPaths().sort();
  assert.deepEqual(paths, ["README.md", "new.txt", "src/list.ts"]);
});

test("a protected file is actually matched, which is the whole point of the path being right", () => {
  const root = repo();
  writeFileSync(join(root, "README.md"), "# changed\n");
  const violations = protectedViolations(new Git(root).dirtyPaths(), ["README.md"]);
  assert.deepEqual(violations.map((v) => v.path), ["README.md"]);
});

test("a clean tree is empty, not a list holding one blank string", () => {
  assert.deepEqual(new Git(repo()).dirtyPaths(), []);
});

test("a path with a space survives, because -z is why the helper uses it", () => {
  const root = repo();
  writeFileSync(join(root, "two words.md"), "x\n");
  assert.deepEqual(new Git(root).dirtyPaths(), ["two words.md"]);
});
