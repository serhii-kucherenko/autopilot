# 0005 - One `Tracker` interface, Linear and file implementations

**Status:** accepted, 2026-08-28

## Decision

The runners talk to a `Tracker` interface. Two implementations ship:

- `LinearTracker` - Linear's GraphQL API over `fetch`, authenticated with `LINEAR_API_KEY`.
- `FileTracker` - one JSON file. Used by the tests and the seeded demo.

`integrations/README.md` still holds: Linear owns the real queue, and nothing mirrors it.
`FileTracker` is not a second tracker; it is a fake, and it never points at a live product.

## Why an interface at all

Normally an interface with one implementation is waste. Here there are genuinely two, and
the second one is what makes the demo and the test suite runnable without a network call or
a credential. A contributor who clones this repo can run the whole loop offline.

## Why raw GraphQL and not `@linear/sdk`

Autopilot needs six operations: list issues, get issue, create issue, update state, add
comment, list labels. Six queries is about 150 lines of `fetch`. The SDK is a large
dependency, a generated client and a version to track, for those six calls.

## Why an API key and not the Linear MCP server

The continuity engine wakes on a schedule with nobody watching. An OAuth flow that needs a
browser cannot work there. An API key in the environment can. Interactive agents may still
use the MCP server; the runner does not depend on it.

## Consequences

`LINEAR_API_KEY` is required to run against a real product. `autopilot doctor` says so
plainly, with the URL to create one.
