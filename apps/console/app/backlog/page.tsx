/**
 * The backlog: a read-only mirror of the queue.
 *
 * Read-only is the point. `docs/architecture.md` gives Linear the ordered work and nothing
 * else may hold a second copy - so this screen shows the queue and offers no way to change
 * it. Reordering here would make two truths out of one.
 */

import Link from "next/link";
import { pickNext } from "@autopilot/core";
import { config, openTickets } from "../../lib/server.ts";
import { Chip, statusForTicket } from "../../components/Chip.tsx";

export const dynamic = "force-dynamic";

const PRIORITY = ["none", "urgent", "high", "medium", "low"] as const;

export default async function BacklogPage() {
  const cfg = config();
  const { tickets, error } = await openTickets(cfg);
  const next = pickNext(tickets);

  if (error) {
    return (
      <>
        <div className="head">
          <span className="label">Backlog</span>
          <h1>The queue could not be read</h1>
        </div>
        <div className="empty">
          <h2>What to check</h2>
          <p>{error}</p>
          <p style={{ marginTop: "var(--space-sm)" }}>
            Run <span className="mono">autopilot doctor</span>. It names what is missing and the
            exact command or URL that fixes it.
          </p>
        </div>
      </>
    );
  }

  if (tickets.length === 0) {
    return (
      <>
        <div className="head">
          <span className="label">Backlog</span>
          <h1>The queue is empty</h1>
          <p className="head__lede">
            An idle loop is a correct outcome. On its next wake the continuity engine runs a
            self-audit instead of idling, and refills the queue itself - bugs, debt, refactors
            and small polish, at most five findings, each with evidence.
          </p>
        </div>
        <div className="empty">
          <h2>It never invents a feature</h2>
          <p>
            The self-audit may only file in the AI lane. Direction is not the loop&apos;s to
            invent, so anything needing a product decision reaches you in the digest instead of
            appearing here as work.
          </p>
        </div>
      </>
    );
  }

  const byLane = {
    ai: tickets.filter((t) => t.lane === "ai"),
    human: tickets.filter((t) => t.lane === "human"),
  };

  return (
    <>
      <div className="head">
        <span className="label">Backlog · read only</span>
        <h1>
          {tickets.length} open · {byLane.ai.length} AI lane · {byLane.human.length} yours
        </h1>
        <p className="head__lede">
          The ordered work lives in the tracker; this is a mirror of it. Nothing here can be
          reordered, because two lists mean two truths and both rot.
        </p>
      </div>

      {next ? (
        <p className="press__note" style={{ marginBottom: "var(--space-md)" }}>
          <span className="label">Next up · </span>
          <span className="mono">{next.id}</span> {next.title}
        </p>
      ) : null}

      <ul className="rows">
        {tickets.map((ticket) => {
          const state = statusForTicket(ticket.state, ticket.lane);
          return (
            <li key={ticket.id}>
              <Link className="row" href={`/tickets/${encodeURIComponent(ticket.id)}`}>
                <div className="row__top">
                  <span className="row__id">{ticket.id}</span>
                  <span className="row__title">{ticket.title}</span>
                  {ticket.id === next?.id ? <Chip status="attention">next up</Chip> : null}
                </div>
                <div className="row__meta">
                  <Chip status={state.status}>{state.label}</Chip>
                  <span className="mono">{PRIORITY[ticket.priority] ?? "none"}</span>
                  <span className="mono">lane:{ticket.lane}</span>
                  {ticket.blockedBy.length > 0 ? (
                    <span className="mono">blocked by {ticket.blockedBy.join(", ")}</span>
                  ) : null}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </>
  );
}
