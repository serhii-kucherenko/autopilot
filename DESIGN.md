# DESIGN.md

How Autopilot's console looks. Named tokens only.

This file is the anchor `docs/coherence.md` describes, and Autopilot is the first product
that has to keep it. **A colour, font or spacing value that is not in this file does not
exist**: `autopilot check-anchor` reads the tables below, scans the code, and fails on
anything it did not find here. Extend this file in the same change that uses a new value,
or the check will refuse the change (`docs/coherence.md` rule 2).

Tokens live in one place: [`apps/console/app/tokens.css`](apps/console/app/tokens.css).
Every value there appears in a table here.

## The register

A console the human opens after being away, to read what the loop did and decide what
ships. It should read like an instrument panel, not a marketing page.

| | |
|---|---|
| Genre | modern-minimal - developer tool |
| Theme | Cobalt: cool engineered paper, cool charcoal ink, one electric cobalt signal |
| Structure | Workbench - the real data is the content. No hero, no mockups, no marketing sections |
| Navigation | flush bordered bar, four destinations, a ⌘K palette that really opens |
| Depth | hairlines, not shadows. Exactly two shadows exist, both listed below |
| Motion | three primitives. A console is composed, not animated |

Cobalt ships light-only. This console has both themes: it is opened at night, and the
light/dark contract is part of the anchor.

## Colour

`--accent` is a **signal**, under 5 % of any viewport: the active nav item, one primary
button, focus rings, a live status. Never a background flood, never a gradient.

### Light (`:root`)

| Token | Value | Used for |
|---|---|---|
| `--color-paper` | `oklch(98.5% 0.004 250)` | page ground |
| `--color-paper-2` | `oklch(96.5% 0.006 252)` | raised surface: rows, cards, the bar |
| `--color-paper-3` | `oklch(94% 0.008 252)` | hover and pressed surface |
| `--color-ink` | `oklch(24% 0.02 258)` | headings, primary text |
| `--color-ink-2` | `oklch(34% 0.018 257)` | body text |
| `--color-ink-3` | `oklch(52% 0.014 256)` | meta, labels, waiting states |
| `--color-rule` | `oklch(89% 0.008 252)` | every hairline |
| `--color-rule-strong` | `oklch(82% 0.01 252)` | a border that must be seen |
| `--color-accent` | `oklch(58% 0.2 256)` | the one signal |
| `--color-accent-hover` | `oklch(50% 0.19 256)` | its hover and active |
| `--color-accent-wash` | `oklch(95% 0.03 256)` | accent chip ground, at most one per row |
| `--color-graphite` | `oklch(22% 0.016 260)` | code and trace surfaces |
| `--color-graphite-2` | `oklch(27% 0.016 260)` | their inner rules and bars |
| `--color-graphite-ink` | `oklch(93% 0.008 250)` | text on graphite |
| `--color-ok` | `oklch(58% 0.13 155)` | shipped, released, passed |
| `--color-ok-wash` | `oklch(95% 0.03 155)` | its chip ground |
| `--color-danger` | `oklch(55% 0.19 25)` | gate failed, out of bounds, agent failed |
| `--color-danger-wash` | `oklch(95% 0.035 25)` | its chip ground |

### Dark (`[data-theme="dark"]`, and `prefers-color-scheme: dark` by default)

Same token names, same roles. Only the values change, so nothing in the app branches on
theme.

| Token | Value |
|---|---|
| `--color-paper` | `oklch(17% 0.014 260)` |
| `--color-paper-2` | `oklch(21% 0.015 260)` |
| `--color-paper-3` | `oklch(25% 0.016 260)` |
| `--color-ink` | `oklch(95% 0.006 250)` |
| `--color-ink-2` | `oklch(84% 0.008 252)` |
| `--color-ink-3` | `oklch(64% 0.012 254)` |
| `--color-rule` | `oklch(31% 0.014 258)` |
| `--color-rule-strong` | `oklch(40% 0.014 258)` |
| `--color-accent` | `oklch(70% 0.17 256)` |
| `--color-accent-hover` | `oklch(78% 0.15 256)` |
| `--color-accent-wash` | `oklch(28% 0.06 256)` |
| `--color-graphite` | `oklch(13% 0.012 260)` |
| `--color-graphite-2` | `oklch(19% 0.014 260)` |
| `--color-graphite-ink` | `oklch(90% 0.008 250)` |
| `--color-ok` | `oklch(72% 0.15 155)` |
| `--color-ok-wash` | `oklch(26% 0.05 155)` |
| `--color-danger` | `oklch(68% 0.17 25)` |
| `--color-danger-wash` | `oklch(28% 0.06 25)` |

**Not allowed:** pure `#fff` or `#000`. Gradients on text or buttons. Glassmorphism. A
second accent hue. Any colour above used as a full-bleed background except `--color-paper`,
`--color-paper-2` and `--color-graphite`.

### The status vocabulary

Four states, and no more. Status colour here is information, not decoration, which is why
the palette carries two hues beyond the accent.

| State | Token | Meaning |
|---|---|---|
| good | `--color-ok` | shipped to staging, released, gate passed |
| bad | `--color-danger` | gate failed, out of bounds, agent failed |
| needs you | `--color-accent` | an anchor conflict, a blocker, a build awaiting your press |
| waiting | `--color-ink-3` | in the backlog, nothing happening yet |

