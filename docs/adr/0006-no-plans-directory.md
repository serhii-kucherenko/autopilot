# 0006 - The ordered work lives in Linear; ADRs hold the why

**Status:** accepted, 2026-08-28

## Decision

This repo has no `ROADMAP.md` and no plans directory. The ordered list of work is the Linear
project. The reasoning behind each decision is an ADR here.

## Why

`AGENTS.md` already forbids a second list, and `docs/architecture.md` gives the rule: one
fact, one home. A plan document restates the queue, then drifts from it, and then two
agents believe different things.

What a plan document is genuinely good at - why a choice was made and what was rejected -
is exactly what an ADR is for, and `docs/coherence.md` already requires ADRs.

## Consequences

- Tickets are created by `scripts/seed-linear.mts`, which is a one-shot seeder, not a
  standing list. It is idempotent by title so re-running it does not duplicate.
- An agent asking "what is next" reads Linear, never this repo.
