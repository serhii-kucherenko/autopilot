/**
 * The intake endpoints and the press, tested by calling the route handlers directly.
 *
 * No browser, no running server: a route handler takes a `Request` and returns a `Response`,
 * so the four endpoints in `docs/intake.md` and the two rules in `DESIGN.md` - the console
 * never writes to the tracker, and never deploys - are all checkable in process.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@autopilot/core";

const TOKEN = "test-build-token";
const CONSOLE_TOKEN = "test-console-token";
const PNG = Buffer.from("fake-png-bytes").toString("base64");
const SESSION = "aaaa1111-0000-4000-8000-000000000001";

/**
 * Each test gets its own store root and its own product repo, and the modules are imported
 * fresh so `storeRoot()` reads the right environment. Query-string cache busting is the
 * standard way to defeat the ESM module cache.
 */
async function workspace() {
  const root = mkdtempSync(join(tmpdir(), "ap-console-"));
  const product = join(root, "product");
  mkdirSync(product, { recursive: true });

  const git = (...args: string[]) => execFileSync("git", args, { cwd: product, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "loop@autopilot.test");
  git("config", "user.name", "Autopilot");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(product, "app.ts"), "export const x = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");

  const configPath = join(root, "autopilot.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      product: { name: "Nimbus", vision: "docs/vision.md" },
      tracker: { kind: "linear", project: "Nimbus" },
      repo: { root: product, defaultBranch: "main" },
      environments: {
        staging: { deploy: "true" },
        // If a route ever deployed production, this file would appear. None does.
        production: { deploy: "touch PRODUCTION_WAS_DEPLOYED" },
      },
      gate: { commands: ["true"] },
    }),
  );

  process.env.AUTOPILOT_STORE = root;
  process.env.AUTOPILOT_CONFIG = configPath;
  process.env.AUTOPILOT_INTAKE_TOKEN = TOKEN;
  process.env.AUTOPILOT_CONSOLE_TOKEN = CONSOLE_TOKEN;
  process.env.AUTOPILOT_FAKE = "1";

  const bust = `?t=${root}`;
  const bundles = await import(`../app/api/bundles/route.ts${bust}`);
  const one = await import(`../app/api/bundles/[id]/route.ts${bust}`);
  const ack = await import(`../app/api/bundles/[id]/ack/route.ts${bust}`);
  const press = await import(`../app/api/press/route.ts${bust}`);
  const feedback = await import(`../app/api/feedback/route.ts${bust}`);
  const crops = await import(`../app/api/crops/[session]/[annotation]/route.ts${bust}`);

  return { root, product, bundles, one, ack, press, feedback, crops };
}

function bundleJSON(sessionID = SESSION) {
  return {
    sessionID,
    app: { name: "Nimbus", platform: "iPadOS", commitSHA: "a1b2c3d" },
    annotations: [
      {
        id: `${sessionID}-a1`,
        comment: "saving from the share sheet does nothing",
        screenshotPNG: PNG,
        trace: [{ method: "POST", url: "https://api/v1/items", statusCode: 500 }],
      },
    ],
  };
}

