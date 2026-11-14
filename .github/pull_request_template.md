## What

Explain the net effect of this PR in plain prose: what changes for someone using the SDK, and why. Link an issue if there is one, but don't rely on the link alone.

**What type of change is this?**

- [ ] **feat**: A new feature
- [ ] **fix**: A bug fix
- [ ] **docs**: Documentation only
- [ ] **refactor**: Neither fixes a bug nor adds a feature
- [ ] **test**: Tests only
- [ ] **ci**: Workflows and release automation
- [ ] **chore**: Tooling, build or dependency updates

## Behavior changes

> Remove this section if existing code keeps working unchanged.

What can break for existing users, and how do they opt out or migrate? Mark the `CHANGELOG.md` entry **Behavior change** and add it to `docs/upgrading.md`.

## Testing

What did you run, and what did it show? Name anything you couldn't verify, such as live-model or Docker behavior.

## Checklist

- [ ] Tests cover the new behavior
- [ ] `CHANGELOG.md` has an entry under `Unreleased`, if users would notice this change
- [ ] Public API changed: ran `npm run build && npm run api:update` and committed the reports
- [ ] Docs changed: updated `README.md` or `docs/` and ran `npm run docs:llms`

## Release

Merging doesn't publish. The Release workflow publishes `@linuxdevil/lousho` and `create-lousho` to npm as `latest` every Monday at 06:00 UTC, or when run by hand, so everyone on a default install gets this change in the next release. The `Unreleased` entry above becomes that release's notes.

- [ ] This PR doesn't need a release on its own, so I added the `norelease` label. The weekly run skips when every PR since the last release has it

## Before & After

> Remove this section if there is no visible change to Agent Forge or CLI output.

**BEFORE**:

**AFTER**:

## Notes for the reviewer

List anything that isn't obvious or is a side effect: known gaps, trade-offs, magic numbers, new commands, or an order in which PRs must merge.
