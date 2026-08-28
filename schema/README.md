# Adding a product

A product joins the loop with three things:

1. a **repo** with an anchor (`DESIGN.md`, `docs/adr/`, a vision doc),
2. a **Linear project**,
3. an **`autopilot.config.json`** at the repo root, validated against
   [`autopilot.config.schema.json`](autopilot.config.schema.json).

Nothing in `prompts/` changes. That is the whole repeatability claim: the prompts and the
loop are generic, and this file is the only place a product differs.

See [`example.reco.json`](example.reco.json) for a filled-in one.

## The fields that matter most

| Field | Why it matters |
|---|---|
| `product.anchors` | what the engineer reads before planning. Get this wrong and coherence degrades |
| `gate.commands` | the only thing standing between an autonomous merge and a broken staging |
| `environments.production.requiresHumanApproval` | keep it `true` until canary and auto-rollback exist |
| `boundaries.protectedPaths` | what the loop may never touch, no matter what a ticket says |
| `boundaries.maxTicketsInFlight` | start at 1. Raise it only once the loop has proven itself on this codebase |
