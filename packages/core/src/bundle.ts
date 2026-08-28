/**
 * The Loupe bundle format - the contract between capture and triage.
 *
 * `integrations/README.md`: adding fields is safe, renaming them is not. So this parser
 * is deliberately lenient about everything except the three things triage cannot work
 * without: a stable session id, at least one annotation, and words in each annotation.
 * Every anchor field (element, trace, screen) is best effort on the device, so a missing
 * one degrades the ticket rather than failing the tray.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export class BundleError extends Error {
  override name = "BundleError";
}

export interface AppInfo {
  name: string;
  platform?: string;
  version?: string;
  environment?: string;
  commitSHA?: string;
}

export interface ElementRef {
  accessibilityID?: string;
  label?: string;
  className?: string;
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface TraceEntry {
  method: string;
  url: string;
  statusCode?: number;
  durationMs?: number;
  at?: string;
}

export interface ConsoleEntry {
  level: string;
  message: string;
  at?: string;
}

export interface Annotation {
  id: string;
  comment: string;
  tag?: string;
  element?: ElementRef;
  trace: TraceEntry[];
  console: ConsoleEntry[];
  screen?: string;
  capturedAt?: string;
  /** Inline image, as HTTPTransport sends it. */
  screenshotBase64?: string;
  /** Sibling file on disk, as FileTransport writes it. Never both. */
  screenshotPath?: string;
}

export interface Bundle {
  sessionID: string;
  app: AppInfo;
  sentAt?: string;
  annotations: Annotation[];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseElement(raw: unknown): ElementRef | undefined {
  const o = obj(raw);
  if (!o) return undefined;
  const b = obj(o.bounds);
  const bounds =
    b &&
    num(b.x) !== undefined &&
    num(b.y) !== undefined &&
    num(b.width) !== undefined &&
    num(b.height) !== undefined
      ? { x: b.x as number, y: b.y as number, width: b.width as number, height: b.height as number }
      : undefined;

  const el: ElementRef = {};
  if (str(o.accessibilityID)) el.accessibilityID = str(o.accessibilityID);
  if (str(o.label)) el.label = str(o.label);
  if (str(o.className)) el.className = str(o.className);
  if (bounds) el.bounds = bounds;
  return Object.keys(el).length > 0 ? el : undefined;
}

function parseTrace(raw: unknown): TraceEntry[] {
  return arr(raw).flatMap((entry) => {
    const o = obj(entry);
    const url = o && str(o.url);
    if (!o || !url) return [];
    const e: TraceEntry = { method: str(o.method) ?? "GET", url };
    if (num(o.statusCode) !== undefined) e.statusCode = o.statusCode as number;
    if (num(o.durationMs) !== undefined) e.durationMs = o.durationMs as number;
    if (str(o.at)) e.at = str(o.at);
    return [e];
  });
}

function parseConsole(raw: unknown): ConsoleEntry[] {
  return arr(raw).flatMap((entry) => {
    const o = obj(entry);
    const message = o && str(o.message);
    if (!o || !message) return [];
    const e: ConsoleEntry = { level: str(o.level) ?? "log", message };
    if (str(o.at)) e.at = str(o.at);
    return [e];
  });
}

function parseAnnotation(raw: unknown, index: number): Annotation {
  const o = obj(raw);
  if (!o) throw new BundleError(`annotation ${index} is not an object`);

  const id = str(o.id);
  if (!id) throw new BundleError(`annotation ${index} has no id`);

  // Their words are the one thing nobody can reconstruct later (prompts/triage.md).
  const comment = str(o.comment);
  if (!comment) throw new BundleError(`annotation ${id} has no comment`);

  const a: Annotation = {
    id,
    comment,
    trace: parseTrace(o.trace),
    console: parseConsole(o.console),
  };
  if (str(o.tag)) a.tag = str(o.tag);
  const element = parseElement(o.element);
  if (element) a.element = element;
  if (str(o.screen)) a.screen = str(o.screen);
  if (str(o.capturedAt)) a.capturedAt = str(o.capturedAt);
  if (str(o.screenshotPNG)) a.screenshotBase64 = str(o.screenshotPNG);
  return a;
}

export function parseBundle(raw: unknown): Bundle {
  const o = obj(raw);
  if (!o) throw new BundleError("bundle is not an object");

  // The device-generated id is what makes an upload idempotent and a retry safe (ADR 0004).
  const sessionID = str(o.sessionID);
  if (!sessionID) throw new BundleError("bundle has no sessionID");

  const app = obj(o.app);
  const appName = app && str(app.name);
  if (!appName) throw new BundleError("bundle has no app.name");

  const annotations = arr(o.annotations).map(parseAnnotation);
  // An empty tray means capture ran and lost the work. Silently accepting it hides that.
  if (annotations.length === 0) throw new BundleError("bundle has no annotations");

  const info: AppInfo = { name: appName };
  if (str(app.platform)) info.platform = str(app.platform);
  if (str(app.version)) info.version = str(app.version);
  if (str(app.environment)) info.environment = str(app.environment);
  if (str(app.commitSHA)) info.commitSHA = str(app.commitSHA);

  const bundle: Bundle = { sessionID, app: info, annotations };
  if (str(o.sentAt)) bundle.sentAt = str(o.sentAt);
  return bundle;
}

export function parseBundleJSON(text: string): Bundle {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new BundleError(`bundle is not valid JSON: ${(cause as Error).message}`);
  }
  return parseBundle(raw);
}

/**
 * Read a FileTransport session directory: `bundle.json` plus one PNG per annotation,
 * named by annotation id. A missing PNG loses one crop, not the whole tray.
 */
export function readBundleDir(dir: string): Bundle {
  const manifest = join(dir, "bundle.json");
  if (!existsSync(manifest)) throw new BundleError(`no bundle.json in ${dir}`);

  const bundle = parseBundleJSON(readFileSync(manifest, "utf8"));
  for (const annotation of bundle.annotations) {
    const png = join(dir, `${annotation.id}.png`);
    if (existsSync(png)) annotation.screenshotPath = png;
  }
  return bundle;
}

/** Every session directory under a FileTransport root, oldest first by name. */
export function listBundleDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, "bundle.json")))
    .map((e) => join(root, e.name))
    .sort();
}
