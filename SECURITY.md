# Security policy

## Reporting a vulnerability

Please report security issues **privately**, not as a public issue.

- **Preferred:** [open a private advisory](https://github.com/danileau/ppp/security/advisories/new)
  on this repository. It is visible only to the maintainers until a fix ships.
- **Otherwise:** email <danilo.licitra@gmail.com> with `[ppp security]` in the
  subject.

Please include what you need to make the problem reproducible: the version or
commit, the request or steps, and what you expected to happen instead. A proof
of concept is welcome and never required — a clear description of the flaw is
worth more than a working exploit.

### What to expect

This is a small project maintained by one person in their own time, so the
honest answer is that response times are best-effort rather than contractual:

| | |
| --- | --- |
| First reply | within 7 days |
| Assessment, and whether a fix is planned | within 30 days |
| Credit | offered in the advisory and the release notes, declined on request |

You will be told either that a fix is coming, or plainly that it is not and
why — a report that gets no answer is worse than one that gets a no.

Please give a reasonable window to ship a fix before disclosing publicly.
There is no bug bounty; there is gratitude and an acknowledgement.

## Supported versions

The `main` branch is the only supported version. Deployments pin a commit SHA
(`PPP_TAG`), so "upgrade" means moving that pin forward — see
[docs/deployment.md](docs/deployment.md).

## Scope

**In scope:** this application's code, its container images, its authentication
and authorisation model, and its default configuration.

**Out of scope:** vulnerabilities in upstream dependencies with no
project-specific exploit path (report those upstream — Dependabot and Trivy
already watch them here), findings that require an already-compromised host or
database, denial of service by volume against a self-hosted instance, and
anything that depends on a deployment ignoring the documented requirements —
notably serving the app over plain HTTP, or setting `TRUST_PROXY_HEADERS=true`
where the app is reachable without passing through the proxy.

## What has already been assessed

The app has been through SAST, SCA and DAST against the OWASP Top 10 (2021),
including an app-specific probe suite covering things a generic scanner cannot
reason about — whether a client can call the admin API, whether an invitation
is single-use, whether a role can be set from outside, whether a captured
cookie survives sign-out.

That report, including the findings that were real and the residual risk that
was accepted, is in **[docs/security-audit.md](docs/security-audit.md)**.

It is worth reading before reporting: several plausible-looking behaviours are
deliberate and documented there, and the "Residual risk accepted" section
already names the gaps that are known.
