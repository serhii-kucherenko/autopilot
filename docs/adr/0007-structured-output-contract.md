# 0007 - The prompts stay prose; the machine contract is appended by the runner

**Status:** accepted, 2026-08-28

## Decision

Every file in `prompts/` stays plain markdown written for a reader. The JSON shape a runner
parses is appended at render time by `packages/core/src/reply.ts`, and the parser that
reads it back lives in the same file.

Runners read the agent's **last** fenced `json` block.

## Why

Two forces pull in opposite directions. `AGENTS.md` says the prompts are the product and
must stay short and concrete. The runners need a machine-readable answer, or the tickets
have to be written by the model calling an API, which ADR 0005 rules out.

Appending the contract satisfies both. A person reviewing `prompts/triage.md` reads
judgment rules, not a schema. A runner still gets structured data. And the shape lives next
to the code that parses it, so the two cannot drift - which they would immediately if the
shape were pasted into four prompt files.

**The last block, not the first.** An agent that thinks out loud often quotes the shape it
was given before filling it in. Taking the first block parses the example and files a
ticket titled "one line, what changes". This happened in testing and is why the rule is
written down.

## Rejected

- **The shape inside each prompt file.** Four copies to keep in step with one parser.
- **A tool call.** Would tie Autopilot to one executor's tool protocol, which ADR 0002
  deliberately keeps swappable.
- **Parsing prose.** No.

## Consequences

- An agent that prints no JSON block is a hard failure, never a silent empty run.
- Adding a field to a reply shape means editing one file.
