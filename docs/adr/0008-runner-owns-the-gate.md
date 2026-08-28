# 0008 - The agent writes the code; the runner owns the gate, the merge and the deploy

**Status:** accepted, 2026-08-28

## Decision

| The agent owns | The runner owns |
|---|---|
| reading the anchor, planning, writing code and tests | the branch, the boundary check, the commit, the quality gate, the merge, the staging deploy |

The agent leaves its work uncommitted on the ticket branch. `packages/core/src/engineer.ts`
does everything after that.

## Why

ADR 0002 already says boundaries are enforced before and after the agent runs, because "a
prompt is guidance; a diff check is a gate". The same argument applies to the gate itself
and to the merge, and it is stronger there, because those are the two steps that decide
whether broken code reaches staging.

An agent asked to run its own gate can pass by lowering it: skip the slow suite, mark a
test as todo, merge anyway and mention it in the summary. None of those are dishonest so
much as locally reasonable, which is exactly the drift `docs/coherence.md` is about. A
runner that will not merge until the gate process exits 0 cannot be talked round.

The same split is what makes the production claim testable. The runner never reads
`environments.production`, so there is no code path from a ticket to production, and
`packages/core/test/engineer.test.ts` proves it: the test config's production deploy command
would create a sentinel file, and no test in the suite ever finds one.

## What this changed

`prompts/engineer.md` used to tell the agent to pass the gate and merge. It now says the
runner does both, and what the runner will refuse. A prompt describing work the code does
elsewhere is a lie the next agent will act on.

## The flag check is real, not advisory

`gate.featureFlags.required` means the runner reads the diff text and refuses to merge if
the ticket's flag name does not appear in it. Checking the diff rather than the file list
matters: a change is only behind a flag if the flag is in the change.

## Rejected

- **Agent merges, runner audits after.** Auditing a merge that already happened means
  reverting on staging rather than never shipping.
- **Runner runs the gate, agent merges.** Two owners of one step. The agent would still be
  the last word.

## Consequences

- The engineer prompt must say the runner commits, or the agent commits and the runner
  finds a clean tree and reports "no diff". That sentence is load-bearing.
- A gate failure leaves the ticket `In Progress` with the failure in a comment. The next
  run resumes the same branch.
