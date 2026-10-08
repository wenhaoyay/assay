# Acme support agent (fictional)

A small RAG + tool-using support agent for **Acme Devices**, a company that does not exist.
It is the system under test for Assay's demo. It is not the product.

Everything here is invented: 20 short documents in `docs/` (products, warranty, returns,
regional policies, troubleshooting...), seven orders in `app/data.py`, and five tools in
`app/tools.py`:

| Tool | Behaviour |
|---|---|
| `lookup_order(order_id)` | order -> product, serial, purchase date, region. Order `99999` always fails ("order service timeout"). |
| `check_warranty(serial_number)` | status `active`/`expired` from the purchase date ("today" is fixed at 2026-01-15). Serial `ACME-E-00000` always fails. Any call fails transiently with 8% probability (seeded). |
| `check_compatibility(product_a, product_b)` | from a compatibility table |
| `get_return_policy(region)` | return window per region |
| `lookup_shipping_status(order_id)` | delivered / in transit / processing |

The documents include deliberate **retrieval traps**: a discontinued *Device Alpha Classic*
(12-month warranty, micro-USB, 16 devices) next to the current *Device Alpha* (24 months,
USB-C, 32 devices), and a *Beta Pro* (IPX4, 24 h) next to *Device Beta* (IPX7, 18 h).

## How it works

1. **Retrieval** over the documents, chunked by `##` section:
   - *lexical*: BM25;
   - *hybrid*: BM25 plus a local hashed character-trigram TF-IDF "embedding" (deterministic,
     no model download; robust to word forms, blind to meaning), fused with reciprocal-rank
     fusion, then an entity-aware reranker that boosts chunks about the product asked about
     and penalises sibling products (Classic, Pro) that were not asked about.
2. **Plan**: a rule-based "model" decides which tool, if any, the question needs.
3. **Answer**: templated from tool results, or extractive (the best-matching sentences of the
   top documents, with `[doc_id]` citations).

By default the model is **simulated**, so the demo is free, offline and exactly reproducible.
Latency and tokens follow a documented cost model (180 ms + 0.25 ms per input token + 16 ms
per output token, ±15% seeded jitter) instead of sleeping, and the price is a clearly
fictional `acme-sim-1` row in the price table. Pass `options.llm = {"model": "llama3.1:8b"}`
to write the final answers with a real local model through Ollama instead.

## Variants

| | baseline (A) | candidate (B) |
|---|---|---|
| Retrieval | BM25, top 5 | hybrid + RRF + rerank, pool 20, top 5 |
| Context given to the model | 2 documents | 4 documents (more tokens) |
| Refuses when evidence is weak | no | yes (IDF-weighted coverage of the question's terms < 0.6) |
| Injection guard | no: repeats what a user asks it to "confirm" | yes |
| Failed tool call | falls back to the documents and says nothing | retries a transient failure once, then admits the failure |
| Known slip | 30% of the time passes the order number to `check_warranty` instead of looking up the serial | none |
| Tool skipped by mistake | 10% | 3% |
| `get_return_policy` | not used | used |

The weaknesses are **mechanisms, not per-question scripts**. Assay's findings, including
the candidate's own regressions (an over-eager refusal rule, a return-policy tool that hides
the holiday exception), come out of running them.

## Running it

```bash
# As a Python target (what the seeded demo uses)
python -c "from acme_support_agent.app import run; print(run({'message': 'Is order 18372 still covered by warranty?'}, {'variant': 'candidate'})['answer'])"

# Over HTTP, with a deliberately different JSON shape so the HTTP adapter's mapping has work to do
assay demo-agent --port 9040
curl -s localhost:9040/chat -H 'content-type: application/json' -d '{"message": "Can I use Adapter C with Device Gamma?"}'
```
