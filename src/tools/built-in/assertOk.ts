/**
 * Shared non-OK response handling for the REST-backed built-in tools
 * (github.ts, jira.ts).
 */

/**
 * Throw `<failure>: <statusText> - <response body>` for a non-OK response;
 * resolve (without reading the body) for an OK one.
 */
export async function assertOk(response: Response, failure: string): Promise<void> {
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`${failure}: ${response.statusText} - ${errorText}`);
  }
}
