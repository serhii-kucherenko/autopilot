/**
 * `POST /api/press` - the human presses production on one ticket.
 *
 * This route records an approval and nothing else. It does not deploy. `autopilot release`
 * deploys, and only when an approval exists for the exact commit that is on the default
 * branch. Anything merged after a press therefore needs a new press (ADR 0008, SER-642).
 *
 * The press is the one irreversible action in the product, which is why the UI confirms it
 * and nothing else does.
 */

import { pressProduction, Git } from "@autopilot/core";
import { config, openStore } from "../../../lib/server.ts";

export async function POST(request: Request): Promise<Response> {
  let body: { ticketId?: unknown; approvedBy?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "body is not JSON" }, { status: 400 });
  }

  const ticketId = typeof body.ticketId === "string" ? body.ticketId.trim() : "";
  if (!ticketId) return Response.json({ error: "ticketId is required" }, { status: 400 });

  const approvedBy = typeof body.approvedBy === "string" && body.approvedBy.trim() !== ""
    ? body.approvedBy.trim()
    : "console";

  const cfg = config();
  const store = openStore();
  try {
    // Only a ticket that actually reached staging can be pressed. Pressing something that
    // never shipped would record an approval for a build nobody has seen.
    const run = store.runFor(ticketId);
    if (!run) {
      return Response.json(
        { error: `${ticketId} has not shipped to staging, so there is nothing to press.` },
        { status: 409 },
      );
    }

    const git = new Git(cfg.repo.root);
    if (!git.isRepo()) {
      return Response.json(
        { error: `repo.root "${cfg.repo.root}" is not a git repository, so no commit can be approved.` },
        { status: 409 },
      );
    }

    const pressed = pressProduction({ config: cfg, store, ticketId, approvedBy, git });
    return Response.json({
      ...pressed,
      staged: run.commitSHA,
      // Worth saying out loud: the press approves HEAD, which may be ahead of the build the
      // digest described if other tickets merged since.
      approvesStagedBuild: pressed.commitSHA === run.commitSHA,
      next: `autopilot release ${ticketId}`,
    });
  } catch (cause) {
    return Response.json({ error: (cause as Error).message }, { status: 500 });
  } finally {
    store.close();
  }
}
