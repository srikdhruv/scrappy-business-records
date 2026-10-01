// Checks a parsed request body against the feedback contract (schema 1).
// Returns either a clean, typed Feedback or a short plain-English error for a 400.

export const CATEGORIES = ["problem", "idea", "question"] as const;
export type Category = (typeof CATEGORIES)[number];

export const MAX_MESSAGE_CHARS = 5000;
export const MAX_LOG_TAIL_CHARS = 65_536;
export const MAX_SCREENSHOT_BYTES = 1_500_000;

export interface FeedbackError {
  at: string;
  kind: string;
  message: string;
}

export interface Screenshot {
  contentType: "image/jpeg" | "image/png";
  /** Standard base64, whitespace removed. */
  base64: string;
}

export interface Feedback {
  id: string;
  installId: string;
  category: Category;
  message: string;
  createdAt: Date;
  createdAtText: string;
  localTime: string;
  appVersion: string;
  buildId: string;
  route: string;
  environment: [string, string][];
  errors: FeedbackError[];
  logTail: string;
  screenshot: Screenshot | null;
}

export type Validation = { ok: true; feedback: Feedback } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APP_VERSION = /^[0-9A-Za-z.+-]{1,32}$/;
const BUILD_ID = /^[0-9A-Za-z._-]{1,64}$/;
const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|\+00:00)$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

class Invalid extends Error {}

function fail(error: string): never {
  throw new Invalid(error);
}

/** Length in characters (code points), the way Python's len() counts. */
function charCount(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, name: string, max: number, min = 0): string {
  if (typeof v !== "string") fail(`${name} must be a string`);
  const n = charCount(v);
  if (n < min || n > max) {
    fail(min > 0 ? `${name} must be ${min}-${max} characters` : `${name} must be at most ${max} characters`);
  }
  return v;
}

/** An optional string field: missing or null counts as "". */
function optStr(v: unknown, name: string, max: number): string {
  return v === undefined || v === null ? "" : str(v, name, max);
}

function uuid(v: unknown, name: string): string {
  if (typeof v !== "string" || !UUID.test(v)) fail(`${name} must be a UUID`);
  return v.toLowerCase();
}

function utcTimestamp(v: unknown): Date {
  const bad = "created_at must be an ISO-8601 UTC timestamp";
  if (typeof v !== "string" || v.length > 40) fail(bad);
  const m = ISO_UTC.exec(v);
  if (!m) fail(bad);
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  // Date.UTC rolls 2026-02-30 over into March; a round trip catches impossible dates.
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== d ||
    date.getUTCHours() !== h ||
    date.getUTCMinutes() !== mi ||
    date.getUTCSeconds() !== s
  ) {
    fail(bad);
  }
  return date;
}

function environment(v: unknown): [string, string][] {
  if (v === undefined || v === null) return [];
  if (!isObject(v)) fail("environment must be an object");
  const entries = Object.entries(v);
  if (entries.length > 30) fail("environment must have at most 30 entries");
  return entries.map(([key, value]) => {
    if (charCount(key) > 40) fail("environment keys must be at most 40 characters");
    if (typeof value !== "string" || charCount(value) > 500) {
      fail("environment values must be strings of at most 500 characters");
    }
    return [key, value];
  });
}

function errors(v: unknown): FeedbackError[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) fail("errors must be a list");
  if (v.length > 20) fail("errors must have at most 20 entries");
  return v.map((e) => {
    if (!isObject(e)) fail("each error must be an object");
    return {
      at: str(e.at, "error at", 40),
      kind: str(e.kind, "error kind", 20),
      message: str(e.message, "error message", 1000),
    };
  });
}

/** Decoded size of a base64 string (already checked to be well formed). */
function decodedSize(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return (b64.length / 4) * 3 - padding;
}

function screenshot(v: unknown): Screenshot | null {
  if (v === undefined || v === null) return null;
  if (!isObject(v)) fail("screenshot must be an object or null");
  const contentType = v.content_type;
  if (contentType !== "image/jpeg" && contentType !== "image/png") {
    fail("screenshot content_type must be image/jpeg or image/png");
  }
  if (typeof v.data_base64 !== "string") fail("screenshot data_base64 must be a string");
  const base64 = v.data_base64.replace(/\s+/g, "");
  if (base64.length === 0 || base64.length % 4 !== 0 || !BASE64.test(base64)) {
    fail("screenshot data_base64 is not valid base64");
  }
  if (decodedSize(base64) > MAX_SCREENSHOT_BYTES) {
    fail(`screenshot must be at most ${MAX_SCREENSHOT_BYTES} bytes`);
  }
  // The first bytes must match the claimed type, so only real images reach the repo.
  const head = atob(base64.slice(0, 12));
  const isJpeg = head.startsWith("\xff\xd8\xff");
  const isPng = head.startsWith("\x89PNG\r\n\x1a\n");
  if ((contentType === "image/jpeg" && !isJpeg) || (contentType === "image/png" && !isPng)) {
    fail(`screenshot is not a valid ${contentType === "image/jpeg" ? "JPEG" : "PNG"} image`);
  }
  return { contentType, base64 };
}

export function validate(body: unknown): Validation {
  try {
    if (!isObject(body)) fail("body must be a JSON object");
    if (body.schema !== 1) fail("schema must be 1");
    const category = body.category;
    if (typeof category !== "string" || !(CATEGORIES as readonly string[]).includes(category)) {
      fail("category must be problem, idea or question");
    }
    if (typeof body.message !== "string") fail("message must be a string");
    const message = body.message.trim();
    const messageChars = charCount(message);
    if (messageChars < 1 || messageChars > MAX_MESSAGE_CHARS) {
      fail(`message must be 1-${MAX_MESSAGE_CHARS} characters`);
    }
    const appVersion = body.app_version;
    if (typeof appVersion !== "string" || !APP_VERSION.test(appVersion)) {
      fail("app_version must be 1-32 characters of letters, digits, . + -");
    }
    const buildId = body.build_id;
    if (typeof buildId !== "string" || !BUILD_ID.test(buildId)) {
      fail("build_id must be 1-64 characters of letters, digits, . _ -");
    }
    const feedback: Feedback = {
      id: uuid(body.id, "id"),
      installId: uuid(body.install_id, "install_id"),
      category: category as Category,
      message,
      createdAt: utcTimestamp(body.created_at),
      createdAtText: body.created_at as string,
      localTime: optStr(body.local_time, "local_time", 64),
      appVersion,
      buildId,
      route: optStr(body.route, "route", 500),
      environment: environment(body.environment),
      errors: errors(body.errors),
      logTail: optStr(body.log_tail, "log_tail", MAX_LOG_TAIL_CHARS),
      screenshot: screenshot(body.screenshot),
    };
    return { ok: true, feedback };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, error: e.message };
    throw e;
  }
}
