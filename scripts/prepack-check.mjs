// `npm pack` / `npm publish` (prepack): the release guard. The tarball never
// contains Studio (apps/agent-forge left the package in W13b; `lousho studio`
// launches the separately installed @linuxdevil/studio). The build is not run
// here because `npm pack` of the checkout also runs for `lousho init
// --sdk-path`, docs:verify-snippets and the scaffold tests; prepublishOnly
// builds the SDK for a real publish.
import { readFileSync } from 'node:fs';
import { missingChangelogHeading } from './changelogGuard.mjs';

// Release guard: the version being packed must have its own CHANGELOG heading.
// This fails the pack, and so `npm publish`. CI's pack-smoke packs the
// current version, so main keeps a heading for the version in package.json.
const changelogError = missingChangelogHeading(
  readFileSync('CHANGELOG.md', 'utf8'),
  JSON.parse(readFileSync('package.json', 'utf8')).version
);
if (changelogError) {
  console.error(changelogError);
  process.exit(1);
}