/** A console-page write: the token goes in the header the pages send. */
function consolePost(path: string, body: unknown, token = CONSOLE_TOKEN): Request {
  return new Request(`http://console.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-autopilot-console": token },
    body: JSON.stringify(body),
  });
}

/** A crop fetch. An <img> cannot send a header, so the token rides in the query. */
function cropRequest(token = CONSOLE_TOKEN): Request {
  return new Request(`http://console.test/api/crops/x/y?t=${encodeURIComponent(token)}`);
}

function post(body: unknown, token = TOKEN): Request {
  return new Request("http://console.test/api/bundles", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

test("a device uploads a bundle, and uploading it twice stores it once", async () => {
  const w = await workspace();

  const first = await w.bundles.POST(post(bundleJSON()));
  assert.equal(first.status, 201);
  assert.deepEqual(await first.json(), { id: SESSION, created: true });

  // A retry after a dropped connection must not look like an error to the device.
  const second = await w.bundles.POST(post(bundleJSON()));
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { id: SESSION, created: false });

  const list = await w.bundles.GET(post({}, TOKEN));
  const listed = (await list.json()) as {
    bundles: { sessionID: string; annotations: number; receivedAt: string; app: { name: string } }[];
  };
  assert.equal(listed.bundles.length, 1);
  assert.equal(listed.bundles[0]!.sessionID, SESSION);
  assert.equal(listed.bundles[0]!.annotations, 1);
  assert.equal(listed.bundles[0]!.app.name, "Nimbus");
  // `docs/intake.md`: the list carries the build so triage can tell whether the bug still
  // exists on current code. A received time it can order by, too.
  assert.ok(Date.parse(listed.bundles[0]!.receivedAt) > 0);
});

test("intake is not an open inbox: no token, wrong token, both refused", async () => {
  const w = await workspace();

  const wrong = await w.bundles.POST(post(bundleJSON(), "not-the-token"));
  assert.equal(wrong.status, 401);

  const none = await w.bundles.POST(
    new Request("http://console.test/api/bundles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bundleJSON()),
    }),
  );
  assert.equal(none.status, 401);
});

test("a server with no token configured refuses everything rather than defaulting to open", async () => {
  const w = await workspace();
  delete process.env.AUTOPILOT_INTAKE_TOKEN;
  try {
    const response = await w.bundles.POST(post(bundleJSON()));
    assert.equal(response.status, 401);
    assert.match(((await response.json()) as { error: string }).error, /is not set on the server/);
  } finally {
    process.env.AUTOPILOT_INTAKE_TOKEN = TOKEN;
  }
});

test("a bundle that cannot be read says exactly why, because the person did the work", async () => {
  const w = await workspace();
  const response = await w.bundles.POST(post({ sessionID: SESSION, app: { name: "Nimbus" }, annotations: [] }));
  assert.equal(response.status, 422);
  assert.match(((await response.json()) as { error: string }).error, /no annotations/);
});

test("the agent reads one bundle, then acks it, and the ack is what drains it", async () => {
  const w = await workspace();
  await w.bundles.POST(post(bundleJSON()));

  const got = await w.one.GET(post({}), { params: Promise.resolve({ id: SESSION }) });
  assert.equal(got.status, 200);
  const stored = (await got.json()) as { bundle: { annotations: { comment: string }[] } };
  assert.equal(stored.bundle.annotations[0]!.comment, "saving from the share sheet does nothing");

  const missing = await w.one.GET(post({}), { params: Promise.resolve({ id: "nope" }) });
  assert.equal(missing.status, 404);

  const acked = await w.ack.POST(post({}), { params: Promise.resolve({ id: SESSION }) });
  assert.equal(acked.status, 200);

  const list = (await (await w.bundles.GET(post({}))).json()) as { bundles: unknown[] };
  assert.deepEqual(list.bundles, [], "an acked bundle is drained");
});

test("a crop is served as a real PNG, and a made-up id is a 404, not a file read", async () => {
  const w = await workspace();
  await w.bundles.POST(post(bundleJSON()));

  const image = await w.crops.GET(cropRequest(), {
    params: Promise.resolve({ session: SESSION, annotation: `${SESSION}-a1` }),
  });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal(Buffer.from(await image.arrayBuffer()).toString("base64"), PNG);

  for (const attempt of ["../../../etc/passwd", "..", "unknown"]) {
    const bad = await w.crops.GET(cropRequest(), {
      params: Promise.resolve({ session: attempt, annotation: attempt }),
    });
    assert.equal(bad.status, 404, `${attempt} must not resolve`);
  }
});

test("the press records an approval and does not deploy anything", async () => {
  const w = await workspace();
  const store = new Store(w.root);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: w.product, encoding: "utf8" }).trim();
  store.recordRun({ ticketId: "AP-1", commitSHA: head, branch: "auto/ap-1", flag: "flag_ap_1", summary: "s" });
  store.close();

  const response = await w.press.POST(
    consolePost("/api/press", { ticketId: "AP-1", approvedBy: "serhii" }),
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { commitSHA: string; approvesStagedBuild: boolean; next: string };
  assert.equal(body.commitSHA, head);
  assert.equal(body.approvesStagedBuild, true);
  assert.equal(body.next, "autopilot release AP-1");

  assert.equal(
    existsSync(join(w.product, "PRODUCTION_WAS_DEPLOYED")),
    false,
    "the console records the press; autopilot release is what deploys",
  );

  const after = new Store(w.root);
  assert.ok(after.approvalFor("AP-1", head), "the approval is bound to that commit");
  after.close();
});

test("pressing something that never shipped is refused", async () => {
  const w = await workspace();
  const response = await w.press.POST(
    consolePost("/api/press", { ticketId: "AP-9" }),
  );
  assert.equal(response.status, 409);
  assert.match(((await response.json()) as { error: string }).error, /has not shipped to staging/);
});

