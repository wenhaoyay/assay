# Security and privacy

## What Assay stores (in its own database, on your machine or server)

- Golden datasets: questions, expected outcomes, tags.
- Uploaded reference documents (as extracted text) and AI-generated candidate cases.
- For every trial: the answer, the normalized result (retrieved document excerpts, tool
  arguments and results, token usage), the target's raw response **after redaction**, the
  trace, and every evaluator verdict, including judge reasons.
- Imported logs, when you import them.
- Human calibration labels and the annotator name you type.
- Provider configurations: provider, model, base URL and a **reference** to the key
  (`env:NAME` or `keyring:NAME`). Never the key.
- Workspace settings (default judge, default generator, spend cap) and connection templates
  (which hold key references, never keys).

The default database is `data/assay.db` (SQLite), which is ignored by git. Treat it as
sensitive as the data you put into it.

## What can leave the machine

| Action | Sent to | When |
|---|---|---|
| Running an experiment | the target you configured | always (it is the system under test) |
| LLM-judge evaluators | the judge provider | only if you choose a cloud judge |
| Generating candidate test cases | the generator provider | only when you click Generate |
| The heuristic judge, deterministic, retrieval, agent and performance evaluators | nowhere | never |
| A local Ollama judge or generator | nowhere (localhost) | never, except Ollama `-cloud` models (Ollama's servers) |

A cloud judge receives the question, the reference answer, the retrieved context, tool
results and the answer being graded. Do not send confidential material to a provider unless
your organisation allows that data path. A local model avoids external transmission
entirely: connect Ollama or LM Studio in Settings > Models & keys.

**Local judges only.** A target can be marked *local grading models only* (on its page). Runs
of that target (new, relaunched from saved settings, from the CLI), re-grades, explanations and
judge bake-offs over its labelled answers are then refused with any judge whose address is not
on this machine, so a confidential bot's answers cannot reach a cloud API by a wrong click. "On
this machine" means the URL's host is `localhost`, a loopback address or `host.docker.internal`;
an Ollama provider with a remote address is remote, and a judge whose settings cannot be read
is refused. The check sits where every run starts, not only in the screens. Generating test
cases from documents is not covered: those documents are not tied to a connection. Ollama
models whose names end in `-cloud` or `:cloud` are reached through the local Ollama but run on
Ollama's servers; Assay treats them as cloud models and refuses them here too.

**Third-party software.** Assay never downloads or installs Ollama itself. A model download
through the Ollama card starts only after the person accepted a third-party notice (recorded
with its date in the workspace settings); see [local-models.md](local-models.md).

## Bring your own key

Two places a key can live; configurations only ever hold a reference to it:

- **The OS credential store** (`keyring:NAME`): paste the key in Settings > Models & keys, or
  click *Store securely* when the connect wizard finds an `Authorization` header in a pasted
  curl command. The key is sent once to the local Assay server, which writes it to Windows
  Credential Manager / macOS Keychain / Secret Service under the service name `assay`.
- **The server environment** (`env:NAME`): set it in `.env` (ignored by git) or the
  deployment, for Docker and CI.

Either way the key is read at call time, server-side only. It is never returned by the API
(the UI shows whether it is set and its last four characters), never written to the
database, and never logged. Provider error messages are truncated and never include request
headers. The curl parser hands a found secret back to the page that pasted it, so the page
can offer to store it; it is not kept anywhere else.

Nothing secret is kept in `localStorage`; it holds only viewer preferences (theme, density,
motion) and the reviewer name you typed.

## Redaction

Before a raw response is stored, `assay.traces.redact`:

- replaces the value of any field whose name is a known secret (`api_key`, `authorization`,
  `password`, `secret`, `token`, `access_token`, `refresh_token`, `cookie`, `x-api-key`...) at
  any depth;
- replaces strings that look like keys (`sk-...`, `Bearer ...`, AWS access key ids,
  `api_key=...`);
- also replaces any field names listed in the experiment's `redact_fields` (for example
  `email`, `customer_name`).

Since the stored copy of each answer is graded first, the same masking is then applied to
what is stored for it: the normalized result (answer, sources, tool arguments and results,
metadata, errors), the trace and the verdicts. The checks saw the real values, so scores do not
change. Field names are matched exactly; free text (an email inside an answer) is masked only
when it looks like a key. The test-question screens show the unmasked reply to you.

Redaction is a safety net, not a guarantee. Review what your target returns, and protect the
database as you would the data in it.

## Connecting internal systems

Configuration that names internal hosts or systems belongs in `local/` (ignored by git).
The repository itself contains only fictional demo data. Evaluating a production chatbot can
have side effects on that system (conversation logs, usage records, cost). Check them before
a live run, or grade logged answers through the importer instead of calling the system.

## Not in scope

Assay is a local, single-user workbench. It has no authentication, no multi-tenancy and
no role-based access control. Do not expose the API to an untrusted network. Put it behind
your own, independently reviewed authentication if it has to be shared.

What protects it locally:

- `assay serve` listens on 127.0.0.1; Docker Compose publishes the API and demo agent on
  127.0.0.1 only and does not publish Postgres. Set `POSTGRES_PASSWORD` for anything but a
  throwaway demo.
- The API answers only requests addressed to `localhost` or `127.0.0.1`, so a web page that
  points its own domain at your machine (DNS rebinding) cannot use it. Add names with
  `ASSAY_ALLOWED_HOSTS` if you deliberately serve it under another name.
- A Python connection runs code inside Assay, so it may name only the demo agent or a module
  listed in `ASSAY_PYTHON_TARGETS` on the machine running Assay; anything else is refused
  before it is imported, whether it comes from the screens, the API or a config file.
