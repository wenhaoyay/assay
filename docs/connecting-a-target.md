# Connecting a target

## The quick way: Connections > Connect a chatbot

1. **How to reach it.** Paste a curl command (DevTools > Network > right-click > Copy as cURL),
   type an HTTP request, pick streaming, OpenAI-compatible or Python, upload logs, or start
   from a template (OpenAI-compatible, Anthropic, LangServe, Flowise, Dify, n8n, SSE, and any
   connection you saved as a template).
2. **The request.** A pasted curl fills in the URL, method, headers and body. The field that
   carries the question is replaced by `{{input.message}}`; a session or conversation id gets
   a fresh `eval-{{uuid}}` per question; an `Authorization`-like header is offered for the OS
   credential store and replaced by a `keyring:NAME` reference.
3. **Test and map.** Send a question. GaugeLab shows the reply as a tree and guesses where the
   answer, sources (id, title, text, score), citations, tool calls, tokens and model are,
   with a reason for each guess. Fix any guess by clicking *Change* and then the right node.
   *Check the mapping* runs the whole connection and lists **what you'll get**: each piece of
   telemetry, whether it came back, and the checks it unlocks. A streamed reply is folded into
   one (text pieces joined into the answer, other events kept by name) and mapped the same
   way: a `sources` event becomes the passages read, and markers like `[3]` in the answer
   become citations of the source numbered 3.
4. **Safety and save.** Choose the chatbot first (it decides which question sets are offered).
   If each question saves a conversation, turn on clean-up: GaugeLab reads the chat id where
   the reply actually has it (for a streamed reply, often `done.conversation_id`) and warns
   when the clean-up looks in the wrong place. Dry run: this chatbot's own question sets, three
   questions you type, generic ones, or the test answer's timing at no extra cost; optionally
   the same questions again all at once, to see whether the bot slows down when busy. The
   table shows, per question set, the billed answers and the time at 1 and 4 in parallel. Name
   the connection (where this copy of the bot runs) and say what is inside this version (model,
   prompt, retriever). Nothing is saved until a test question came back with an answer.

**Reading the reply, later.** A connection's page shows what each reply is read for, what
the last stored reply also contains, and reads it with one click. Past runs can then be read
again from their stored replies, with no questions asked again. This changes how GaugeLab
reads, not what is inside the bot, so it stays the same version. See
[finding-the-cause.md](finding-the-cause.md).

The three levels: a **chatbot** is the product (it holds question sets, gates and runs); a
**connection** is one place it runs (local copy, test copy, server); a **version** is what is
inside a connection now. Change the model or prompt: save a new version, not a new connection.

On a connection's page: *Other people use this bot* (runs then ask 2 at a time by default)
and *Cost per answer* for bots that report no token counts, so the spend cap and estimates can
count their answers. *Max answers* on New run limits a run even when no price is known.

*Advanced (JSON)* shows the configuration the wizard is writing, and editing it updates the
steps: the configuration below is still the record of a connection.

## The GaugeLab reply shape (bots you build)

If your bot can answer like this, there is nothing to map - leave *My bot replies in the
GaugeLab shape* on in the wizard (`"reply_shape": "gaugelab"` in a config):

```json
{
  "answer": "Device Alpha has a 24-month warranty [warranty].",
  "sources": [{"id": "warranty", "title": "Warranty policy", "text": "...", "score": 0.82}],
  "citations": ["warranty"],
  "tool_calls": [{"name": "lookup_order", "arguments": {"order_id": "18372"}, "result": {}, "status": "success"}],
  "usage": {"input_tokens": 900, "output_tokens": 40},
  "model": {"provider": "openai", "model": "gpt-x"}
}
```

Only `answer` is required; every other field unlocks more checks. Settings > *Reply shape* has
copy-paste FastAPI, Flask and Express endpoints. Bots you did not build keep working through
the mapping.

## By configuration

Any chatbot or agent can be connected by configuration alone. Pick the route that fits.

| Your system | Use | Telemetry you get |
|---|---|---|
| Has an HTTP endpoint returning JSON | `http` adapter + response mapping | whatever the JSON contains |
| Streams its answer (SSE or NDJSON) | `http` adapter + `stream` reducer | answer + any events you map (sources, steps, tool rounds) |
| Is Python code you can import | `python` adapter: `module:function(test_input, options, ctx)` | everything you return |
| Must not (or cannot) be called during evaluation | the importer + `replay` target | whatever its logs contain |

Start with **Targets > New target > Test connection**: it shows the raw response next to the
normalized one, and lists the telemetry the mapping does not yet capture.

## 1. JSON over HTTP