test("feedback is stored verbatim and never touches a ticket", async () => {
  const w = await workspace();
  const response = await w.feedback.POST(
    consolePost("/api/feedback", { text: "  the search feels slow  ", about: "AP-1" }),
  );
  assert.equal(response.status, 200);

  const lines = readFileSync(join(w.root, "feedback.jsonl"), "utf8").trim().split("\n");
  const line = JSON.parse(lines[0]!) as { text: string; about: string };
  assert.equal(line.text, "the search feels slow");
  assert.equal(line.about, "AP-1");

  const empty = await w.feedback.POST(
    consolePost("/api/feedback", { text: "   " }),
  );
  assert.equal(empty.status, 400);
});

test("the bundle parser is what guards intake, so a non-JSON body is a 400", async () => {
  const w = await workspace();
  const response = await w.bundles.POST(
    new Request("http://console.test/api/bundles", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: "not json at all",
    }),
  );
  assert.equal(response.status, 400);
});

test("no route imports anything that could write to the tracker or deploy", async () => {
  // A grep, deliberately. The rule is about what the code can reach, and reading the imports
  // is the only check that keeps holding as the routes grow.
  const routes = [
    "app/api/bundles/route.ts",
    "app/api/bundles/[id]/route.ts",
    "app/api/bundles/[id]/ack/route.ts",
    "app/api/press/route.ts",
    "app/api/feedback/route.ts",
    "app/api/crops/[session]/[annotation]/route.ts",
  ];
  const banned = ["runEngineer", "runRelease", "runLoop", "runTriage", "LinearTracker"];

  for (const route of routes) {
    const source = readFileSync(new URL(`../${route}`, import.meta.url), "utf8");
    for (const name of banned) {
      assert.equal(source.includes(name), false, `${route} must not reach ${name}`);
    }
  }
});

/* --------------------------------------------------------------- console token */

test("the press refuses an unauthenticated POST, which it used to accept", async () => {
  const w = await workspace();
  const store = new Store(w.root);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: w.product, encoding: "utf8" }).trim();
  store.recordRun({ ticketId: "AP-1", commitSHA: head, branch: "b", flag: "f", summary: "s" });
  store.close();

  const bare = await w.press.POST(
    new Request("http://console.test/api/press", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticketId: "AP-1" }),
    }),
  );
  assert.equal(bare.status, 401, "a blind POST must not record a production approval");

  const wrong = await w.press.POST(consolePost("/api/press", { ticketId: "AP-1" }, "not-the-token"));
  assert.equal(wrong.status, 401);

  const after = new Store(w.root);
  assert.equal(after.approvalFor("AP-1", head), undefined, "nothing was approved");
  after.close();
});

test("a server with no console token refuses the press, rather than defaulting to open", async () => {
  const w = await workspace();
  delete process.env.AUTOPILOT_CONSOLE_TOKEN;
  try {
    const response = await w.press.POST(consolePost("/api/press", { ticketId: "AP-1" }));
    assert.equal(response.status, 401);
    assert.match(((await response.json()) as { error: string }).error, /AUTOPILOT_CONSOLE_TOKEN is not set/);
  } finally {
    process.env.AUTOPILOT_CONSOLE_TOKEN = CONSOLE_TOKEN;
  }
});

test("feedback and the crops are gated too, since one is a write and one is a screenshot", async () => {
  const w = await workspace();
  await w.bundles.POST(post(bundleJSON()));

  const feedback = await w.feedback.POST(
    new Request("http://console.test/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    }),
  );
  assert.equal(feedback.status, 401);

  const crop = await w.crops.GET(new Request("http://console.test/api/crops/x/y"), {
    params: Promise.resolve({ session: SESSION, annotation: `${SESSION}-a1` }),
  });
  assert.equal(crop.status, 401, "a product screenshot is not world-readable");

  const withToken = await w.crops.GET(cropRequest(), {
    params: Promise.resolve({ session: SESSION, annotation: `${SESSION}-a1` }),
  });
  assert.equal(withToken.status, 200);
});

test("the intake token cannot press production, because device builds carry it", async () => {
  const w = await workspace();
  const response = await w.press.POST(
    new Request("http://console.test/api/press", {
      method: "POST",
      headers: { "content-type": "application/json", "x-autopilot-console": TOKEN },
      body: JSON.stringify({ ticketId: "AP-1" }),
    }),
  );
  assert.equal(response.status, 401, "two separate secrets on purpose");
});
