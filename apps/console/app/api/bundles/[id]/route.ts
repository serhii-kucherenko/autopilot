/** `GET /api/bundles/:id` - one bundle with its annotations, for triage. */

import { openStore, intakeAuthorised } from "../../../../lib/server.ts";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = intakeAuthorised(request);
  if (!auth.ok) return Response.json({ error: auth.why }, { status: 401 });

  const { id } = await context.params;
  const store = openStore();
  try {
    const stored = store.get(id);
    if (!stored) return Response.json({ error: `no bundle ${id}` }, { status: 404 });
    return Response.json(stored);
  } finally {
    store.close();
  }
}
