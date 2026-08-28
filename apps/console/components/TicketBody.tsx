/**
 * A ticket description, rendered. The parse lives in `lib/ticket-blocks.ts`; this maps its
 * blocks to elements and nothing else.
 *
 * Every string here goes through React, which escapes it. Nothing in the console uses
 * `dangerouslySetInnerHTML`, and a test asserts that, so device-supplied text cannot become
 * markup.
 */

import { parseSpans, parseTicketBlocks } from "../lib/ticket-blocks.ts";

export function TicketBody({ description }: { description: string }) {
  const blocks = parseTicketBlocks(description);
  if (blocks.length === 0) return null;

  return (
    <div className="stack--tight" style={{ marginTop: "var(--space-sm)" }}>
      {blocks.map((block, index) => {
        const key = `b${index}`;

        if (block.kind === "label") {
          return (
            <span className="label" key={key}>
              {block.text}
            </span>
          );
        }

        if (block.kind === "quote") {
          return (
            <blockquote className="annotation__said" key={key} style={{ margin: 0 }}>
              {block.text}
            </blockquote>
          );
        }

        const spans = parseSpans(block.text).map((span, i) =>
          span.mono ? (
            <span className="mono" key={`${key}-${i}`}>
              {span.text}
            </span>
          ) : (
            span.text
          ),
        );

        return (
          <p
            className="press__note"
            key={key}
            style={block.kind === "text" ? { whiteSpace: "pre-wrap" } : undefined}
          >
            {spans}
          </p>
        );
      })}
    </div>
  );
}
