# Architecture

Six layers. Each owns one job. Most map to tools that already exist, which is the point:
the new work is wiring and the coherence anchor, not a platform.

```mermaid
flowchart TB
    subgraph I["2 · Ingestion"]
        I1["conversational"]
        I2["Loupe annotation"]
        I3["self-audit"]
    end
    subgraph X["3 · The Engineer"]
        X1["one agent per ticket<br/>spawns sub-agents when work fans out"]
    end
    subgraph S["1 · State backbone"]
        S1["Linear: backlog + work state"]
        S2["repo: code, DESIGN.md, ADRs, config"]
        S3["memory: product vision, preferences"]
    end
    C["4 · Continuity engine<br/><i>scheduled, never idle</i>"]
    R["5 · Review loop<br/><i>digest, feedback, prod gate</i>"]
    G["6 · Guardrails<br/><i>flags, quality gate, staging-only</i>"]

    I --> S1
    S --> X1
    C --> X1
    X1 --> G
    G --> R
    R --> S1
```

## 1. State backbone

The memory that survives every agent run. Without it, each cycle starts blind and the
product drifts.

| Store | Owns | Never holds |
|---|---|---|
| Linear | the ordered work, states, priorities, lanes | how it is built |
| repo | code, `DESIGN.md`, ADRs, `autopilot.config.json` | the work queue |
| memory | product vision, human preferences, standing decisions | anything derivable from the repo |

One fact, one home. Two lists mean two truths and both rot.

## 2. Ingestion

Turns anything a human says or an agent notices into a well-formed ticket. Covered in
`docs/flow.md` and `docs/annotation.md`.

## 3. The Engineer

One agent takes a ticket and plays product, architect, coder and reviewer in sequence.
Sub-agents are spawned only when work genuinely fans out, for example independent files or
a parallel test sweep.

Why not a standing org of role agents: coherent context in one head beats handoffs between
several. Parallelism comes from running more tickets at once, each self-contained, not from
more standing roles. If a bottleneck later proves otherwise, add exactly one standing role
and keep the evidence.

## 4. Continuity engine

A scheduled loop that keeps pulling the next unblocked ticket. On an empty backlog it runs
a self-audit to refill rather than idling. This is the "keeps working between your touches"
property, and it is the difference between a helpful agent and an org.

## 5. Review loop

Batches staged work into a digest, collects the human's response, and turns feedback back
into tickets. The loop closes here.

## 6. Guardrails

What makes maximum autonomy safe:

- everything merges behind a feature flag,
- everything deploys to staging, never production,
- the quality gate blocks a bad merge (tests, lint, `DESIGN.md` conformance, review),
- the human holds the only production key.

To go fully autonomous later, the missing pieces are canary release and automatic
rollback. Not before.
