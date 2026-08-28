/**
 * The triage runner: bundles or a sentence in, tickets out.
 *
 * `prompts/triage.md` does the judgment - merging duplicates, splitting a comment that
 * carries two problems, resolving the code context from the trace. This file does none of
 * that. It assembles what the prompt is given, and writes what the prompt decided through
 * the `Tracker`, so the same run works against Linear or against the offline fake.
 */

import type { Bundle } from "./bundle.ts";
import type { Config } from "./config.ts";
import type { AgentRunner } from "./agent.ts";
import { loadPrompt, renderPrompt } from "./agent.ts";
import type { Lane, NewTicket, Ticket, Tracker } from "./tracker.ts";
import type { Store } from "./store.ts";
import { outputContract, parseReply, requireString, optionalString, ReplyError } from "./reply.ts";

const TRIAGE_SHAPE = `
{
  "tickets": [
    {
      "title": "one line, what changes, in the user's words not the system's",
      "lane": "ai",
      "priority": 2,
      "context": "the resolved chain, endpoint through schema",
      "evidence": "the crop filenames, the trace lines, console errors, build sha",
      "theirWords": "the annotation verbatim, never paraphrased away",
      "doneWhen": "observable, checkable without asking the person",
      "fromAnnotations": ["annotation-id"],
      "labels": ["bug"]
    }
  ],
  "linkedToExisting": [
    { "ticket": "SER-123", "why": "same underlying problem as annotation-id" }
  ],
  "question": "omit this field unless the work genuinely cannot start without an answer"
}
`;

export interface TriageInput {
  bundles?: Bundle[];
  /** Conversational capture: free-form voice or text, same prompt, same rules. */
  text?: string;
}

export interface TriageResult {
  created: Ticket[];
  linkedToExisting: { ticket: string; why: string }[];
  question?: string;
  /** The agent's full answer, kept so a bad run is diagnosable. */
  raw: string;
  /** Bundles skipped because they were already triaged and acked. */
  alreadyTriaged: string[];
}

interface RawTicket {
  title?: unknown;
  lane?: unknown;
  priority?: unknown;
  labels?: unknown;
  [key: string]: unknown;
}

function lane(value: unknown): Lane {
  return value === "human" ? "human" : "ai";
}

function priority(value: unknown): number {
  return typeof value === "number" && value >= 0 && value <= 4 ? Math.round(value) : 3;
}

/** The ticket body, in the order `prompts/triage.md` specifies. */
export function ticketDescription(raw: RawTicket): string {
  const parts: string[] = [];
  const context = optionalString(raw, "context");
  const evidence = optionalString(raw, "evidence");
  const theirWords = optionalString(raw, "theirWords");
  const doneWhen = optionalString(raw, "doneWhen");

  if (theirWords) parts.push(`**Their words**\n\n> ${theirWords.split("\n").join("\n> ")}`);
  if (context) parts.push(`**Context**\n\n${context}`);
  if (evidence) parts.push(`**Evidence**\n\n${evidence}`);
  if (doneWhen) parts.push(`**Done when**\n\n${doneWhen}`);

  const from = Array.isArray(raw.fromAnnotations) ? (raw.fromAnnotations as unknown[]) : [];
  if (from.length > 0) {
    parts.push(`Filed from annotation${from.length > 1 ? "s" : ""} ${from.join(", ")}.`);
  }
  return parts.join("\n\n");
}

/** What the prompt is shown about each annotation. The crop is referenced, not inlined. */
function describeBundles(bundles: Bundle[]): string {
  return bundles
    .map((b) => {
      const header = [
        `### Session ${b.sessionID}`,
        `App: ${b.app.name}${b.app.platform ? ` on ${b.app.platform}` : ""}`,
        b.app.commitSHA ? `Build: ${b.app.commitSHA}` : undefined,
        b.app.environment ? `Environment: ${b.app.environment}` : undefined,
      ]
        .filter(Boolean)
        .join("\n");

      const annotations = b.annotations.map((a, i) => {
        const lines = [`#### Annotation ${i + 1} - id \`${a.id}\``, `Comment: ${a.comment}`];
        if (a.tag) lines.push(`Tag: ${a.tag}`);
        if (a.screen) lines.push(`Screen: ${a.screen}`);
        if (a.element) {
          const el = a.element;
          lines.push(
            `Element: ${[el.accessibilityID, el.label, el.className].filter(Boolean).join(" / ") || "(unnamed)"}`,
          );
        }
        if (a.screenshotPath) lines.push(`Crop: ${a.screenshotPath} (read it, it shows what they meant)`);
        else if (a.screenshotBase64) lines.push("Crop: inline in this bundle");
        else lines.push("Crop: none - locate the element yourself");

        if (a.trace.length > 0) {
          lines.push(
            "Network trace, which pins the real endpoints:",
            ...a.trace.map(
              (t) =>
                `  ${t.method} ${t.url}${t.statusCode ? ` -> ${t.statusCode}` : ""}${t.durationMs ? ` (${t.durationMs}ms)` : ""}`,
            ),
          );
        } else {
          lines.push("Network trace: empty - do not invent an endpoint");
        }
        if (a.console.length > 0) {
          lines.push("Console:", ...a.console.map((c) => `  [${c.level}] ${c.message}`));
        }
        return lines.join("\n");
      });

      return [header, ...annotations].join("\n\n");
    })
    .join("\n\n");
}

