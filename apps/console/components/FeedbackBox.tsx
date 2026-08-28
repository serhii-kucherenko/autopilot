"use client";

/**
 * The reply box. `docs/flow.md`: the human reviews by talking, and that loops straight back
 * to stage 1 as new tickets.
 *
 * Sending is reversible - a queued line becomes tickets only when triage runs next - so it
 * does not confirm, and success is the box going quiet rather than a toast.
 */

import { useState } from "react";
import { consoleFetch } from "../lib/console-token.ts";

type State = "idle" | "sending" | "sent" | "failed";

export function FeedbackBox({ about }: { about?: string }) {
  const [text, setText] = useState("");
  const [state, setState] = useState<State>("idle");
  const [message, setMessage] = useState("");

  async function send() {
    if (text.trim() === "") return;
    setState("sending");
    try {
      const response = await consoleFetch("/api/feedback", { text, ...(about ? { about } : {}) });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        setState("failed");
        setMessage(body.error ?? `failed with ${response.status}`);
        return;
      }
      setState("sent");
      setMessage("");
    } catch (cause) {
      setState("failed");
      setMessage((cause as Error).message);
    }
  }

  if (state === "sent") {
    return (
      <section className="card digest" aria-live="polite">
        <h2>Queued</h2>
        <p className="press__note">
          Your words are stored exactly as you wrote them. The next{" "}
          <span className="mono">autopilot say</span> runs them through the same triage prompt an
          annotation goes through, and files the tickets.
        </p>
        <button
          type="button"
          className="btn btn--quiet"
          style={{ marginTop: "var(--space-sm)" }}
          onClick={() => {
            setText("");
            setState("idle");
          }}
        >
          Say something else
        </button>
      </section>
    );
  }

  return (
    <section className="card digest">
      <h2>{about ? "Say something about this ticket" : "Say something"}</h2>
      <p className="press__note">
        Whatever you write becomes tickets through triage, never a change to a ticket already
        running. Two unrelated problems in one paragraph is fine; triage splits them.
      </p>
      <textarea
        className="field"
        style={{ marginTop: "var(--space-md)" }}
        rows={3}
        placeholder="the search feels slow and the empty state has no next action…"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="split" style={{ marginTop: "var(--space-sm)" }}>
        <button
          type="button"
          className="btn"
          data-state={state === "sending" ? "loading" : state === "failed" ? "error" : undefined}
          disabled={state === "sending" || text.trim() === ""}
          onClick={send}
        >
          {state === "sending" ? "Sending…" : "Send to triage"}
        </button>
        {state === "failed" ? <span className="press__note">{message}</span> : null}
      </div>
    </section>
  );
}
