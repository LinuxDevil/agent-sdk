# Security policy

## Supported versions

`@lousho/build-ai-agent` is in the 1.0.0 alpha line on npm. Until 1.0 ships,
only the latest alpha release receives security fixes. If you are on an older
alpha, upgrade before reporting, and confirm the issue still reproduces.

| Version | Supported |
| --- | --- |
| Latest `1.0.0-alpha.*` | Yes |
| Older alphas | No |

## Reporting a vulnerability

Please do not open a public issue, pull request or discussion for a security
problem.

Use GitHub private vulnerability reporting: open the repository's **Security**
tab and choose **Report a vulnerability**, or go straight to
<https://github.com/LinuxDevil/agent-sdk/security/advisories/new>.

Please include:

- the affected version (`npm ls @lousho/build-ai-agent`) and Node.js version;
- the deployment target, if relevant (`node-server`, `docker`,
  `cloudflare-worker`, or embedded in your own code);
- a description of the impact: what an attacker can read, change or run;
- the steps or a minimal reproduction, including any agent, route, auth or
  approval configuration needed;
- any suggested fix or mitigation you already know of.

Do not include real credentials, API keys or customer data in a report.

## What to expect

This is a small, single-maintainer project, so these times are targets and not
guarantees.

- We acknowledge a report within 5 business days.
- We aim to confirm or reject it, and tell you the outcome, within 15 business
  days.
- For a confirmed issue we prepare a fix and release it as a new alpha, then
  publish a GitHub security advisory crediting the reporter unless you prefer
  to stay anonymous.

## Disclosure policy

We practise coordinated disclosure. Please give us a reasonable chance to ship
a fix before you share details publicly; 90 days from your report is the
outer limit we ask for, and we will usually be faster. We will tell you before
the advisory goes public.

## Security model

What the SDK does and does not protect you from is documented alongside the
features it applies to:

- [Route auth and principals](docs/auth.md): how HTTP routes are authenticated
  and how callers map to principals.
- [Workspace tools: security model](docs/workspace-tools.md#security-model):
  what file and shell tools can reach, and the limits of the sandbox.
- [Deployment](docs/deployment.md): hardening the HTTP API and the
  `node-server`, `docker` and `cloudflare-worker` targets.
- [Approvals](docs/approvals.md): gating sensitive tool calls behind a human
  decision.

Behaviour these pages describe as your responsibility (for example an agent you
configured with shell access running a command you allowed) is usually not a
vulnerability, but tell us if the docs are unclear.
