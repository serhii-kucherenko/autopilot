# Autopilot

An engineering loop where the AI builds and the human reviews. The AI ships to staging behind
a flag, unattended, between a person's touches; the person presses production.

This file is the shared language, and nothing else. It holds no plan, no architecture and no
file paths - those live in `docs/`, `DESIGN.md` and `docs/adr/`. It exists because this product's
central bet (`docs/coherence.md`) is that an agent which reads the same words as the last agent
does not drift. Two words for one thing is how that bet is lost.

## Language

### The two actors

**Agent**:
The coding model, running headless for one ticket. It reads, plans, writes code and tests, and
stops. It commits nothing and deploys nothing.
_Avoid_: AI, bot, model, Claude, assistant

**Runner**:
The Autopilot code around the agent. It owns the branch, the boundary check, the commit, the
gate, the merge and the staging deploy - every step where a prompt could talk its way past a
rule.
_Avoid_: orchestrator, harness, driver, framework

### Capture

**Annotation**:
One piece of feedback on a running product: what a person said, where they were, and what they
were looking at.
_Avoid_: note, remark, issue

**Bundle**:
Everything one annotation session produced, uploaded as a single unit and identified by that
session.
_Avoid_: report, batch, payload, submission

**Crop**:
The picture belonging to an annotation. Sensitive, because it is a photograph of a running
product, and deleted when its bundle is.
_Avoid_: screenshot, image, attachment

**Drain**:
Taking bundles that intake has not yet handed on, oldest first.
_Avoid_: fetch, poll, pull, dequeue

**Ack**:
The mark that a bundle has been dealt with. It is the only thing that ends a bundle's life, and
retention is counted from it. Uploading twice does not ack; triaging does.
_Avoid_: consume, complete, resolve, close

### Work

**Ticket**:
One unit of work, held in the tracker, which is the single ordered queue.
_Avoid_: issue, task, story, card

**Lane**:
Who a ticket belongs to: the AI or the human. Carried as a label so a person can move a ticket
between lanes without asking anyone.
_Avoid_: assignee, owner, queue, swimlane

**Parked**:
A ticket the runner handed back because it cannot go further without a person - the anchor
forbids it, the agent produced nothing, or the way forward is a decision. It returns to the
backlog.
_Avoid_: deferred, skipped, on hold

**Failed**:
A run that broke rather than a ticket that needs a person: the gate did not pass, the agent
errored, the diff went out of bounds, the deploy failed. The ticket stays in flight so the next
run resumes the same branch. **Failed is not parked.** They are different words on purpose.
_Avoid_: broken, errored, blocked

### Self-hosting

**Self-hosting**:
Running the loop against Autopilot itself. The honest first test, because it needs nobody's
permission - and the case where the agent's reach includes the code that judges it.
_Avoid_: dogfooding, bootstrapping, eating our own

**Enforcement code**:
The five things the loop may not edit when it builds itself: the boundary check, the gate, the
engineer runner, the release path and the prompts. A check the loop can turn down is not a check.
_Avoid_: core, internals, the framework

### The anchor

**Anchor**:
The files every ticket is planned against: how the product looks, the decisions already made,
and what the product is for. An agent reads all of it before it plans.
_Avoid_: spec, context, guidelines, standards, docs

**Drift**:
Code, or a document, that has moved away from the anchor. Usually nobody decided it; it
accumulated.
_Avoid_: tech debt, inconsistency, rot

**Coherence**:
The property the anchor exists to protect: the tenth ticket looks like it was built by whoever
built the first.
_Avoid_: consistency, quality, standards

### The gate

**Gate**:
The commands that must every one exit 0 before anything merges. It is never lowered, never
forced and never partly run.
_Avoid_: CI, checks, tests, pipeline, validation

**Boundary**:
A rule checked against the real diff rather than stated in the prompt - paths that may not be
touched, commands that may not be run. A prompt is guidance; a boundary is a gate.
_Avoid_: rule, guardrail, restriction, policy

**Flag**:
The feature flag a change must sit behind, named after its ticket. A change is only behind a
flag if the flag appears in the change.
_Avoid_: toggle, switch, gate

### Shipping

**Staging**:
Where the loop ships, on its own, all day. Everything here is reversible.
_Avoid_: preview, dev, test environment

**Press**:
The human act of approving exactly one commit for production. It is the only gate a person
holds, and no code path reaches production without it.
_Avoid_: approve, sign off, ship, deploy, promote

**Approval**:
The record a press leaves behind, bound to one ticket and one commit. A later commit on the
same ticket is not approved.
_Avoid_: sign-off, permission, authorisation

**Release**:
Putting a pressed commit into production. It refuses to run without an approval for that exact
commit.
_Avoid_: deploy, promote, publish, ship

### The loop

**Wake**:
One scheduled start. A wake does one thing and stops; it does not run until the backlog is
empty.
_Avoid_: run, tick, job, invocation

**Cycle**:
One pass inside a wake: take the next ticket and run it, or, on an empty backlog, self-audit.
_Avoid_: iteration, pass, round

**Self-audit**:
What the loop does instead of idling on an empty backlog: look for work worth filing. Finding
nothing is a correct outcome, and manufacturing work is the failure it guards against.
_Avoid_: sweep, scan, housekeeping, maintenance

**Digest**:
The one message describing what reached staging, written for a person who was not watching.
Silence when nothing landed.
_Avoid_: report, summary, changelog, standup

**Rehearsal**:
A dry run. It prints the exact prompt the agent would receive, spends no model call and writes
nothing. It is how a person decides whether to trust the loop with a product before it touches
one.
_Avoid_: preview, simulation, test run
