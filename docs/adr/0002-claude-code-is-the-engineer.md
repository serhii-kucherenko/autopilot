# 0002 - The agent is `claude -p`, not a bespoke agent loop

**Status:** accepted, 2026-08-28

## Decision

Every prompt in `prompts/` is executed by shelling out to the Claude Code CLI in headless
mode (`claude -p`), with the prompt on stdin and the working directory set to the product
repo. Autopilot supplies the prompt, the variables and the boundaries. It does not
implement a model loop.

## Why

`prompts/engineer.md` asks the agent to read files, plan, write code, run the test suite,
open a branch and merge it. That is a coding agent. Claude Code already is one, with file
tools, git, bash, permission modes and subagents.

Building the same thing over the Messages API would mean re-implementing tool dispatch,
retries, context management and a permission model, and it would still be worse. The
laziest thing that works is the right thing, and here it is also the most capable.

The prompts stay plain markdown, which is what makes them reviewable and portable. Swapping
the executor later touches one file, `packages/core/src/agent.ts`.

## Rejected

- **Anthropic API plus a custom loop.** Months of work to rebuild an existing tool.
- **A Superset automation per runner.** Good for scheduling, but it would put the flow in a
  hosted config instead of in this repo, and the repo is the product.

## Consequences

- The Claude Code CLI is a runtime dependency. `autopilot doctor` checks for it.
- Boundaries (`boundaries.protectedPaths`, `forbiddenCommands`) are enforced by Autopilot
  *before* and *after* the agent runs, not by trusting the agent to obey the prompt. A
  prompt is guidance; a diff check is a gate.
