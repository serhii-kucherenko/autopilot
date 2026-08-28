# 0011 - The loop cannot quiet its own checks

**Status:** accepted, 2026-08-28

## Decision

When the product being built is Autopilot itself, the agent may not edit the code that decides
whether the loop may ship: the boundary check, the gate, the engineer runner, the release path,
or the prompts it is judged by. Those are `boundaries.protectedPaths` in Autopilot's own config.

And nothing in a config narrows `check-anchor`. It scans everything its own skip list does not
already exclude. There is deliberately no `anchorCheck.exclude` field.

Both halves of that are the same rule: **a check the loop can turn down is not a check.**

## Why the first half

ADR 0008 argues that an agent asked to run its own gate can pass by lowering it - skip the slow
suite, mark a test todo, merge anyway - and that none of those are dishonest so much as locally
reasonable. That is why the runner owns the gate and the agent does not.

Self-hosting quietly undoes that argument. The agent's file tools are rooted in the product
repo, and when the product is Autopilot, the gate's source code is inside it. A weakened
`boundaries.ts` would then be enforced by its own weakened copy, because the gate runs the tests
from the working tree it just changed. The first self-hosting config shipped without noticing
this: it protected secrets, workflows and `schema/**`, and left every enforcement file editable.

The agent can still extend `DESIGN.md`, `CONTEXT.md` and `docs/adr/`. That is not an oversight -
`prompts/engineer.md` requires it, and a test pins it, because an anchor nothing may extend is
an anchor that goes stale and gets ignored.

## Why the second half

Adding that protection dropped `check-anchor` from 44 files to 40 and said nothing about it.

The check had reused `boundaries.protectedPaths` as its exclude list, on the reasoning that out
of bounds for the loop is out of scope for the check. That reasoning held while the list held
secrets and build output, which carry no design tokens. It stopped holding the instant
first-party source joined the list. Whether the agent may edit a file and whether the file has
to keep the design system are two different questions, and one field cannot answer both.

A replacement `anchorCheck.exclude` field was written and then deleted. Every tree it would have
skipped is either already in the check's own `SKIPPED_DIRECTORIES` or does not exist in the repo
whose config named it: `public/pdfjs/`, `ios/Secrets/` and `fastlane/match/` are all absent from
Reco's checkout, and Reco reports the same 127 violations with the exclude and without it. A
config field with no user is one more lever for making a checker go quiet, which is the failure
this ADR is about.

## The trade-off, stated

Autopilot can never improve its own gate, boundary check, runner, release path or prompts through
its own loop. A person edits those by hand.

That is the cost and it is the right one. Those five files are where the human-reviews half of
this product actually lives, and an autonomous change to them is a change to what "reviewed"
means. Everything else in the repo - the tracker adapters, triage, the digest, the console, the
anchor check's own heuristics - stays open to the loop, which is most of it.

## How it is verified

By removal, not by assumption. The test reads the real `autopilot.config.json` rather than a
fixture, because the hole was in the shipped file and a fixture would have passed while the real
one was wrong. Stripping the protection makes the suite exit 1; restoring it exits 0.

## Rejected

- **Protect nothing and rely on the prompt.** ADR 0002 already settled this: a prompt is
  guidance, a diff check is a gate.
- **Protect the whole of `packages/core/`.** Then the loop could improve nothing about itself,
  and self-hosting would be theatre rather than the honest first test.
- **Keep the exclude coupling and simply not protect source.** That trades a silent checker for
  a lowerable gate. The gate is worth more.
