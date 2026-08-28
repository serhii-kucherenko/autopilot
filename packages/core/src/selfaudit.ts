/**
 * The self-audit runner. This is how the loop refills its own work instead of idling
 * (`docs/architecture.md`, layer 4).
 *
 * Two limits are enforced here rather than trusted to the prompt, because both failure
 * modes are the kind an agent talks itself into:
 * - at most five tickets per run. A hundred tickets nobody works drowns the human's real
 *   requests, which is worse than an idle loop.
 * - AI lane only. Direction is not the loop's to invent, so a finding that arrives marked
 *   `human` is refused, not quietly relabelled.
 */

import type { Config } from "./config.ts";
import type { AgentRunner } from "./agent.ts";
import { loadPrompt, renderPrompt } from "./agent.ts";
import type { NewTicket, Ticket, Tracker } from "./tracker.ts";
import { outputContract, parseReply, requireString, optionalString, ReplyError } from "./reply.ts";

export const MAX_FINDINGS_PER_AUDIT = 5;

const AUDIT_SHAPE = `
{
  "findings": [
    {
      "title": "one line, what is wrong",
      "priority": 3,
      "where": "path/to/file.ts:42",
      "evidence": "the failing test name, the log line, the raw value - never \\"consider refactoring\\"",
      "doneWhen": "observable and checkable"
    }
  ],
  "nothingToDo": false,
  "note": "omit unless there is something the human should know about the audit itself"
}
`;

export interface SelfAuditResult {
  created: Ticket[];
  nothingToDo: boolean;
  note?: string;
  raw: string;
}

export interface SelfAuditOptions {
  config: Config;
  tracker: Tracker;
  agent: AgentRunner;
  dryRun?: boolean;
}

export async function runSelfAudit(options: SelfAuditOptions): Promise<SelfAuditResult> {
  const { config, tracker, agent } = options;
  const open = await tracker.listOpen();

  const prompt = [
    renderPrompt(loadPrompt("self-audit"), { product_name: config.product.name }),
    "---",
    "## The open backlog, so you do not file a duplicate",
    open.length === 0
      ? "The backlog is empty."
      : open.map((t) => `- ${t.id} [${t.lane}, p${t.priority}] ${t.title}`).join("\n"),
    "---",
    "## The anchor",
    config.product.anchors.map((a) => `- \`${a}\``).join("\n"),
    "---",
    "## Limits this runner enforces",
    [
      `At most ${MAX_FINDINGS_PER_AUDIT} findings. More than that is refused outright, not truncated.`,
      "Every finding is filed in the AI lane. If something needs a product decision it is not a finding; put it in `note` and the digest will carry it.",
      "Every finding needs `where` and `evidence`. A finding without them is refused.",
    ].join("\n\n"),
    outputContract(AUDIT_SHAPE),
  ].join("\n\n");

  const result = await agent.run({
    prompt,
    cwd: config.repo.root,
    // Self-audit reads and reports. It never writes code.
    allowedTools: ["Read", "Grep", "Glob", "Bash"],
    permissionMode: "plan",
  });

  if (!result.ok) {
    throw new Error(`self-audit agent failed (exit ${result.exitCode}): ${result.stderr ?? result.text}`);
  }

  const reply = parseReply<{ findings?: unknown; nothingToDo?: unknown; note?: unknown }>(result.text);
  const findings = Array.isArray(reply.findings) ? (reply.findings as Record<string, unknown>[]) : [];

  if (findings.length > MAX_FINDINGS_PER_AUDIT) {
    throw new ReplyError(
      `self-audit returned ${findings.length} findings; the limit is ${MAX_FINDINGS_PER_AUDIT}. ` +
        "Filing them all is how a backlog nobody works gets built.",
      result.text,
    );
  }

  const nothingToDo = findings.length === 0;
  const created: Ticket[] = [];

  for (const finding of findings) {
    if (finding.lane === "human") {
      throw new ReplyError(
        `self-audit tried to file "${String(finding.title)}" in the human lane. ` +
          "Direction is not the loop's to invent; that belongs in `note`.",
        result.text,
      );
    }

    const title = requireString(finding, "title", result.text);
    const where = requireString(finding, "where", result.text);
    const evidence = requireString(finding, "evidence", result.text);
    const doneWhen = optionalString(finding, "doneWhen");
    const rawPriority = finding.priority;
    const priority =
      typeof rawPriority === "number" && rawPriority >= 1 && rawPriority <= 4 ? Math.round(rawPriority) : 3;

    const ticket: NewTicket = {
      title,
      description: [
        `**Where**\n\n\`${where}\``,
        `**Evidence**\n\n${evidence}`,
        doneWhen ? `**Done when**\n\n${doneWhen}` : undefined,
        "_Filed by the self-audit, not by a person._",
      ]
        .filter(Boolean)
        .join("\n\n"),
      lane: "ai",
      priority,
      labels: ["self-audit"],
    };

    if (options.dryRun) {
      created.push({
        id: `(dry-run ${created.length + 1})`,
        title,
        description: ticket.description,
        lane: "ai",
        priority,
        state: "Backlog",
        stateType: "backlog",
        labels: ["self-audit"],
        blockedBy: [],
        createdAt: new Date().toISOString(),
      });
    } else {
      created.push(await tracker.create(ticket));
    }
  }

  const out: SelfAuditResult = { created, nothingToDo, raw: result.text };
  const note = optionalString(reply, "note");
  if (note) out.note = note;
  return out;
}
