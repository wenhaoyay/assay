# Security policy

Assay is a **local, single-user evaluation workbench**, not a hosted multi-user service.

## Deployment boundary

- The API intentionally has **no user authentication or authorization**. Run it only on a trusted machine, bound to loopback. Do not make the API, its database, or the demo agent publicly reachable.
- Docker Compose binds published application ports to `127.0.0.1` and does not publish PostgreSQL. Changing those defaults requires a separately reviewed authentication and network-security layer.
- A Python target adapter executes locally installed Python code. Configure allowed modules only on a trusted machine.
- A cloud model used for grading or test-case generation can receive user questions, reference text, retrieved content, tool results, and answers. Check the data-sharing path before using it with any non-public material.
- Redaction is best-effort, **not a guarantee of anonymization**. Keep the evaluation database and exported runs private when they contain real user or organization data.

For the detailed threat model and data flows, read [Security and privacy](docs/security-and-privacy.md).

## Reporting a vulnerability

Please report vulnerabilities **privately** to the repository maintainer. Use GitHub's private vulnerability reporting feature if available, and avoid including secrets or exploit details in public issues. Include the affected version, steps to reproduce, and impact.

## Supported versions

Security fixes target the latest `main` branch. No separate long-term-support branches are maintained.
