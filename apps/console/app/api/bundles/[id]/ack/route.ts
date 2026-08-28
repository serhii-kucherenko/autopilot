/**
 * `POST /api/bundles/:id/ack` - the agent marks a bundle drained, once tickets exist.
 *
 * The ack is the only thing that marks a bundle done, which is what makes a triage run that
 * crashes halfway safe to simply run again (docs/intake.md).
 */

import { openStore, intakeAuthorised } from "../../../../../lib/server.ts";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = intakeAuthorised(request);
  if (!auth.ok) return Response.json({ error: auth.why }, { status: 401 });

  const { id } = await context.params;
  const store = openStore();
  try {
    const acked = store.ack(id);
    if (!acked) return Response.json({ error: `no bundle ${id}` }, { status: 404 });
    return Response.json({ id, acked: true });
  } finally {
    store.close();
  }
}
