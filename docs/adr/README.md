# Architecture decisions

`docs/coherence.md` requires every product in the loop to keep an ADR trail, because an
autonomous agent that cannot read why a choice was made will relitigate it. Autopilot runs
on itself, so the rule applies here first.

One file per decision. Numbered, never renumbered, never deleted. A decision that turns out
wrong gets a new ADR that supersedes it, and the old one stays with a `Superseded by` line.

| ADR | Decision |
|---|---|
| [0001](0001-typescript-on-node.md) | TypeScript on Node, one runtime for the whole system |
| [0002](0002-claude-code-is-the-engineer.md) | The agent is `claude -p`, not a bespoke agent loop |
| [0003](0003-intake-lives-in-the-console.md) | Intake endpoints are routes in the console app |
| [0004](0004-sqlite-for-intake.md) | SQLite plus files on disk for bundles |
| [0005](0005-tracker-interface.md) | One `Tracker` interface, Linear and file implementations |
| [0006](0006-no-plans-directory.md) | The ordered work lives in Linear; ADRs hold the why |
| [0007](0007-structured-output-contract.md) | The prompts stay prose; the machine contract is appended by the runner |
| [0008](0008-runner-owns-the-gate.md) | The agent writes the code; the runner owns the gate, the merge and the deploy |
| [0009](0009-build-order-and-shape.md) | The thirteen picks that shaped the runnable loop |
