/**
 * The status vocabulary from `DESIGN.md`: four states and no more. Status colour here is
 * information, not decoration, which is the only reason the palette carries two hues beyond
 * the accent.
 */

export type Status = "ok" | "danger" | "attention" | "waiting";

export function Chip({ status, children }: { status: Status; children: React.ReactNode }) {
  return (
    <span className={`chip chip--${status}`}>
      <span className="dot" aria-hidden="true" />
      {children}
    </span>
  );
}

/** How a ticket's state reads to a person, and which of the four it is. */
export function statusForTicket(state: string, lane: "ai" | "human"): { status: Status; label: string } {
  if (state === "Done") return { status: "ok", label: "shipped to staging" };
  if (state === "In Progress" || state === "In Review") return { status: "attention", label: "in flight" };
  if (state === "Canceled") return { status: "waiting", label: "canceled" };
  return { status: "waiting", label: lane === "human" ? "waiting · your call" : "waiting" };
}
