/**
 * The `host` part of `url`, or the raw string when it does not parse.
 * Shared by the node cards that show an endpoint's host row (subagent
 * remote URL, OpenAPI tool spec URL).
 */
export function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
