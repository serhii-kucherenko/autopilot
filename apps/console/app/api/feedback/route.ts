/**
 * `POST /api/feedback` - what the human says back, on its way to becoming tickets.
 *
 * `prompts/digest.md`: "Whatever they reply goes back through triage. Do not act on feedback
 * directly in a running ticket; let it become work in the queue."
 *
 * So this route does not run triage, and it does not touch a ticket. It writes the words down
 * with what they were about, and `autopilot say` picks them up. That keeps the console a
 * reader of the queue, never a writer of it.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { consoleAuthorised, storeRoot } from "../../../lib/server.ts";

export interface FeedbackLine {
  at: string;
  about?: string;
  text: string;
}

export async function POST(request: Request): Promise<Response> {
  // An unauthenticated append-only write is an unbounded file somebody else fills, and it
  // feeds `autopilot say`.
  const auth = consoleAuthorised(request);
  if (!auth.ok) return Response.json({ error: auth.why }, { status: 401 });

  let body: { text?: unknown; about?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "body is not JSON" }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return Response.json({ error: "say something first" }, { status: 400 });

  const line: FeedbackLine = { at: new Date().toISOString(), text };
  if (typeof body.about === "string" && body.about.trim() !== "") line.about = body.about.trim();

  const root = storeRoot();
  mkdirSync(root, { recursive: true });
  // Append-only JSONL: the human's exact words are the one thing nobody can reconstruct
  // later, so nothing here ever rewrites a line.
  appendFileSync(join(root, "feedback.jsonl"), `${JSON.stringify(line)}\n`);

  return Response.json({
    queued: true,
    next: "autopilot say - runs it through the same triage prompt and files the tickets",
  });
}
