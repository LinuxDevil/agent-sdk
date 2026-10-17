// `npm pack` / `npm publish` (prepack): warn when the tarball would ship without
// the Agent Forge build, so `lousho studio` would not work from it. The build is
// not run here because `npm pack` of the checkout also runs for
// `lousho init --sdk-path`, docs:verify-snippets and the scaffold tests, which
// do not need it; prepublishOnly builds it for a real publish.
import { existsSync, readFileSync } from 'node:fs';
import { missingChangelogHeading } from './changelogGuard.mjs';

// Release guard: the version being packed must have its own CHANGELOG heading.
// Unlike the Agent Forge warning below this fails the pack, and so
// `npm publish`. CI's pack-smoke packs the current version, so main keeps a
// heading for the version in package.json.
const changelogError = missingChangelogHeading(
  readFileSync('CHANGELOG.md', 'utf8'),
  JSON.parse(readFileSync('package.json', 'utf8')).version
);
if (changelogError) {
  console.error(changelogError);
  process.exit(1);
}

// npm runs prepack in the package root.
if (!existsSync('apps/agent-forge/dist-server/index.cjs')) {
  console.warn(
    "prepack: apps/agent-forge is not built, so 'lousho studio' will not work from this tarball. " +
      "Run 'npm run build:studio' first if you need it (npm publish builds it in prepublishOnly)."
  );
}
