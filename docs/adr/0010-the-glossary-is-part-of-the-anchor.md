# 0010 - The glossary is part of the anchor

**Status:** accepted, 2026-08-28

## Decision

`CONTEXT.md` at a product's root is the product's vocabulary: a glossary, nothing else. It is in
the default anchor, so every ticket loads it, and the engineer prompt tells the agent to use its
words and to treat a term listed under `_Avoid_` as already rejected.

A new product created by `autopilot init` is therefore told it should have one, and `autopilot
doctor` warns until it does - the same treatment `DESIGN.md`, `docs/adr/` and the vision already
get.

## Why

`docs/coherence.md` names three things that drift and says the anchor is what stops them: how the
product looks, why it was built that way, and what it is for. It did not name the fourth, which is
what things are called.

Naming drift is cheaper to cause than the other three and harder to see. Nobody decides to have two
words for one thing; the second word arrives in one ticket, and every ticket after it picks whichever
word it read first. Autopilot had this in its own code on the day it was written: a helper called
`park` was called for four failure statuses that are explicitly not parked, and the comment above it
told the reader that a failed ticket goes back to the backlog. The code never did that, ADR 0008
requires the opposite, and a test proved the code right. The comment was wrong in the direction that
matters: an agent trusting it would have "fixed" the code and broken resume.

Two words for one thing produced a document that lied about the code. That is exactly the failure
`docs/coherence.md` exists to prevent, so the glossary belongs in the same anchor as the rest.

## The trade-off

Putting it in the *default* anchor means every new product is told it needs a file it may not want,
and `doctor` warns until it exists. That warning is the cost, and it is deliberate.

The alternative - only anchoring it for products that opt in - was rejected because it inverts who
carries the effort. A product that never hears about a glossary does not grow one, and by the time
the vocabulary has drifted enough to notice, the code already carries both words and the fix is a
rename across a codebase rather than a line in a file.

`doctor` reports it as a warning and not a MISS, so nothing is blocked. A product that genuinely
does not want one deletes the entry from its own anchor list, which is one line and is a decision
that product has then actually made.

## What `CONTEXT.md` is not

It is a glossary. Not a spec, not a scratch pad, not a place for architecture or file paths - those
are `docs/`, `DESIGN.md` and these ADRs. A glossary that grows into a second architecture document
rots the same way a duplicated plan does, and then nobody reads either.

## Rejected

- **Put the vocabulary in `DESIGN.md`.** `DESIGN.md` is enforced by `check-anchor`, which compares
  declared values against used values. Prose terms are not checkable that way, and mixing them in
  would make its findings noisier for no gain.
- **Generate the glossary from the code.** The useful half of a glossary is the `_Avoid_` list, and
  a rejected word is by definition not in the code.
