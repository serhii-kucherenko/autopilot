/**
 * The executor. ADR 0002: every prompt in `prompts/` is run by the Claude Code CLI in
 * headless mode. Autopilot supplies the prompt, the variables and the boundaries, and
 * does not implement a model loop.
 *
 * Swapping the executor later touches only this file. That is the whole reason it exists
 * as one narrow interface with a fake beside it.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { promptPath } from "./paths.ts";

export class PromptError extends Error {
  override name = "PromptError";
}

export type PromptName = "triage" | "engineer" | "digest" | "self-audit";

export function loadPrompt(name: PromptName): string {
  try {
    return readFileSync(promptPath(name), "utf8");
  } catch {
    throw new PromptError(`no prompt named ${name} in prompts/`);
  }
}

/**
 * Fill `{{variable}}` placeholders. Both directions are errors:
 * a placeholder left unfilled would be sent to the model literally, and a variable
 * nobody used means the prompt was edited and the caller was not updated.
 */
export function renderPrompt(template: string, vars: Record<string, string | number>): string {
  const used = new Set<string>();
  const out = template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    if (!(key in vars)) throw new PromptError(`prompt variable {{${key}}} was not provided`);
    used.add(key);
    return String(vars[key]);
  });
  const unused = Object.keys(vars).filter((k) => !used.has(k));
  if (unused.length > 0) {
    throw new PromptError(`prompt does not use these variables: ${unused.join(", ")}`);
  }
  return out;
}

export interface AgentRequest {
  prompt: string;
  /** The product repo. The agent's file tools are rooted here, never at Autopilot. */
  cwd: string;
  allowedTools?: string[];
  timeoutMs?: number;
  /** Passed through to the CLI. `acceptEdits` is the loop default; a read-only runner uses `plan`. */
  permissionMode?: "acceptEdits" | "plan" | "default";
  env?: Record<string, string>;
}

export interface AgentResult {
  ok: boolean;
  text: string;
  exitCode: number;
  stderr?: string;
}

export interface AgentRunner {
  run(request: AgentRequest): Promise<AgentResult>;
}

export function claudeArgs(request: AgentRequest): string[] {
  const args = ["-p", "--permission-mode", request.permissionMode ?? "acceptEdits"];
  if (request.allowedTools?.length) args.push("--allowed-tools", request.allowedTools.join(","));
  return args;
}

export const DEFAULT_AGENT_TIMEOUT_MS = 45 * 60 * 1000;

export class ClaudeCodeAgent implements AgentRunner {
  private readonly bin: string;

  constructor(bin = process.env.AUTOPILOT_CLAUDE_BIN ?? "claude") {
    this.bin = bin;
  }

  run(request: AgentRequest): Promise<AgentResult> {
    return new Promise((resolve) => {
      const child = spawn(this.bin, claudeArgs(request), {
        cwd: request.cwd,
        env: { ...process.env, ...request.env },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let out = "";
      let err = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, request.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (out += chunk));
      child.stderr.on("data", (chunk: string) => (err += chunk));

      child.on("error", (cause) => {
        clearTimeout(timer);
        resolve({
          ok: false,
          text: "",
          exitCode: 127,
          stderr: `cannot run \`${this.bin}\`: ${cause.message}. Run \`autopilot doctor\`.`,
        });
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({ ok: false, text: out, exitCode: 124, stderr: "agent timed out" });
          return;
        }
        resolve({ ok: code === 0, text: out.trim(), exitCode: code ?? 1, stderr: err.trim() });
      });

      // ADR 0002: the prompt goes on stdin, so its length is not an argv limit.
      child.stdin.end(request.prompt);
    });
  }
}

/**
 * One scripted turn. `effect` is what makes the fake honest: a real agent changes files,
 * so a fake that only returns text would let the runner pass a test it would fail against
 * a real diff. The demo's fake writes actual code with it.
 */
export type FakeStep =
  | string
  | { text: string; ok?: boolean; effect?: (cwd: string) => void | Promise<void> };

/**
 * Scripted agent. This is what makes the whole loop runnable offline with no credential
 * and no model call - the same reason `FileTracker` exists (ADR 0005).
 */
export class FakeAgent implements AgentRunner {
  readonly requests: AgentRequest[] = [];
  private readonly script: FakeStep[];
  private index = 0;

  constructor(script: FakeStep[] = []) {
    this.script = script;
  }

  async run(request: AgentRequest): Promise<AgentResult> {
    this.requests.push(request);
    const step = this.script[this.index++];
    if (step === undefined) {
      return {
        ok: false,
        text: `FakeAgent script exhausted after ${this.index - 1} replies`,
        exitCode: 1,
      };
    }
    if (typeof step === "string") return { ok: true, text: step, exitCode: 0 };

    await step.effect?.(request.cwd);
    const ok = step.ok ?? true;
    return { ok, text: step.text, exitCode: ok ? 0 : 1 };
  }
}
