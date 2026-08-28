/**
 * `POST /api/bundles`  - a device uploads one bundle, JSON plus inline base64 PNGs.
 * `GET  /api/bundles`  - the agent lists what is waiting. `?undrained=false` for everything.
 *
 * Two of the four endpoints in `docs/intake.md`. Route handlers in the console app rather
 * than a second service (ADR 0003): the console has to read the same bundles to show them.
 */

import { parseBundle, BundleError } from "@autopilot/core";
import { openStore, intakeAuthorised } from "../../../lib/server.ts";

export async function POST(request: Request): Promise<Response> {
  const auth = intakeAuthorised(request);
  if (!auth.ok) return Response.json({ error: auth.why }, { status: 401 });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "body is not JSON" }, { status: 400 });
  }

  let bundle;
  try {
    bundle = parseBundle(raw);
  } catch (cause) {
    // A rejected bundle means the person did the work and got nothing, so say exactly why.
    const why = cause instanceof BundleError ? cause.message : "bundle could not be read";
    return Response.json({ error: why }, { status: 422 });
  }

  const store = openStore();
  try {
    const { id, created } = store.put(bundle);
    // 200 rather than 201 on a repeat: uploading twice stores it once, and a device
    // retrying after a dropped connection must not see an error (docs/intake.md).
    return Response.json({ id, created }, { status: created ? 201 : 200 });
  } finally {
    store.close();
  }
}

export async function GET(request: Request): Promise<Response> {
  const auth = intakeAuthorised(request);
  if (!auth.ok) return Response.json({ error: auth.why }, { status: 401 });

  const store = openStore();
  try {
    const bundles = store.undrained().map((stored) => ({
      sessionID: stored.bundle.sessionID,
      app: stored.bundle.app,
      receivedAt: stored.receivedAt,
      annotations: stored.bundle.annotations.length,
    }));
    return Response.json({ bundles });
  } finally {
    store.close();
  }
}
