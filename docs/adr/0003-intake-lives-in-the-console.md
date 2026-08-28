# 0003 - Intake endpoints are routes in the console app

**Status:** accepted, 2026-08-28

## Decision

The four endpoints in `docs/intake.md` are Next.js route handlers inside `apps/console`,
not a separate service.

## Why

`docs/intake.md` said "small enough to be one file". It is. A separate deployable would
mean a second process, a second auth story and a second thing to keep alive, and the
console needs to read the same bundles to show them.

One app, one deploy, one token. The seam that actually matters is the bundle format, and
that is unchanged.

## Rejected

- **A standalone Express service.** Nothing needs it and it doubles the operational surface.
- **A serverless function.** Bundles carry screenshots and need durable storage; a stateless
  function pushes the state somewhere else without removing it.

## Consequences

Running intake means running the console. That is acceptable: a setup that captures
annotations but has nowhere to review them is not a setup anyone wants.
