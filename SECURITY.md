# Security

NetStacks handles SSH credentials, terminal sessions, and AI integration —
all of which are sensitive by definition. We treat security reports
seriously and respond promptly.

## Reporting a vulnerability

**Email: security@netstacks.net**

Do **not** open a public GitHub issue for security findings. Email is the
correct channel.

Please include:
- A description of the issue
- Steps to reproduce (or a proof-of-concept)
- Affected versions if known
- Your name / handle for credit (or note that you wish to remain anonymous)

You can use plain email or, if you prefer encryption, request the
maintainer's PGP key in your initial message.

## Response timeline

- **Acknowledgment within 2 business days** — we will confirm receipt.
- **Triage within 7 days** — we will give you our initial assessment of
  severity and whether we agree the issue is in scope.
- **Fix and disclose within 90 days** — for confirmed issues, we aim to
  ship a fix within 90 days of triage. We will coordinate the disclosure
  date with you.

If the 90-day window is going to slip — for example, because the fix
requires architectural changes — we will let you know and propose a new
date.

## Disclosure

We follow coordinated disclosure. Once a fix has shipped, we publish a
security advisory on this repository's GitHub Security page that
includes:
- A description of the vulnerability and impact
- Affected versions and the fix version
- Credit to the reporter (unless you asked to remain anonymous)
- A CVE if one is appropriate and assigned

## Scope

In scope:
- This repository: NetStacks Terminal (Tauri shell, Local Agent)
- The credential vault primitives at `github.com/netstacks/netstacks-crypto`
- Signed-release artifact integrity

Out of scope (report to the appropriate party instead):
- Third-party dependencies: report directly to the upstream project.
  Once they fix it we will pull the patched version.
- The closed-source Controller: contact NetStacks support if you have a
  paid Controller deployment and find an issue.
- Issues in user-supplied configuration (e.g. choosing a weak master
  password, running NetStacks on a compromised host).

## Hall of fame

We thank the reporters who have helped make NetStacks more secure. With
your permission, we will list your name and a short description of the
issue here once a fix has shipped and the disclosure window has elapsed.

## What you can do today

- Download installers only from <https://netstacks.net/download>. Verify
  the published SHA-256 checksums against the file you downloaded.
- Verify Apple notarization (macOS) and Authenticode signature (Windows)
  on downloaded binaries before installing.
- Read the source. The agent and Tauri shell are both in this repo. The
  credential vault crate is at
  [netstacks-crypto](https://github.com/netstacks/netstacks-crypto).
