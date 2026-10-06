"""The Acme agent over HTTP, with a deliberately non-GaugeLab response shape so the HTTP
adapter's field mapping has something real to map.

    POST /chat {"message": "...", "variant": "candidate", "seed": 0}
    -> {"reply": {"text", "sources": [{"doc"}]}, "retrieval": {"hits": [...]},
        "trace": {"tools": [...]}, "usage": {"prompt", "completion"}, "model": {...}}
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel

from .agent import VARIANTS, run

app = FastAPI(title="Acme support agent (fictional demo)")


class ChatIn(BaseModel):
    message: str
    variant: str = "candidate"
    seed: int | str = 0


@app.get("/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "variants": list(VARIANTS)}


@app.post("/chat")
def chat(body: ChatIn) -> dict[str, Any]:
    variant = body.variant if body.variant in VARIANTS else "candidate"
    r = run({"message": body.message}, {"variant": variant}, SimpleNamespace(seed=int(body.seed or 0)))
    return {
        "reply": {"text": r["answer"], "sources": [{"doc": c["id"]} for c in r["citations"]]},
        "retrieval": {"hits": [{"doc": d["id"], "title": d["title"], "score": d["score"], "snippet": d["text"]}
                               for d in r["retrieved_documents"]]},
        "trace": {"tools": [{"tool": t["name"], "args": t["arguments"], "output": t["result"], "status": t["status"]}
                            for t in r["tool_calls"]]},
        "usage": {"prompt": r["usage"]["input_tokens"], "completion": r["usage"]["output_tokens"]},
        "model": {"vendor": r["provider"]["provider"], "name": r["provider"]["model"]},
        "server_ms": r["latency_ms"],
    }
