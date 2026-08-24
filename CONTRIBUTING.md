# Contributing

Thanks for looking. This is a small project — one printer, one office, one
maintainer — so the bar is not "be an expert", it is "leave it working".

## The contract

Seven verification suites, all of which run in CI **against the built container
image** rather than a dev server. They are the specification; if a change makes
one fail, that is the change talking.

```bash
npm run verify:models     # upload validator vs. hostile fixtures — needs nothing running
npm run verify:auth       # registration, sign-in, password reset
npm run verify:upload     # upload → board → story
npm run verify:queue      # admin queue, status flow, conversation, access
npm run verify:api        # the JSON API, the OpenAPI document, the console
npm run verify:passkey    # WebAuthn ceremonies in a real browser
npm run probe:security    # OWASP-mapped probes
```

Plus the cheap gates: `npm run typecheck`, `npm run check:secrets -- --all`,
`npm run check:links`.

[docs/development.md](docs/development.md) gets you set up.

## What a good change looks like

**Add coverage for behaviour, not for lines.** Every suite asserts what a
person can observe — a status code, a database row, what the page says. None
of them mock the app. If you cannot express your change as something a user or
an attacker would notice, it may not need testing; if you can, it does.

**Make failures loud.** The costliest bugs in this repo were silent: a favicon
that redirected to sign-in, a deploy wizard that exited mid-swap with no
message, a test that passed because the session it relied on had been quietly
revoked. Prefer an error that names itself over a fallback that guesses.

**Explain why in the code, not just what.** The comments here carry the
reasoning behind decisions that look odd on purpose — why session cookie
caching is off, why authorisation answers 404 instead of 403, why the reset
token is put back when a password is refused. If you change one of those,
change the comment with it. If you cannot find the reason, ask in the issue
rather than guessing.

**Small and self-contained beats broad.** A pull request that does one thing
gets read properly.

## What is likely to be declined

- **Multi-tenancy, billing, or scale.** This app is for a handful of people and
  one printer, and says so. Features that only make sense at a hundred users
  make it worse for five.
- **Weakening the invite-only gate.** There is no public sign-up, deliberately,
  and the rule lives in exactly one hook.
- **Anything that makes a security decision quieter.** See
  [docs/security-audit.md](docs/security-audit.md) — several behaviours that
  look like bugs are documented decisions.

## Reporting things

- **A bug or an idea:** open an issue. Say what you expected, what happened,
  and what you were running — the commit SHA from `PPP_TAG` is ideal.
- **A vulnerability:** do *not* open an issue. [SECURITY.md](SECURITY.md) has
  the private route.

## Licence

By contributing you agree your work is licensed under
[AGPL-3.0-or-later](LICENSE), the same terms as the rest of the project.