function describeBacklog(open: Ticket[]): string {
  if (open.length === 0) return "The backlog is empty.";
  return open
    .map((t) => `- ${t.id} [${t.lane}, p${t.priority}, ${t.state}] ${t.title}`)
    .join("\n");
}

export interface TriageOptions {
  config: Config;
  tracker: Tracker;
  agent: AgentRunner;
  input: TriageInput;
  dryRun?: boolean;
  /**
   * When given, a bundle that has already been acked is skipped rather than triaged again.
   *
   * This is what makes `autopilot triage <dir>` safe to re-run. The ack was already the only
   * marker of "drained", but nothing consulted it on the way in, so running triage twice on
   * the same session filed every ticket a second time. The device-generated `sessionID` is
   * exactly what ADR 0004 says makes a retry safe; this is the read side of that.
   */
  store?: Store;
}

export async function runTriage(options: TriageOptions): Promise<TriageResult> {
  const { config, tracker, agent, input, store } = options;
  const offered = input.bundles ?? [];

  if (offered.length === 0 && !input.text) {
    throw new Error("triage needs a bundle or some text; it was given neither");
  }

  // Skip what has already been drained, so a re-run is a no-op rather than a duplicate.
  const alreadyTriaged = store
    ? offered.filter((b) => store.get(b.sessionID)?.ackedAt).map((b) => b.sessionID)
    : [];
  const bundles = offered.filter((b) => !alreadyTriaged.includes(b.sessionID));

  if (offered.length > 0 && bundles.length === 0) {
    return { created: [], linkedToExisting: [], raw: "", alreadyTriaged };
  }

  const annotationCount = bundles.reduce((n, b) => n + b.annotations.length, 0);

  const open = await tracker.listOpen();
  const body = renderPrompt(loadPrompt("triage"), {
    product_name: config.product.name,
    annotation_count: annotationCount || 1,
  });

  const given = [
    body,
    "---",
    "## What came in",
    bundles.length > 0 ? describeBundles(bundles) : `The person said, in their own words:\n\n> ${input.text}`,
    "---",
    "## The open backlog",
    describeBacklog(open),
    "---",
    "## This product's config",
    "```json",
    JSON.stringify(config, null, 2),
    "```",
    outputContract(TRIAGE_SHAPE),
  ].join("\n\n");

  const result = await agent.run({
    prompt: given,
    cwd: config.repo.root,
    // Triage never writes code. Narrowing the tools is cheaper than trusting the prompt.
    allowedTools: ["Read", "Grep", "Glob", "Bash"],
    permissionMode: "plan",
  });

  if (!result.ok) {
    throw new Error(`triage agent failed (exit ${result.exitCode}): ${result.stderr ?? result.text}`);
  }

  const reply = parseReply<{
    tickets?: unknown;
    linkedToExisting?: unknown;
    question?: unknown;
  }>(result.text);

  const rawTickets = Array.isArray(reply.tickets) ? (reply.tickets as RawTicket[]) : [];
  if (rawTickets.length === 0 && !reply.question) {
    throw new ReplyError("triage produced no tickets and no question", result.text);
  }

  /*
   * Every ticket is validated before any is created.
   *
   * Validating inside the write loop meant a reply whose third ticket lacked a title left the
   * first two already filed in Linear while the run reported failure - and a re-run filed them
   * a second time. Nothing here writes until the whole reply is known to be usable.
   */
  const planned: NewTicket[] = rawTickets.map((raw) => {
    const ticket: NewTicket = {
      title: requireString(raw, "title", result.text),
      description: ticketDescription(raw),
      lane: lane(raw.lane),
      priority: priority(raw.priority),
    };
    const labels = Array.isArray(raw.labels)
      ? (raw.labels as unknown[]).filter((l): l is string => typeof l === "string")
      : [];
    if (labels.length > 0) ticket.labels = labels;
    return ticket;
  });

  const created: Ticket[] = [];
  for (const ticket of planned) {
    if (options.dryRun) {
      created.push({
        id: `(dry-run ${created.length + 1})`,
        title: ticket.title,
        description: ticket.description,
        lane: ticket.lane,
        priority: ticket.priority,
        state: "Backlog",
        stateType: "backlog",
        labels: ticket.labels ?? [],
        blockedBy: [],
        createdAt: new Date().toISOString(),
      });
    } else {
      created.push(await tracker.create(ticket));
    }
  }

  const linked = Array.isArray(reply.linkedToExisting)
    ? (reply.linkedToExisting as { ticket?: unknown; why?: unknown }[]).flatMap((l) =>
        typeof l.ticket === "string" ? [{ ticket: l.ticket, why: String(l.why ?? "") }] : [],
      )
    : [];

  const out: TriageResult = { created, linkedToExisting: linked, raw: result.text, alreadyTriaged };
  if (typeof reply.question === "string" && reply.question.trim() !== "") {
    out.question = reply.question.trim();
  }
  return out;
}
