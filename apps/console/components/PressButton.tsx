"use client";

/**
 * The production press. The one irreversible action in the product, and therefore the only
 * one that confirms - `DESIGN.md`: reversible actions do not ask, this one does.
 *
 * The button records an approval. It does not deploy. That separation is what makes the
 * safety claim testable rather than a promise (ADR 0008).
 */

import { useState } from "react";
import { consoleFetch } from "../lib/console-token.ts";

type State = "idle" | "confirming" | "pressing" | "pressed" | "failed";

export function PressButton({ ticketId, commit }: { ticketId: string; commit: string }) {
  const [state, setState] = useState<State>("idle");
  const [message, setMessage] = useState("");

  async function press() {
    setState("pressing");
    try {
      const response = await consoleFetch("/api/press", { ticketId });
      const body = (await response.json()) as { error?: string; commitSHA?: string };
      if (!response.ok) {
        setState("failed");
        setMessage(body.error ?? `press failed with ${response.status}`);
        return;
      }
      setState("pressed");
      setMessage(
        `Approved ${ticketId} at ${(body.commitSHA ?? commit).slice(0, 7)}. ` +
          `Run \`autopilot release ${ticketId}\` to deploy it.`,
      );
    } catch (cause) {
      setState("failed");
      setMessage((cause as Error).message);
    }
  }

  // Success is quiet: the control becomes the fact, and no toast appears.
  if (state === "pressed") {
    return (
      <div className="stack--tight">
        <span className="chip chip--ok">
          <span className="dot" aria-hidden="true" />
          approved
        </span>
        <p className="press__note">{message}</p>
      </div>
    );
  }

  if (state === "confirming") {
    return (
      <div className="stack--tight">
        <p className="press__note">
          This releases <span className="mono">{ticketId}</span> at commit{" "}
          <span className="mono">{commit.slice(0, 7)}</span> to production. It is the one thing
          here that cannot be undone.
        </p>
        <div className="split">
          <button type="button" className="btn btn--primary" onClick={press} autoFocus>
            Press production
          </button>
          <button type="button" className="btn btn--quiet" onClick={() => setState("idle")}>
            Not yet
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="stack--tight">
      <button
        type="button"
        className="btn btn--primary"
        data-state={state === "pressing" ? "loading" : state === "failed" ? "error" : undefined}
        disabled={state === "pressing"}
        onClick={() => setState("confirming")}
      >
        {state === "pressing" ? "Recording…" : "Press production"}
      </button>
      {state === "failed" ? <p className="press__note">{message}</p> : null}
    </div>
  );
}
