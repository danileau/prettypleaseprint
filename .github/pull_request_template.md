## What changes, and why

<!-- The reasoning matters more than the diff. If a decision looks odd on
     purpose, say so here and in a comment. -->

## How it was verified

<!-- Which suites, and anything you exercised by hand. If you added coverage,
     say what it would have caught. -->

- [ ] `npm run typecheck`
- [ ] the suites this touches (`verify:models` / `verify:auth` / `verify:sso` / `verify:upload` / `verify:import` / `verify:queue` / `verify:frr` / `verify:benefits` / `verify:catalog` / `verify:api` / `verify:passkey` / `probe:security`) — or all of it at once with `scripts/full-test.sh`
- [ ] `for t in scripts/tests/*.test.sh; do bash "$t"; done` if a script under `scripts/*.sh` changed
- [ ] if there is a migration: the previous image still works against the migrated database
- [ ] `npm run check:links` if any documentation moved

## Anything a reviewer should push back on

<!-- Trade-offs you made, things you were unsure about, scope you left out. -->
