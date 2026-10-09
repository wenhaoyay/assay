# 0003. A local-first, single-user workbench

## Context

Assay stores the questions, answers and traces of the system it tests, which are often
confidential. A hosted multi-tenant service would need authentication, access control, a job
queue and a data-handling policy before it could be trusted with them. The aim here is a tool
one engineer can run in a minute and trust with private data.

## Decision

- SQLite by default (`data/assay.db`), with Postgres supported through `DATABASE_URL`.
- No authentication. `assay serve` listens on 127.0.0.1, Compose publishes only on 127.0.0.1,
  and the API answers only requests addressed to `localhost` or `127.0.0.1`, which defeats DNS
  rebinding. `ASSAY_ALLOWED_HOSTS` adds names deliberately.
- Python connections run code inside Assay, so they may name only the demo agent or a module
  in `ASSAY_PYTHON_TARGETS`.
- A target can be restricted to local grading models; the check sits where every run starts, so
  a wrong click cannot send its answers to a cloud API.
- Keys live in the OS credential store or the environment, referenced as `keyring:NAME` or
  `env:NAME`, never stored or returned.

## Consequences

- Nothing leaves the machine unless the user picks a cloud judge or the target is remote.
- It is not safe to expose on a network, and the documentation says so.
- Runs execute inside the API process, with no job queue; a restart marks in-flight runs as
  interrupted.
- There is no multi-user sharing. Adding it would mean independent authentication and a queue.

See [security-and-privacy.md](../security-and-privacy.md).
