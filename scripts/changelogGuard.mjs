// Release guard: a version cannot be packed or published without a CHANGELOG
// heading of its own. Used by prepack-check.mjs and tested in
// changelogGuard.test.ts.

/** Returns an error message when `changelog` has no `## [<version>]` heading, else null. */
export function missingChangelogHeading(changelog, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`^## \\[${escaped}\\](\\s|$)`, 'm').test(changelog)) return null;
  return (
    `prepack: CHANGELOG.md has no "## [${version}]" heading. ` +
    `Move the "Unreleased" entries under "## [${version}] - <date>" before packing or publishing this version.`
  );
}
