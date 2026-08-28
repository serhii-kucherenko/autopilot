# Autopilot - agent instructions

`project_tracker: linear`

The ordered list of work lives in the [Linear project](https://linear.app/serhii-kucherenko/project/autopilot-0e1846433181).
Do not create a ROADMAP.md or a plans directory here: two lists mean two truths and both rot.

## What this is
The system that runs an engineering org where AI builds and the human reviews. This repo
holds the flow, the prompts, the integrations and the per-product config. Open source, MIT.
It is meant to be adopted by other teams, so nothing here may be specific to one codebase -
product-specific facts belong in that product's `autopilot.config.json`.

## Layout
- `packages/core` - the runnable loop. `src/cli.ts` is the entry point; one file per stage.
- `apps/console` - the screens, and the four intake endpoints as route handlers (ADR 0003).
- `DESIGN.md` - how the console looks. Named tokens only, and `pnpm check-anchor` fails on a
  value that is not in it. Extend it in the same change that uses a new value.
- `pnpm verify` - lint, typecheck, tests, anchor check. Run it before saying anything works.

## Rules
- Every design decision that is settled gets written down, with the reason. A cold agent
  must not have to relitigate it.
- **No parameter properties in TypeScript.** Node strips types without transforming them, so
  `constructor(private readonly x)` dies with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. Write the
  field and the assignment out.
- **Never locate a file with `import.meta`.** `apps/console` bundles `packages/core`, and a
  bundler both fails on `new URL(..., import.meta.url)` and leaves `import.meta.dirname`
  undefined. Use `src/paths.ts`, which walks up for the checkout.
- Anything the runners can reach must have a fake, so the whole loop runs with no credential
  and no network. That is what `pnpm demo` proves, and CI runs it.
- Prompts are the product. Keep them short, concrete, and free of hedging. Every rule in a
  prompt exists because a specific failure mode happened or is expected; say which.
- Diagrams are mermaid, inline in the markdown. No external image files.
- No product name, repo path, or credential in this repo. If an example needs one, it goes
  in `schema/example.*.json` and is clearly an example.
