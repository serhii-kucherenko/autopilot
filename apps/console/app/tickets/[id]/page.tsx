/**
 * One ticket: what triage resolved, what the engineer did, and a reply box.
 *
 * `prompts/triage.md` says their verbatim words are the one thing nobody can reconstruct
 * later, so the description is rendered as written rather than summarised.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { config, openStore, tracker } from "../../../lib/server.ts";
import { Chip, statusForTicket } from "../../../components/Chip.tsx";
import { PressButton } from "../../../components/PressButton.tsx";
import { FeedbackBox } from "../../../components/FeedbackBox.tsx";
import { TicketBody } from "../../../components/TicketBody.tsx";

export const dynamic = "force-dynamic";

const PRIORITY = ["none", "urgent", "high", "medium", "low"] as const;

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cfg = config();

  let ticket;
  try {
    ticket = await tracker(cfg).get(id);
  } catch {
    ticket = undefined;
  }
  if (!ticket) notFound();

  const store = openStore();
  const run = store.runFor(ticket.id);
  const approval = run ? store.approvalFor(ticket.id, run.commitSHA) : undefined;
  store.close();

  const state = statusForTicket(ticket.state, ticket.lane);

  return (
    <>
      <div className="head">
        <span className="label">
          <Link className="link" href="/backlog">
            Backlog
          </Link>{" "}
          · {ticket.id}
        </span>
        <h1>{ticket.title}</h1>
        <div className="row__meta">
          <Chip status={state.status}>{state.label}</Chip>
          <span className="mono">{PRIORITY[ticket.priority] ?? "none"}</span>
          <span className="mono">lane:{ticket.lane}</span>
          {ticket.url ? (
            <a className="link mono" href={ticket.url}>
              open in the tracker
            </a>
          ) : null}
        </div>
      </div>

      {ticket.description ? (
        <section className="card digest">
          <h2>What triage resolved</h2>
          <TicketBody description={ticket.description} />
        </section>
      ) : null}

      {run ? (
        <section className="card digest" style={{ marginTop: "var(--space-lg)" }}>
          <h2>What the engineer shipped</h2>
          <p className="press__note">{run.summary}</p>
          <div className="row__meta" style={{ marginTop: "var(--space-sm)" }}>
            <Chip status="ok">on staging</Chip>
            <span className="mono">{run.commitSHA.slice(0, 7)}</span>
            <span className="mono">branch {run.branch}</span>
            <span className="mono">flag {run.flag}</span>
          </div>
          {run.unsure ? (
            <p className="press__note" style={{ marginTop: "var(--space-sm)" }}>
              <span className="label">The engineer was unsure about · </span>
              {run.unsure}
            </p>
          ) : null}

          <div className="press" style={{ marginTop: "var(--space-md)", paddingLeft: 0, paddingRight: 0 }}>
            <div className="press__what">
              {approval ? (
                <p className="press__note">
                  Approved by {approval.approvedBy} at{" "}
                  <span className="mono">{approval.commitSHA.slice(0, 7)}</span>. Run{" "}
                  <span className="mono">autopilot release {ticket.id}</span> to deploy it.
                </p>
              ) : (
                <p className="press__note">
                  Not approved for production. The loop cannot press this; only you can, and the
                  approval binds to the exact commit so anything merged afterwards needs a new press.
                </p>
              )}
            </div>
            {approval ? (
              <Chip status="ok">approved</Chip>
            ) : (
              <PressButton ticketId={ticket.id} commit={run.commitSHA} />
            )}
          </div>
        </section>
      ) : (
        <section className="card digest" style={{ marginTop: "var(--space-lg)" }}>
          <h2>Not built yet</h2>
          <p className="press__note">
            Nothing has shipped for this ticket, so there is nothing to review and nothing to
            press. The engineer runner will pick it up when it reaches the top of the queue.
          </p>
        </section>
      )}

      <div style={{ marginTop: "var(--space-lg)" }}>
        <FeedbackBox about={ticket.id} />
      </div>
    </>
  );
}
