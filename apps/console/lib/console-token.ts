/**
 * The console token, on the browser side.
 *
 * The layout renders it into a `<meta>` tag and every mutating fetch sends it back. That is
 * what makes a blind cross-site POST fail: a script that never loaded a console page has no
 * token to send. It is a gate, not user authentication - see `lib/server.ts`.
 */

export const CONSOLE_TOKEN_HEADER = "x-autopilot-console";
const META_NAME = "autopilot-console-token";

export function consoleTokenFromPage(): string {
  if (typeof document === "undefined") return "";
  return document.querySelector<HTMLMetaElement>(`meta[name="${META_NAME}"]`)?.content ?? "";
}

/** `fetch`, with the console token attached. Every write from the browser goes through this. */
export async function consoleFetch(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [CONSOLE_TOKEN_HEADER]: consoleTokenFromPage(),
    },
    body: JSON.stringify(body),
  });
}

export { META_NAME as CONSOLE_TOKEN_META };
