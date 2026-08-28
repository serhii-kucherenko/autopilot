/**
 * The digest. What the human opens the console for: what is now true on staging, and the
 * press for each thing that is ready.
 *
 * `prompts/digest.md`: lead with what is now true, not what the loop did. Be silent when
 * nothing changed - so on a quiet day this screen says so plainly and offers nothing to click.
 */

import Link from "next/link";
import { plainDigest, coherenceOf, describeCoherence } from "@autopilot/core";
import { config, openStore, openTickets } from "../../lib/server.ts";
import { Chip } from "../../components/Chip.tsx";
import { PressButton } from "../../components/PressButton.tsx";
import { FeedbackBox } from "../../components/FeedbackBox.tsx";

export const dynamic = "force-dynamic";

export default async function DigestPage() {
  const cfg = config();
  const store = openStore();
  const runs = store.undigestedRuns();
  const signals = store.undigestedSignals();
  store.close();
  const coherence = coherenceOf(cfg, signals);
  const { tickets, error } = await openTickets(cfg);

  const needsYou = tickets.filter((t) => t.lane === "human" && t.stateType !== "completed");

  if (runs.length === 0) {
    return (
      <>
        <div className="head">
          <span className="label">Digest</span>
          <h1>Nothing landed on staging</h1>
          <p className="head__lede">
            Silence on a quiet day is the correct outcome, not a missing screen. When the loop
            ships something you will find it here, with a press.
          </p>
        </div>
        <div className="empty">
          <h2>What happens next on its own</h2>
          <p>
            The continuity engine takes the top unblocked ticket on its next wake. On an empty
            backlog it runs a self-audit and refills the queue rather than idling.
          </p>
          <div className="split" style={{ marginTop: "var(--space-md)" }}>
            <Link className="btn" href="/backlog">
              See the queue
            </Link>
            <Link className="btn" href="/inbox">
              See what is waiting to be triaged
            </Link>
          </div>
        </div>
        <div style={{ marginTop: "var(--space-lg)" }}>
          <FeedbackBox />
        </div>
      </>
    );
  }

  return (
    <>
      <div className="head">
        <span className="label">Digest</span>
        <h1>
          {runs.length} {runs.length === 1 ? "change is" : "changes are"} on staging
        </h1>
        <p className="head__lede">
          Everything below is merged behind a flag and deployed to staging. None of it is in
          production. Reading this and pressing is the whole of your job here.
        </p>
      </div>

      <section className="card digest" aria-labelledby="shipped">
        <h2 id="shipped">Shipped to staging</h2>
        {runs.map((run) => (
          <div className="press" key={run.ticketId}>
            <div className="press__what">
              <div className="row__top">
                <Link className="row__id link" href={`/tickets/${encodeURIComponent(run.ticketId)}`}>
                  {run.ticketId}
                </Link>
                <span className="row__title">{run.summary}</span>
              </div>
              <div className="row__meta">
                <Chip status="ok">on staging</Chip>
                <span className="mono">{run.commitSHA.slice(0, 7)}</span>
                <span className="mono">flag {run.flag}</span>
                {run.stagingURL ? (
                  <a className="link mono" href={run.stagingURL}>
                    {run.stagingURL}
                  </a>
                ) : null}
              </div>
              {run.unsure ? (
                <p className="press__note" style={{ marginTop: "var(--space-xs)" }}>
                  <span className="label">Needs your eyes · </span>
                  {run.unsure}
                </p>
              ) : null}
            </div>
            <PressButton ticketId={run.ticketId} commit={run.commitSHA} />
          </div>
        ))}
      </section>

      {needsYou.length > 0 ? (
        <section className="card digest" style={{ marginTop: "var(--space-lg)" }}>
          <h2>Your call</h2>
          <p className="press__note">
            These are in the human lane. The loop will build them to staging, but the direction
            is yours.
          </p>
          <ul className="rows" style={{ marginTop: "var(--space-md)" }}>
            {needsYou.map((ticket) => (
              <li key={ticket.id}>
                <Link className="row" href={`/tickets/${encodeURIComponent(ticket.id)}`}>
                  <div className="row__top">
                    <span className="row__id">{ticket.id}</span>
                    <span className="row__title">{ticket.title}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {signals.length > 0 ? (
        <section className="card digest" style={{ marginTop: "var(--space-lg)" }}>
          <h2>Did not ship</h2>
          <p className="press__note">
            A conflict is a decision for you, not a failure. The loop stopped rather than
            quietly picking a side.
          </p>
          <ul className="rows" style={{ marginTop: "var(--space-md)" }}>
            {signals.map((signal) => (
              <li key={`${signal.kind}-${signal.ticketId}-${signal.at}`}>
                <Link className="row" href={`/tickets/${encodeURIComponent(signal.ticketId)}`}>
                  <div className="row__top">
                    <span className="row__id">{signal.ticketId}</span>
                    <span className="row__title">{signal.detail?.split("\n")[0] ?? signal.kind}</span>
                    <Chip status={signal.kind === "conflict" ? "attention" : "danger"}>
                      {signal.kind}
                    </Chip>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="card digest" style={{ marginTop: "var(--space-lg)" }}>
        <h2>Coherence</h2>
        <p className="press__note">{describeCoherence(coherence)}</p>
        <p className="press__note" style={{ marginTop: "var(--space-xs)" }}>
          These are the two numbers <span className="mono">docs/coherence.md</span> names as the
          falsification test for the whole anchor bet. Lots of conflicts means the anchor is
          over-specified; drift you keep finding that these numbers missed means it is
          under-specified.
        </p>
      </section>

      <section className="card digest" style={{ marginTop: "var(--space-lg)" }}>
        <h2>The same thing, without a model</h2>
        <p className="press__note">
          What <span className="mono">autopilot digest --plain</span> prints. It is here so this
          screen is verifiable against the store rather than against a generated message.
        </p>
        <div className="graphite" style={{ marginTop: "var(--space-md)" }}>
          <div className="graphite__head">
            <span className="label">autopilot digest --plain</span>
          </div>
          <div className="graphite__body">
            <pre>{plainDigest(runs, tickets, cfg, coherence)}</pre>
          </div>
        </div>
      </section>

      {error ? (
        <p className="press__note" style={{ marginTop: "var(--space-md)" }}>
          The queue could not be read: {error}
        </p>
      ) : null}

      <div style={{ marginTop: "var(--space-lg)" }}>
        <FeedbackBox />
      </div>
    </>
  );
}
