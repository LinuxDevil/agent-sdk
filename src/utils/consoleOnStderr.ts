/**
 * Sends `console.log/info/debug` to stderr while `run` runs, so they cannot
 * corrupt a stdout protocol (ACP, the Studio bridge). Shared by the stdio
 * commands; each saves and restores the originals around `run`.
 */
export async function withConsoleOnStderr<T>(run: () => Promise<T>): Promise<T> {
  const saved = { log: console.log, info: console.info, debug: console.debug };
  Object.assign(console, { log: console.error, info: console.error, debug: console.error });
  try {
    return await run();
  } finally {
    Object.assign(console, saved);
  }
}
