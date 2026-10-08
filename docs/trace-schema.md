# Trace schema

A trace records what a trial observably did: the request, the steps the target chose to
report (retrieval, model calls, tool calls), errors, and every evaluator that graded it.
Assay does not require or store hidden reasoning. If a provider returns an explicit
reasoning summary, a target may report it as a step's `output_summary` like any other output.

## Span

| Field | Type | Notes |
|---|---|---|
| `span_id` | string | 16 hex chars |
| `parent_span_id` | string or null | null for the root (`target_request`) |
| `type` | enum | `target_request`, `retrieval`, `model_call`, `tool_call`, `tool_result`, `post_processing`, `evaluator`, `error` |
| `name` | string | e.g. `retrieve (hybrid)`, `tool: check_warranty`, `evaluate: recall_at_k` |
| `start_time`, `end_time` | epoch seconds | children are laid out from the root's start |
| `duration_ms` | number | as reported by the target, or measured |
| `status` | `ok` or `error` | |
| `input_summary`, `output_summary` | string | truncated to 300 characters |
| `metadata` | object | retrieval: `documents[{id,title,score}]`; tool: `tool`, `arguments`, `result`; evaluator: `evaluator`, `version`, `status`; root: `provider`, `missing_telemetry` |
| `usage` | object or null | `input_tokens`, `output_tokens`, `total_tokens` |
| `cost_usd` | number or null | estimated from the price table; null when unknown |
| `error` | string or null | |

## How a trace is built

- If the target reports **steps** (`NormalizedTargetResult.steps`), each becomes a child span
  with the target's own timings. Tool spans are joined to the reported tool calls in order.
  The first retrieval span lists the retrieved documents.
- If it reports **no steps**, Assay still adds a `retrieval (reported)` span when documents
  were returned and one `tool_call` span per tool call, without inventing timings.
- A black-box target produces a single `target_request` span. Its metadata lists the
  telemetry that was not reported.
- Evaluator spans are appended after the target's work, one per applicable evaluator.

Raw target payloads are stored after **redaction**: fields named like secrets (`api_key`,
`authorization`, `password`, `token`...) and anything shaped like an API key are replaced with
`[REDACTED]`. An experiment can add its own field names (`redact_fields`).

## Example (Acme candidate, run 2, `tool_01`, trial 1)

A stored trace, shortened only where marked (`...`). The agent's model is simulated, so its
timings follow the demo's documented cost model.

```json
{
  "trace_id": "998ef53e...",
  "spans": [
    {"type": "target_request", "name": "target request", "duration_ms": 2279.3, "status": "ok",
     "input_summary": "Is order 18372 still covered by warranty?",
     "output_summary": "Yes. Order 18372 (Device Alpha, serial ACME-A-00123) is under warranty: the warranty is active until 2027-03-10.",
     "usage": {"input_tokens": 1182, "output_tokens": 52, "total_tokens": 1234}, "cost_usd": 0.000556,
     "metadata": {"provider": {"provider": "acme-sim", "model": "acme-sim-1"}, "missing_telemetry": []}},
    {"type": "retrieval", "name": "retrieve (hybrid)", "duration_ms": 181.6,
     "output_summary": "warranty, device_alpha_classic, device_beta, shipping, device_gamma",
     "metadata": {"mode": "hybrid", "top_k": 5,
                  "documents": [{"id": "warranty", "score": 0.4328}, {"id": "device_alpha_classic", "score": 0.4323}, "..."]}},
    {"type": "model_call", "name": "plan", "duration_ms": 948.9, "output_summary": "intent=warranty",
     "usage": {"input_tokens": 430, "output_tokens": 30, "total_tokens": 460}, "cost_usd": 0.00022},
    {"type": "tool_call", "name": "tool: lookup_order", "duration_ms": 119.7,
     "metadata": {"tool": "lookup_order", "arguments": {"order_id": "18372"},
                  "result": {"order_id": "18372", "product": "Device Alpha", "serial_number": "ACME-A-00123",
                             "purchase_date": "2025-03-10", "region": "Northvale", "status": "delivered"}}},
    {"type": "tool_call", "name": "tool: check_warranty", "duration_ms": 137.4,
     "metadata": {"tool": "check_warranty", "arguments": {"serial_number": "ACME-A-00123"},
                  "result": {"warranty_status": "active", "expires_on": "2027-03-10", "plan": "standard", "...": "..."}}},
    {"type": "model_call", "name": "answer", "duration_ms": 885.5,
     "usage": {"input_tokens": 752, "output_tokens": 22, "total_tokens": 774}, "cost_usd": 0.000336},
    {"type": "post_processing", "name": "format citations", "duration_ms": 6.2},
    "... one evaluator span per applicable evaluator ..."
  ]
}
```

`span_id` / `parent_span_id` are omitted above: every span after the first has the root as
its parent. `GET /api/traces/{trial_id}` returns the full record.

## OpenTelemetry

Exporting to an OpenTelemetry collector is not implemented. The span fields above map
directly to OTel spans (name, kind, start/end, status, attributes), so an exporter is a
contained addition that touches nothing else.
