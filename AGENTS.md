# Autopilot - agent instructions

`project_tracker: linear`

The ordered list of work lives in the [Linear project](https://linear.app/serhii-kucherenko/project/autopilot-0e1846433181).
Do not create a ROADMAP.md or a plans directory here: two lists mean two truths and both rot.

## What this is
The system that runs an engineering org where AI builds and the human reviews. This repo
holds the flow, the prompts, the integrations and the per-product config. Open source, MIT.
It is meant to be adopted by other teams, so nothing here may be specific to one codebase -
product-specific facts belong in that product's `autopilot.config.json`.

## Rules
- Every design decision that is settled gets written down, with the reason. A cold agent
  must not have to relitigate it.
- Prompts are the product. Keep them short, concrete, and free of hedging. Every rule in a
  prompt exists because a specific failure mode happened or is expected; say which.
- Diagrams are mermaid, inline in the markdown. No external image files.
- No product name, repo path, or credential in this repo. If an example needs one, it goes
  in `schema/example.*.json` and is clearly an example.
