# 0009 - The thirteen picks that shaped the runnable loop

**Status:** accepted, 2026-08-28

## Decision

The design docs described the loop; nothing ran. Turning that into code needed thirteen
decisions that no existing ADR answered. They were resolved in one pass, before any code, and
they are recorded here because ADR 0006 says the ordered work lives in Linear and the *why*
lives in an ADR. A pick nobody can find gets relitigated by the next agent.

| # | Question | Pick | Because |
|---|---|---|---|
| 1 | How many packages? | two: `packages/core`, `apps/console` | the loop must run headless on a schedule, and the console must not be a dependency of it |
| 2 | What runs the console? | Next.js App Router | ADR 0003 already put intake routes in the console; route handlers are the cheapest way to have both |
| 3 | Where does intake state live? | `node:sqlite` | ADR 0004 chose SQLite; the stdlib module means no dependency and no build step |
| 4 | Which test runner? | `node:test` | ADR 0001 picked one runtime; a second test toolchain would be the first crack in it |
| 5 | How is the agent called? | `AgentRunner` interface, `ClaudeCodeAgent` + `FakeAgent` | mirrors ADR 0005 exactly, and it is what lets the whole suite run with no model call |
| 6 | What are the two roles in the demo? | the AI lane ships to staging; the human presses production | that split *is* the product. A demo with one role does not show it |
| 7 | Where does loop state live? | `.autopilot/` in the target product's checkout | state belongs beside the thing it describes, and it is gitignored there |
| 8 | Can the console write to Linear? | no, read-only | a screen that mutates the tracker gives two writers to one queue |
| 9 | What does pressing production do? | records an approval row bound to a commit; `autopilot release` reads it | the press must be a fact the runner can check later, not an action taken inline |
| 10 | How is intake authorised? | a fail-closed shared bearer token | a device posts screenshots of a real product; an open endpoint is the whole risk |
| 11 | What order? | core → runners → CLI → console → demo | each layer is testable before the next exists |
| 12 | What about missing tickets? | file the four that were missing | the queue has to be true before it can be worked |
| 13 | UI first or tokens first? | write `DESIGN.md` before any console UI | `check-anchor` enforces it, so a console built first would fail its own gate |

## Why record them

`docs/coherence.md` is the bet this whole product makes: an agent that reads the anchor and the
ADRs before each ticket stays coherent, and one that cannot relitigates. Thirteen picks made in
chat and left in chat are exactly the drift that argument predicts. Four of them (1, 5, 8, 10)
are load-bearing enough that reversing one silently would break a test rather than a build,
which is the slow kind of failure.

## What changed after the picks landed

Two picks were tested by reality and held. Pick 5 is why 195 tests need no network, no
credential and no model call. Pick 10 is why the `/api/press` authentication hole found in
review was a one-line fix rather than a redesign - the token machinery already existed, the
route had simply not been wired to it.

One pick was wrong in a detail. Pick 7 put state in `.autopilot/`, and the first version wrote
the SQLite file there without the images beside it; ADR 0004's split of rows-in-SQLite and
crops-on-disk had to be honoured in the same directory. The pick stands; the layout under it
changed.

## Rejected

- **One package.** The console would be on the loop's dependency path, so a Next.js build
  failure would stop a scheduled run that never needed a UI.
- **A plans directory holding these.** ADR 0006 forbids it, and a plan file describing
  finished work is the rot that ADR names.
