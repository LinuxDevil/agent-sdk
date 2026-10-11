// `npm pack` / `npm publish` (prepack): warn when the tarball would ship without
// the Agent Forge build, so `lousho studio` would not work from it. The build is
// not run here because `npm pack` of the checkout also runs for
// `lousho init --sdk-path`, docs:verify-snippets and the scaffold tests, which
// do not need it; prepublishOnly builds it for a real publish.
import { existsSync } from 'node:fs';

// npm runs prepack in the package root.
if (!existsSync('apps/agent-forge/dist-server/index.cjs')) {
  console.warn(
    "prepack: apps/agent-forge is not built, so 'lousho studio' will not work from this tarball. " +
      "Run 'npm run build:studio' first if you need it (npm publish builds it in prepublishOnly)."
  );
}
