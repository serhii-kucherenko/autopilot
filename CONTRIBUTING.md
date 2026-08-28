# Contributing to Autopilot

Autopilot is mostly prose: the flow, the prompts, the integrations, and a config schema.
That makes contributing unusual, so this is worth reading before you open a pull request.

## What this repo is

A system for running an engineering loop where an AI builds and a human reviews. The
prompts **are** the product. A change to `prompts/engineer.md` changes how every autonomous
cycle behaves, so prompt changes get the same scrutiny as code, not less.

## The two hard rules

**1. Nothing here may be specific to one codebase.** Product-specific facts belong in that
product's `autopilot.config.json`, never in a prompt or a doc. If you find yourself writing
"in our repo the tests are run with...", that belongs in the config schema instead.

**2. Every rule in a prompt earns its place.** Prompts accumulate hedging and generic advice
if nobody pushes back. A new rule should exist because a specific failure happened or is
clearly expected, and the prompt should make that reason visible. "Be careful" is not a rule.
"Never widen the ticket; something you notice becomes a new ticket" is.

## Local checks

There is no build. The only executable content is the JSON schema:

```bash
python3 -m pip install --user check-jsonschema
check-jsonschema --schemafile schema/autopilot.config.schema.json schema/example.*.json
```

CI runs the same thing. If you change the schema, update the example in the same pull
request, or CI will tell you.

## Conventions

- **Diagrams are mermaid, inline in the markdown.** No external image files: they rot, and
  they cannot be diffed.
- **No credentials, product names, or repo paths.** If an example needs one, it goes in
  `schema/example.*.json` and is obviously an example.
- **A settled decision gets written down with its reason.** The point is that a cold agent,
  or a cold human, does not relitigate it. The four settled decisions are in the README.
- Plain sentences. Short words. This repo is read by people whose first language is not
  English, and by models that do better without ornament.

## Proposing a change to a settled decision

Fine to do, but say what changed in the world rather than restating the trade-off. The
decisions were made with the alternatives in view, so "have you considered X" is usually
already answered in `docs/`. New evidence is the thing that moves them.

`docs/coherence.md` ends with what would falsify its central bet. That is the shape a good
challenge takes.

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
