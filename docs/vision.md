# What Autopilot is for

An engineering org where the AI builds and the human reviews.

One person gives ideas and feedback and presses production. Autopilot plays product, architect,
engineer and reviewer, and keeps shipping to staging behind flags between that person's touches.
The work continues while nobody is watching, and every change waits behind one human press.

The measure of success is not how much code the loop writes. It is whether the tenth ticket
looks like it was built by whoever built the first, and whether a person who was away for a day
can catch up from one message.

## What it refuses to be

**A merge bot.** The loop that writes the code does not decide whether the code is good enough.
The runner owns the gate, the merge and the deploy, and it will not lower any of them (ADR 0008).
There is no `--force`, no retry-until-green, no warn-instead-of-fail.

**A path to production.** Nothing autonomous reaches production, ever. The runner never reads
`environments.production`, a config that tries to turn the human approval off is refused at load,
and a test proves no code path exists by giving the test config a production deploy that would
leave a sentinel file behind - which no test in the suite ever finds. The claim is a test, not a
promise.

**A second tracker.** There is one ordered queue and it lives in the tracker. No `ROADMAP.md`, no
plans directory, no mirrored task list (ADR 0006). Two lists mean two truths and both rot.

**A feature factory.** On an empty backlog the loop looks for work worth doing and is allowed to
find none. Manufacturing work to look busy is the failure the self-audit exists to prevent, and an
idle loop is a correct outcome.

**A thing you have to visit.** A digest that only exists on a screen somebody must open is a
digest nobody reads. Silence when nothing happened, one message when something did.

**Able to lower its own bar.** When Autopilot builds Autopilot, the gate, the boundary check,
the engineer runner, the release path and the prompts are all out of bounds to the agent. The
loop cannot edit the code that decides whether the loop may ship, and it cannot rewrite the
instructions it is judged by. A human changes those.

**Cleverer than its anchor.** Every ticket is planned against `DESIGN.md`, `CONTEXT.md`, the
decision trail and this file. An agent that cannot read why a choice was made will relitigate it,
so the anchor is loaded before the plan, every time, and extended in the same change that outgrows
it.
