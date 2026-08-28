/**
 * The crop for one annotation. Served through a route rather than from `public/` because the
 * images live in the store's own directory, outside the app, and they are screenshots of a
 * running product - `docs/intake.md` says to treat them as sensitive.
 */

import { consoleAuthorised, cropBytes } from "../../../../../lib/server.ts";

export async function GET(
  request: Request,
  context: { params: Promise<{ session: string; annotation: string }> },
): Promise<Response> {
  // A crop is a screenshot of a running product. `docs/intake.md` says treat the store as
  // sensitive, which an unauthenticated GET did not.
  const auth = consoleAuthorised(request, true);
  if (!auth.ok) return new Response(auth.why, { status: 401 });

  const { session, annotation } = await context.params;
  const bytes = cropBytes(session, annotation);
  if (!bytes) return new Response("no crop", { status: 404 });

  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "image/png",
      // Immutable: a crop is written once with the bundle and never changes.
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}
