/**
 * A ticket description, parsed into blocks.
 *
 * The description is markdown, because the tracker renders markdown. Two ways to show it are
 * both wrong: a `<pre>` leaks `**Their words**` at the reader as literal asterisks, and a
 * markdown-to-HTML renderer would put device-supplied text through `dangerouslySetInnerHTML`
 * for the sake of two bits of emphasis.
 *
 * So this parses the small shape the runners actually produce, and `TicketBody.tsx` maps the
 * result to React elements. React escapes every string it renders and nothing in the console
 * uses `dangerouslySetInnerHTML`, so there is no injection surface. Anything unrecognised
 * falls through as plain text rather than disappearing.
 *
 * Plain TypeScript rather than living inside the component, for two reasons: Node's type
 * stripping cannot handle JSX, so a `.tsx` file is untestable in this repo's test runner; and
 * the parse is the part with the edge cases.
 *
 * ponytail: forty lines against a markdown dependency, and it cannot render an `<img onerror>`.
 * Upgrade path if a description ever needs tables or links: a real renderer with a sanitiser,
 * not a bigger regex.
 */

export type TicketBlock =
  | { kind: "label"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "aside"; text: string }
  | { kind: "text"; text: string };

/** `` `code` `` spans, split out so the renderer can set them in mono. */
export type Span = { mono: boolean; text: string };

export function parseSpans(text: string): Span[] {
  return text
    .split(/(`[^`]+`)/)
    .filter((part) => part !== "")
    .map((part) =>
      part.startsWith("`") && part.endsWith("`") && part.length > 2
        ? { mono: true, text: part.slice(1, -1) }
        : { mono: false, text: part },
    );
}

export function parseTicketBlocks(description: string): TicketBlock[] {
  return description
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block !== "")
    .map((block): TicketBlock => {
      // A whole block that is only a bold label. Its body is the next block.
      const label = /^\*\*(.+)\*\*$/.exec(block);
      if (label) return { kind: "label", text: label[1]! };

      // Their words, verbatim. The one thing nobody can reconstruct later.
      if (block.split("\n").every((line) => line.startsWith(">"))) {
        return {
          kind: "quote",
          text: block
            .split("\n")
            .map((line) => line.replace(/^>\s?/, ""))
            .join("\n"),
        };
      }

      // A trailing aside, such as the self-audit's note that no person filed this.
      const aside = /^_(.+)_$/.exec(block);
      if (aside) return { kind: "aside", text: aside[1]! };

      return { kind: "text", text: block };
    });
}
