/**
 * How an agent's answer becomes data (ADR 0007).
 *
 * The prompts in `prompts/` stay plain markdown, because that is what makes them
 * reviewable. The machine-readable contract is appended by the runner at render time and
 * lives here, next to the parser that reads it back. One place to change, and the prompt
 * a human reads is never cluttered with a JSON schema.
 */

export class ReplyError extends Error {
  override name = "ReplyError";
  readonly raw: string;
  constructor(message: string, raw: string) {
    super(message);
    this.raw = raw;
  }
}

/**
 * Build the output contract to append to a prompt. `shape` is shown to the agent
 * verbatim, so it must read as an example rather than as a schema language.
 */
export function outputContract(shape: string): string {
  return `
---

## Output

When you are finished, print one fenced \`json\` block and nothing after it. It is the only
part of your answer another program reads, so everything a later stage needs must be in it.
Prose before the block is fine and is kept for the record.

\`\`\`json
${shape.trim()}
\`\`\`
`;
}

/**
 * Pull the last fenced JSON block out of an agent's answer.
 *
 * The *last* one, deliberately: an agent that thinks out loud often quotes the shape it
 * was given before filling it in, and taking the first block would parse the example.
 */
export function parseReply<T>(text: string): T {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n?```/g)];
  if (fences.length === 0) {
    throw new ReplyError("the agent printed no fenced json block", text);
  }
  const body = fences[fences.length - 1]![1]!;
  try {
    return JSON.parse(body) as T;
  } catch (cause) {
    throw new ReplyError(`the agent's json block does not parse: ${(cause as Error).message}`, body);
  }
}

/** Read a required string field, failing loudly rather than shipping an empty ticket. */
export function requireString(source: Record<string, unknown>, key: string, raw: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ReplyError(`the agent's json is missing \`${key}\``, raw);
  }
  return value.trim();
}

export function optionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
