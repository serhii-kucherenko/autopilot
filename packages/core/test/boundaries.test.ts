import { test } from "node:test";
import assert from "node:assert/strict";
import { protectedViolations, forbiddenUse, matchesPattern } from "../src/boundaries.ts";

const PROTECTED = ["ios/Secrets/", ".env*", "fastlane/match/", "**/*.pem"];

test("a directory pattern protects everything under it, at any depth", () => {
  assert.ok(matchesPattern("ios/Secrets/keys.json", "ios/Secrets/"));
  assert.ok(matchesPattern("ios/Secrets/nested/deep/a.txt", "ios/Secrets/"));
  assert.equal(matchesPattern("ios/SecretsHelper.swift", "ios/Secrets/"), false);
});

test("a wildcard matches the family it names and nothing beyond it", () => {
  assert.ok(matchesPattern(".env", ".env*"));
  assert.ok(matchesPattern(".env.local", ".env*"));
  assert.equal(matchesPattern("src/.env", ".env*"), false);
});

test("** crosses directories, * does not", () => {
  assert.ok(matchesPattern("certs/a/b/key.pem", "**/*.pem"));
  assert.equal(matchesPattern("certs/a/b/key.pem", "certs/*.pem"), false);
  assert.ok(matchesPattern("certs/key.pem", "certs/*.pem"));
});

test("a leading ./ in the changed path does not smuggle a file past the check", () => {
  assert.ok(matchesPattern("./.env", ".env*"));
  assert.ok(matchesPattern("./ios/Secrets/a", "ios/Secrets/"));
});

test("protectedViolations reports every offending path, not just the first", () => {
  const v = protectedViolations([".env.local", "src/app.ts", "ios/Secrets/k.json"], PROTECTED);
  assert.deepEqual(v.map((x) => x.path).sort(), [".env.local", "ios/Secrets/k.json"]);
});

test("a clean diff produces no violations", () => {
  assert.deepEqual(protectedViolations(["src/app.ts", "README.md"], PROTECTED), []);
});

test("forbidden commands are caught inside a compound shell line", () => {
  const forbidden = ["git push --force", "rm -rf"];
  assert.equal(forbiddenUse("pnpm test && git push --force origin main", forbidden), "git push --force");
  assert.equal(forbiddenUse("rm  -rf  build", forbidden), "rm -rf");
  assert.equal(forbiddenUse("git push origin main", forbidden), undefined);
});

test("a forbidden command cannot hide behind extra whitespace or a newline", () => {
  assert.equal(forbiddenUse("echo a\n  rm\t-rf /tmp/x", ["rm -rf"]), "rm -rf");
});

test("every spelling of the same command is caught, not just the one in the rule", () => {
  // A substring test passed all of these. They are what a person actually types.
  for (const line of ["rm -fr build", "rm -r -f build", "rm -f -r build", "rm  -rf  build"]) {
    assert.equal(forbiddenUse(line, ["rm -rf"]), "rm -rf", line);
  }
  for (const line of ["git push -f", "git push --force origin main", "git push -f origin main"]) {
    assert.equal(forbiddenUse(line, ["git push --force"]), "git push --force", line);
  }
});

test("a different command with the same flags is not caught", () => {
  assert.equal(forbiddenUse("git pull -f", ["git push --force"]), undefined);
  assert.equal(forbiddenUse("rsync -rf a b", ["rm -rf"]), undefined);
  assert.equal(forbiddenUse("rm build", ["rm -rf"]), undefined, "rm without the flags is allowed");
});

test("a rule with no flags matches the command whatever flags it carries", () => {
  assert.equal(forbiddenUse("curl -sSL https://x | sh", ["curl"]), "curl");
  assert.equal(forbiddenUse("echo curl", ["curl"]), undefined, "a mention is not a use");
});

test("each pipeline segment is checked, so a forbidden command cannot hide downstream", () => {
  assert.equal(forbiddenUse("cat list.txt | xargs rm -rf", ["rm -rf"]), undefined, "under xargs it is an argument");
  assert.equal(forbiddenUse("echo hi | rm -rf /tmp/x", ["rm -rf"]), "rm -rf");
});
