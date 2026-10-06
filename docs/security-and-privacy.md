# Security and privacy

## What GaugeLab stores (in its own database, on your machine or server)

- Golden datasets: questions, expected outcomes, tags.
- Uploaded reference documents (as extracted text) and AI-generated candidate cases.
- For every trial: the answer, the normalized result (retrieved document excerpts, tool
  arguments and results, token usage), the target's raw response **after redaction**, the
  trace, and every evaluator verdict, including judge reasons.
- Imported logs, when you import them.
- Human calibration labels and the annotator name you type.
- Provider configurations: provider, model, base URL and the **name** of the environment
  variable that holds the key. Never the key.

The default database is `data/gaugelab.db` (SQLite), which is ignored by git. Treat it as
sensitive as the data you put into it.

## What can leave the machine

| Action | Sent to | When |
|---|---|---|
| Running an experiment | the target you configured | always (it is the system under test) |
| LLM-judge evaluators | the judge provider | only if you choose a cloud judge |
| Generating candidate test cases | the generator provider | only when you click Generate |
| The heuristic judge, deterministic, retrieval, agent and performance evaluators | nowhere | never |
| A local Ollama judge or generator | nowhere (localhost) | never |

A cloud judge receives the question, the reference answer, the retrieved context, tool
results and the answer being graded. Do not send confidential material to a provider unless
your organisation allows that data path. A local model avoids external transmission
entirely: configure an `ollama` provider (default `http://localhost:11434`).

## Bring your own key

1. Put the key in the API server's environment (for example in `.env`, which git ignores):
   `OPENAI_API_KEY=...`.
2. In GaugeLab, reference it as `env:OPENAI_API_KEY` when adding a provider (or a target's
   `auth.secret_ref`).
3. The key is read at call time, server-side only. It is never returned by the API (the UI
   shows only whether it is set), never written to the database, and never logged.
   Provider error messages are truncated and never include request headers.

The browser never sees a key. Nothing secret is kept in `localStorage`; it holds only the
theme and the reviewer name you typed.

## Redaction

Before a raw response is stored, `gaugelab.traces.redact`:

- replaces the value of any field whose name is a known secret (`api_key`, `authorization`,
  `password`, `secret`, `token`, `access_token`, `refresh_token`, `cookie`, `x-api-key`...) at
  any depth;
- replaces strings that look like keys (`sk-...`, `Bearer ...`, AWS access key ids,
  `api_key=...`);
- also replaces any field names listed in the experiment's `redact_fields` (for example
  `email`, `customer_name`).

Redaction is a safety net, not a guarantee. Review what your target returns.

## Connecting internal systems

Configuration that names internal hosts or systems belongs in `local/` (ignored by git).
The repository itself contains only fictional demo data. Evaluating a production chatbot can
have side effects on that system (conversation logs, usage records, cost). Check them before
a live run, or grade logged answers through the importer instead of calling the system.

## Not in scope

GaugeLab is a local, single-user workbench. It has no authentication, no multi-tenancy and
no role-based access control. Do not expose the API to an untrusted network. Put it behind
your own authentication if it has to be shared.
