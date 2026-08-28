/**
 * The inbox: bundles that arrived and have not been triaged yet.
 *
 * `docs/annotation.md`: the crop must be exact and everything else degrades gracefully. So
 * the crop is the largest thing on each row, their words come next, and the trace - which is
 * what pins the real endpoint - sits underneath. A missing crop says so rather than showing a
 * broken image.
 */

import { config, openStore } from "../../lib/server.ts";
import { Chip } from "../../components/Chip.tsx";

export const dynamic = "force-dynamic";

export default function InboxPage() {
  const cfg = config();
  const store = openStore();
  const waiting = store.undrained();
  store.close();

  if (waiting.length === 0) {
    return (
      <>
        <div className="head">
          <span className="label">Inbox</span>
          <h1>Nothing waiting</h1>
          <p className="head__lede">
            Every bundle that arrived has been turned into tickets and acknowledged. The ack is
            the only thing that marks a bundle drained, so a triage run that dies halfway can
            simply run again.
          </p>
        </div>
        <div className="empty">
          <h2>How something gets here</h2>
          <p>
            Point at an element in {cfg.product.name}, say what is wrong, and send the tray. The
            device POSTs to <span className="mono">/api/bundles</span> with a per-build token and
            queues on disk if it cannot reach the server. Nothing needs your machine to be awake.
          </p>
        </div>
      </>
    );
  }

  const annotations = waiting.reduce((n, b) => n + b.bundle.annotations.length, 0);

  return (
    <>
      <div className="head">
        <span className="label">Inbox</span>
        <h1>
          {annotations} {annotations === 1 ? "annotation" : "annotations"} waiting to be triaged
        </h1>
        <p className="head__lede">
          Run <span className="mono">autopilot triage</span> to turn these into tickets. It is not
          one ticket per annotation: triage merges what is the same problem and splits what is two.
        </p>
      </div>

      <div className="stack">
        {waiting.map((stored) => {
          const { bundle } = stored;
          return (
            <section className="card" key={bundle.sessionID}>
              <div className="graphite__head" style={{ borderBottomColor: "var(--color-rule)" }}>
                <span className="label">{bundle.app.name}</span>
                {bundle.app.platform ? <span className="mono">{bundle.app.platform}</span> : null}
                {bundle.app.commitSHA ? (
                  <span className="mono">build {bundle.app.commitSHA.slice(0, 7)}</span>
                ) : null}
                <span className="bar__spacer" />
                <Chip status="attention">not triaged</Chip>
              </div>

              {bundle.annotations.map((annotation) => (
                <article className="annotation" key={annotation.id}>
                  {annotation.screenshotPath ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      className="annotation__crop"
                      src={`/api/crops/${encodeURIComponent(bundle.sessionID)}/${encodeURIComponent(annotation.id)}`}
                      alt={`What they pointed at${annotation.screen ? ` on ${annotation.screen}` : ""}`}
                    />
                  ) : (
                    <div className="annotation__crop annotation__crop--none">
                      no crop · the agent locates the element itself
                    </div>
                  )}

                  <div>
                    <p className="annotation__said">{annotation.comment}</p>

                    <div className="row__meta">
                      {annotation.screen ? (
                        <span className="mono">screen {annotation.screen}</span>
                      ) : null}
                      {annotation.element?.accessibilityID ? (
                        <span className="mono">#{annotation.element.accessibilityID}</span>
                      ) : null}
                      {annotation.tag ? <Chip status="waiting">{annotation.tag}</Chip> : null}
                    </div>

                    {annotation.trace.length > 0 ? (
                      <div className="graphite" style={{ marginTop: "var(--space-sm)" }}>
                        <div className="graphite__head">
                          <span className="label">what actually fired on this screen</span>
                        </div>
                        <div className="graphite__body">
                          <div className="trace">
                            {annotation.trace.map((entry, index) => (
                              <div className="trace__line" key={`${entry.url}-${index}`}>
                                <span className="trace__method">{entry.method}</span>
                                <span className="trace__url">{entry.url}</span>
                                {entry.statusCode ? (
                                  <span
                                    className="trace__status"
                                    data-bad={entry.statusCode >= 400 ? "true" : "false"}
                                  >
                                    {entry.statusCode}
                                  </span>
                                ) : null}
                                {entry.durationMs ? (
                                  <span className="num">{entry.durationMs}ms</span>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <p className="press__note" style={{ marginTop: "var(--space-sm)" }}>
                        No trace on this one. Triage will not invent an endpoint for it.
                      </p>
                    )}

                    {annotation.console.length > 0 ? (
                      <div className="graphite" style={{ marginTop: "var(--space-sm)" }}>
                        <div className="graphite__head">
                          <span className="label">console</span>
                        </div>
                        <div className="graphite__body">
                          <pre>
                            {annotation.console.map((line) => `[${line.level}] ${line.message}`).join("\n")}
                          </pre>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </article>
              ))}
            </section>
          );
        })}
      </div>
    </>
  );
}
