/**
 * Test helper: is a Docker daemon answering? (LOU-M6)
 *
 * Tests that need a real daemon gate on {@link requireDocker} with a top-level
 * await (vitest evaluates `describe.skipIf` at collection time, before any
 * hook runs). Without a daemon they skip, except when `LOUSHO_DOCKER_TESTS=1`
 * is set: then the file fails, so the Linux Docker CI job (`npm run
 * test:docker`, `.github/workflows/docker.yml`) cannot pass by skipping.
 */
import Docker from 'dockerode';

/** How long a ping may take before the daemon counts as absent. */
const PING_TIMEOUT_MS = 2_000;

/** True when the default Docker daemon answers a ping within 2 seconds. */
export async function dockerAvailable(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), PING_TIMEOUT_MS);
    timer.unref();
  });
  try {
    return await Promise.race([
      new Docker().ping().then(
        () => true,
        () => false
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** True for Docker Desktop and rootless daemons, where sandbox egress is refused by design. */
async function egressRefusedByDesign(): Promise<boolean> {
  const info = (await new Docker().info()) as { OperatingSystem?: string; SecurityOptions?: string[] };
  return /docker desktop/i.test(info.OperatingSystem ?? '') || !!info.SecurityOptions?.some((option) => option.includes('rootless'));
}

/**
 * {@link dockerAvailable}, but throws when `LOUSHO_DOCKER_TESTS=1` is set and
 * no daemon answers, so a suite that must run against a daemon fails instead
 * of skipping.
 *
 * With `linuxEngine: true` (the sandbox egress suite), a Docker Desktop or
 * rootless daemon also counts as absent: egress is refused there by design.
 * Under `LOUSHO_DOCKER_TESTS=1` the suite runs anyway, so a CI runner whose
 * Engine is refused fails loudly rather than skipping.
 */
export async function requireDocker(options: { linuxEngine?: boolean } = {}): Promise<boolean> {
  const required = process.env.LOUSHO_DOCKER_TESTS === '1';
  const available = await dockerAvailable();
  if (!available && required) {
    throw new Error('LOUSHO_DOCKER_TESTS=1 is set but no Docker daemon answered a ping within 2 seconds.');
  }
  if (!available || required || !options.linuxEngine) return available;
  return !(await egressRefusedByDesign());
}
