import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPrompt, loadPrompt, FakeAgent, claudeArgs, PromptError } from "../src/agent.ts";

test("renderPrompt fills every variable the prompt names", () => {
  const out = renderPrompt("You are triage for {{product_name}} with {{annotation_count}}.", {
    product_name: "Reco",
    annotation_count: 3,
  });
  assert.equal(out, "You are triage for Reco with 3.");
});

test("an unfilled variable throws instead of shipping {{...}} to the model", () => {
  assert.throws(() => renderPrompt("for {{product_name}}", {}), PromptError);
  assert.throws(() => renderPrompt("for {{product_name}}", {}), /product_name/);
});

test("an extra variable nobody used throws, because it means the prompt was renamed", () => {
  assert.throws(() => renderPrompt("no vars here", { product_name: "Reco" }), /product_name/);
});

test("the same variable twice is filled twice", () => {
  assert.equal(renderPrompt("{{a}} and {{a}}", { a: "x" }), "x and x");
});

test("loadPrompt reads the real prompts, so a rename breaks the build not the loop", () => {
  for (const name of ["triage", "engineer", "digest", "self-audit"] as const) {
    assert.ok(loadPrompt(name).length > 200, `${name} prompt looks empty`);
  }
  assert.throws(() => loadPrompt("nope" as never), /nope/);
});

test("FakeAgent replies from its script and records what it was asked", async () => {
  const agent = new FakeAgent(["first", "second"]);
  const a = await agent.run({ prompt: "one", cwd: "/tmp" });
  const b = await agent.run({ prompt: "two", cwd: "/tmp" });
  assert.equal(a.text, "first");
  assert.equal(b.text, "second");
  assert.equal(a.ok, true);
  assert.deepEqual(agent.requests.map((r) => r.prompt), ["one", "two"]);
});

test("FakeAgent running out of script is a failure, not a silent empty answer", async () => {
  const agent = new FakeAgent(["only one"]);
  await agent.run({ prompt: "a", cwd: "/tmp" });
  const second = await agent.run({ prompt: "b", cwd: "/tmp" });
  assert.equal(second.ok, false);
  assert.match(second.text, /script/i);
});

test("the claude argv is headless and carries the working directory, never a tty", () => {
  const args = claudeArgs({ prompt: "hello", cwd: "/repo" });
  assert.ok(args.includes("-p"), "must run headless");
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
  assert.ok(args.includes("--permission-mode"));
});

test("allowedTools narrows the agent when a runner asks it to", () => {
  const args = claudeArgs({ prompt: "x", cwd: "/repo", allowedTools: ["Read", "Grep"] });
  const i = args.indexOf("--allowed-tools");
  assert.ok(i >= 0);
  assert.equal(args[i + 1], "Read,Grep");
});
