# 0001 - TypeScript on Node, one runtime for the whole system

**Status:** accepted, 2026-08-28

## Decision

The runnable parts of Autopilot are TypeScript on Node 22+, in a pnpm workspace. No second
language anywhere in this repo.

## Why

The system touches four things, and one runtime covers all four:

| Piece | What it needs |
|---|---|
| intake | an HTTP server |
| triage / engineer runners | spawn a subprocess, read JSON, read PNGs |
| console (the MVP bar) | React, which means Node regardless |
| config validation | JSON Schema tooling |

The console has to exist and has to be React, so Node is already in the stack. Adding
Python for the runners would mean two dependency trees, two test commands and two CI jobs
for no capability the loop actually needs.

## Rejected

- **Python for the runners.** Better at nothing here, and it splits the repo in two.
- **Bash.** The bundle format is nested JSON with base64 images. Parsing that in `jq` is
  how a script becomes unmaintainable.

## Consequences

`pnpm` is a hard prerequisite for running Autopilot. The existing CI schema job stays
Python (`check-jsonschema`) because it is a self-contained contract check and rewriting it
buys nothing.
