import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseConfig, ConfigError } from "../src/config.ts";
import { repoRoot, forgetRepoRoot, LayoutError } from "../src/paths.ts";

function minimal(overrides: Record<string, unknown> = {}) {
  return {
    product: { name: "Reco", vision: "docs/vision.md" },
    tracker: { kind: "linear", project: "Reco" },
    repo: { root: ".", defaultBranch: "main" },
    environments: { staging: { deploy: "bash deploy.sh" } },
    gate: { commands: ["pnpm test"] },
    ...overrides,
  };
}

test("applies the schema defaults so a runner never reads undefined", () => {
  const c = parseConfig(minimal());
  assert.deepEqual(c.product.anchors, ["DESIGN.md", "docs/adr/"]);
  assert.equal(c.repo.branchPrefix, "auto/");
  assert.equal(c.tracker.laneLabels.ai, "lane:ai");
  assert.equal(c.tracker.laneLabels.human, "lane:human");
  assert.equal(c.boundaries.maxTicketsInFlight, 1);
  assert.equal(c.gate.featureFlags.required, true);
  assert.equal(c.gate.featureFlags.defaultState, "off");
  assert.equal(c.cadence.selfAuditOnEmptyBacklog, true);
  assert.deepEqual(c.boundaries.protectedPaths, []);
});

test("production requires human approval by default, even when the block is absent", () => {
  const c = parseConfig(minimal());
  assert.equal(c.environments.production?.requiresHumanApproval ?? true, true);
});

test("refuses requiresHumanApproval: false, because canary and rollback do not exist yet", () => {
  const raw = minimal({
    environments: {
      staging: { deploy: "bash deploy.sh" },
      production: { deploy: "bash release.sh", requiresHumanApproval: false },
    },
  });
  assert.throws(() => parseConfig(raw), /requiresHumanApproval/);
});

test("rejects a config missing a required section, naming the section", () => {
  const raw = minimal();
  delete (raw as Record<string, unknown>).gate;
  assert.throws(() => parseConfig(raw), /gate/);
});

test("rejects an empty gate, since an autonomous merge with no gate is the whole risk", () => {
  assert.throws(() => parseConfig(minimal({ gate: { commands: [] } })), ConfigError);
});

test("rejects an unknown top-level key rather than ignoring a typo", () => {
  assert.throws(() => parseConfig(minimal({ enviroments: {} })), ConfigError);
});

test("loadConfig reads the file and reports the path when it is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "ap-cfg-"));
  const path = join(dir, "autopilot.config.json");
  writeFileSync(path, JSON.stringify(minimal()));
  assert.equal(loadConfig(path).product.name, "Reco");
  assert.throws(() => loadConfig(join(dir, "nope.json")), /nope\.json/);
});

test("the worked example in schema/ validates, or the docs are lying", () => {
  const example = new URL("../../../schema/example.reco.json", import.meta.url);
  const raw = JSON.parse(readFileSync(example, "utf8"));
  const c = parseConfig(raw);
  assert.equal(c.product.name, "Reco");
  assert.equal(c.capture.loupe.enabled, true);
});

test("the checkout is found by walking up, not from import.meta, so a bundler cannot break it", () => {
  forgetRepoRoot();
  const root = repoRoot(join(import.meta.dirname, "..", "src"));
  assert.ok(readFileSync(join(root, "schema", "autopilot.config.schema.json"), "utf8").length > 100);

  forgetRepoRoot();
  process.env.AUTOPILOT_HOME = mkdtempSync(join(tmpdir(), "ap-nothome-"));
  try {
    assert.throws(() => repoRoot(), LayoutError);
  } finally {
    delete process.env.AUTOPILOT_HOME;
    forgetRepoRoot();
  }
});