```json
{
  "base_url": "http://localhost:9040",
  "endpoint": "/chat",
  "method": "POST",
  "body": {"message": "{{input.message}}", "session": "eval-{{uuid}}"},
  "auth": {"header": "Authorization", "secret_ref": "keyring:MY_BOT_KEY", "prefix": "Bearer "},
  "response": {
    "answer": "reply.text",
    "retrieved_documents": {"path": "retrieval.hits", "each": {"id": "doc", "score": "score", "text": "snippet"}},
    "tool_calls": {"path": "trace.tools", "each": {"name": "tool", "arguments": "args", "result": "output"}},
    "usage": {"input_tokens": "usage.prompt", "output_tokens": "usage.completion"},
    "provider": {"provider": "model.vendor", "model": "model.name"}
  }
}
```

Templates: `{{input.message}}`, `{{input.fields.<name>}}` (per-case fields such as an
office or a plant code), `{{case}}`, `{{trial}}`, `{{uuid}}`, `{{hex16}}`. Use a fresh
`{{uuid}}` session per call so cases never share conversation history.

Paths: `a.b.0.c`, `a.b[0].c`, alternatives `id|code`, wildcards `sources.*.id` (over a list
or a mapping's values), literals `=value`. Inside `each`, a field may translate values:
`{"path": "ok", "map": {"true": "success", "false": "error"}}`.

## 2. Streamed replies (SSE / NDJSON)

Fold the stream into one object, then map it as above:

```json
"stream": {
  "format": "sse",
  "type_path": "type",
  "events": {
    "delta":   {"op": "concat", "path": "text", "into": "answer"},
    "sources": {"path": ".", "into": "sources"},
    "step":    {"op": "append", "path": "step", "into": "steps"},
    "done":    {"path": ".", "into": "done"},
    "error":   {"path": "message", "into": "error"}
  }
},
"response": {
  "answer": "answer",
  "retrieved_documents": {"path": "sources.sources", "each": {"id": "id|code", "title": "title", "text": "text"}},
  "citations_from_markers": {"pattern": "\\[(\\d+)\\]", "lookup": "sources.sources", "key": "n", "each": {"id": "id|code"}},
  "steps": {"path": "steps", "each": {"type": {"path": "kind", "map": {"searched": "retrieval", "written": "model_call"}},
                                       "name": "kind", "duration_ms": "ms"}}
}
```

The event name comes from the SSE `event:` line when present, otherwise from `type_path` in
the data. Ops: `concat`, `set`, `append`, `merge`. Comments and keep-alive pings are ignored.
Inline citation markers that resolve to nothing become `marker:N` citations, which
`citation_validity` reports as dangling.

## 3. Systems that save every conversation

If each question creates a stored conversation, add a clean-up request. It runs after the
answer, with the collected stream available as `raw`:

```json
"cleanup": {"method": "DELETE", "endpoint": "/api/conversations/{{raw.done.conversation_id}}",
            "only_if": "done.conversation_id"}
```

Check what else a question writes (usage tables, shared logs, budgets) before pointing
GaugeLab at a shared instance. When the side effects are not acceptable, run an isolated
instance or use the importer.

## 4. Grading logged answers without calling the system

```yaml
# import.yaml
case_id: id
message: question
category: intent
latency_s: seconds
exclude: {cached: true}
newest_first: true
limit: 300
skip_invalid_lines: true
attach: {path_template: "evidence/{{record.id}}.json", into: evidence}
join:
  - {file: spend.jsonl, key: turn, on: id, into: spend}
response:
  answer: answer
  retrieved_documents: {path: "evidence.ev.*", each: {id: "doc_id|citation", text: "context|text"}}
  citations_from_markers: {pattern: "\\[([^\\]\\[]{3,200})\\]", lookup: "evidence.ev.*", key: citation, each: {id: "doc_id|citation"}}
  usage: {input_tokens: spend.answer_in, output_tokens: spend.answer_out}
```

```bash
gaugelab import logs/journal.jsonl --config import.yaml --name "Production journal" --project "My bot"
```

This creates a dataset of the logged questions (inputs only, since nobody has written
expectations for them yet) and a `replay` target. Run black-box evaluators on it (latency,
citation validity, numbers grounded, relevance or groundedness judges). Add expected
outcomes to the cases you care about, and the same dataset becomes a golden set.

## 5. Experiment as code

```yaml
experiment: {name: my-bot-golden}
project: My bot
dataset: {path: golden.yaml}
target:
  name: My bot (staging)
  adapter: http
  config: { ... as above ... }
trials: 3
evaluators: [regex, citation_validity, latency, relevance, groundedness]
judge: {provider: ollama, model: "llama3.1:8b"}
gates: {overall_pass_rate: {min: 0.85}}
```

```bash
gaugelab run my-bot.yaml        # exits 1 if a gate fails
```

Keep files that name internal systems in `local/`, which is ignored by git.