A chip is `1px` of its hue, its hue as text, and its wash as ground. Never a solid block of
colour.

## Type

Three faces. Every one has a real fallback stack, because the demo must run offline and a
missing webfont must not change the layout.

| Token | Stack | Used for |
|---|---|---|
| `--font-display` | `'Space Grotesk', 'Helvetica Neue', Arial, sans-serif` | headings, 500/600, tracking `-0.02em` |
| `--font-body` | `Inter, system-ui, 'Segoe UI', Roboto, sans-serif` | everything readable, 400/500/600 |
| `--font-mono` | `'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace` | ids, commits, traces, code, UPPERCASE labels |

Headings are always roman. No italic display type anywhere; italic survives only as
emphasis inside a running paragraph.

Labels and meta are `--font-mono`, UPPERCASE, `0.06em` tracking. That machine-readout voice
against the Space Grotesk display is the theme's signature.

### Scale

| Token | Value | Used for |
|---|---|---|
| `--text-xs` | `0.64rem` | mono labels, kbd hints |
| `--text-sm` | `0.8rem` | meta, chips, table cells |
| `--text-base` | `1rem` | body |
| `--text-md` | `1.25rem` | row titles, card headings |
| `--text-lg` | `1.5625rem` | screen heading |
| `--text-xl` | `1.9531rem` | the one number a screen leads with |
| `--text-2xl` | `2.4414rem` | reserved. Nothing uses it yet |

There is no display size. A console has no hero.

Any number a person compares - counts, durations, commits - sets
`font-variant-numeric: tabular-nums`.

## Spacing

4 pt base, nine steps, named by role.

| Token | Value |
|---|---|
| `--space-3xs` | `0.125rem` |
| `--space-2xs` | `0.25rem` |
| `--space-xs` | `0.5rem` |
| `--space-sm` | `0.75rem` |
| `--space-md` | `1rem` |
| `--space-lg` | `1.5rem` |
| `--space-xl` | `2.5rem` |
| `--space-2xl` | `4rem` |
| `--space-3xl` | `6rem` |

`1px` and `2px` are allowed literally, for a border and a focus ring. Nothing else off the
scale.

## Radii, rules, elevation

| Token | Value | Used for |
|---|---|---|
| `--radius-sm` | `4px` | chips, kbd |
| `--radius-md` | `6px` | buttons, inputs, rows |
| `--radius-lg` | `10px` | cards, the graphite surfaces, the palette |
| `--radius-round` | `999px` | status dots only |
| `--rule-hair` | `1px` | every border |
| `--rule-focus` | `2px` | the focus ring |
| `--shadow-lift` | `0 1px 2px oklch(24% 0.02 258 / 0.06)` | the graphite card, and nothing else |
| `--shadow-overlay` | `0 8px 32px oklch(24% 0.02 258 / 0.14)` | the ⌘K palette, and nothing else |

Depth comes from borders. Those two shadows are the complete list; a third is a bug.

## Motion

| Token | Value |
|---|---|
| `--dur-micro` | `120ms` |
| `--dur-short` | `220ms` |
| `--dur-long` | `420ms` |
| `--ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` |
| `--ease-in` | `cubic-bezier(0.7, 0, 0.84, 0)` |
| `--ease-in-out` | `cubic-bezier(0.65, 0, 0.35, 1)` |

Three primitives, and no fourth:

1. **underline-grow** - a link's cobalt underline grows from the left on hover.
2. **border-shift** - a focusable surface's `1px` border moves to `--color-accent`.
3. **palette-fade** - the ⌘K overlay fades and rises 4px.

Only `transform` and `opacity` animate. Never `transition: all`. Never a bounce or
overshoot easing. Under `prefers-reduced-motion: reduce`, everything is static and fully
visible - the focus ring already never animates.

No scroll reveals. This is an app; its content is there when you open it.

## Interaction

Every control ships eight states: default, hover, `:focus-visible`, active, disabled,
loading, error, success.

- **The focus ring is visible and instant.** `--rule-focus` of `--color-accent`, offset
  2px, at or above 3:1 against its ground.
- **Nothing is hover-only.** Every action is readable and reachable without a pointer.
- **Reversible actions do not ask.** Sending feedback, acking a bundle: do it, show the
  result, offer undo where it applies.
- **The production press does ask**, and it is the only thing that does. It is the one
  irreversible action in the product, so a confirmation there is correct rather than
  clutter. It states the ticket and the commit being released.
- **Success is quiet.** The row changes to its new state. No celebratory toast.

## Copy

- Say what is now true, not what the system did. "Search ranks by recency", not "merged
  the ranking refactor".
- Name the destination on a button. "Press production", not "Confirm".
- Mono for anything a person will copy: ticket ids, commit shas, flag names, paths.
- Real ellipsis (…) and real en dashes. Never `...` or `--`.
- Never invent a number. A count with no data is `—`, not a plausible figure.

## What the console must never do

- **Write to Linear.** It reads the queue and shows it. The runners are the only writers,
  so there is one writer and one truth (`docs/architecture.md`).
- **Deploy anything.** The press records an approval. `autopilot release` deploys, and only
  with an approval matching the exact commit.
- **Show a screenshot of itself, a fake browser frame, or a mocked terminal.** The real
  bundles, traces and diffs are the content.
