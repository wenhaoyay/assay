"""Helpers behind the "Connect a chatbot" wizard.

Nothing here is required to connect a target - a configuration written by hand works the
same - but these turn the configuration into something you can build by pointing:

* ``parse_curl``       - a curl command (from DevTools, Postman...) -> request settings,
                         with secret-looking headers pulled out so they never sit in config;
* ``probe``            - send one question and return what came back, raw, including the
                         event types of a streamed reply;
* ``suggest_mapping``  - guess where the answer, sources, tool calls and usage are in a
                         reply (the wizard shows each guess; a person confirms it);
* ``STANDARD_MAPPING`` - the Assay reply shape: a bot that returns it needs no mapping;
* ``explain_error``    - a sentence a person can act on, instead of an exception name.
"""

from __future__ import annotations

import json
import re
import shlex
import time
import uuid
from typing import Any

import httpx

from assay.adapters.http import (
    HttpTargetConfig,
    StreamConfig,
    collect_stream,
    parse_ndjson,
    parse_sse,
    render,
    resolve_secret,
)
from assay.adapters.mapping import get_path

# --------------------------------------------------------------------------------------
# The standard reply shape
# --------------------------------------------------------------------------------------

STANDARD_SHAPE_EXAMPLE: dict[str, Any] = {
    "answer": "Device Alpha has a 24-month warranty [warranty].",
    "sources": [{"id": "warranty", "title": "Warranty policy", "text": "Every device ...", "score": 0.82}],
    "citations": ["warranty"],
    "tool_calls": [{"name": "lookup_order", "arguments": {"order_id": "18372"}, "result": {"status": "active"},
                    "status": "success"}],
    "usage": {"input_tokens": 900, "output_tokens": 40},
    "model": {"provider": "openai", "model": "gpt-x"},
}

# "gaugelab": connections saved before the project was renamed.
STANDARD_SHAPES = ("assay", "gaugelab")
STANDARD_MAPPING: dict[str, Any] = {
    "answer": "answer",
    "retrieved_documents": {"path": "sources", "each": {"id": "id", "title": "title", "score": "score", "text": "text"}},
    "citations": "citations",  # a list of ids, or of {id, title} objects
    "tool_calls": {"path": "tool_calls", "each": {"name": "name", "arguments": "arguments", "result": "result",
                                                   "status": "status"}},
    "usage": {"input_tokens": "usage.input_tokens", "output_tokens": "usage.output_tokens"},
    "provider": {"provider": "model.provider", "model": "model.model"},
}


def matches_standard(raw: Any) -> dict[str, Any]:
    """Does a reply follow the standard shape? Lists what is present, missing or malformed."""
    if not isinstance(raw, dict):
        return {"matches": False, "present": [], "missing": ["answer"], "problems": ["The reply is not a JSON object."]}
    present, missing, problems = [], [], []
    if isinstance(raw.get("answer"), str):
        present.append("answer")
    else:
        missing.append("answer")
        if "answer" in raw:
            problems.append("'answer' must be a string.")
    for key, check in (("sources", lambda v: isinstance(v, list) and all(isinstance(x, dict) and "id" in x for x in v)),
                       ("citations", lambda v: isinstance(v, list)),
                       ("tool_calls", lambda v: isinstance(v, list) and all(isinstance(x, dict) and "name" in x for x in v)),
                       ("usage", lambda v: isinstance(v, dict))):
        if key not in raw:
            missing.append(key)
        elif check(raw[key]):
            present.append(key)
        else:
            problems.append(f"'{key}' is not in the expected form.")
    return {"matches": "answer" in present and not problems, "present": present, "missing": missing,
            "problems": problems}


# --------------------------------------------------------------------------------------
# curl -> request settings
# --------------------------------------------------------------------------------------

_SECRET_HEADER = re.compile(r"^(authorization|x-api-key|api-key|x-auth-token|cookie|x-access-token|ocp-apim-subscription-key)$",
                            re.I)
_QUESTION_KEYS = ("message", "question", "query", "prompt", "input", "text", "content", "q")


def _find_question(body: Any, path: str = "") -> str | None:
    """The body field that most likely carries the user's question."""
    if isinstance(body, dict):
        for k in _QUESTION_KEYS:
            if isinstance(body.get(k), str):
                return f"{path}{k}"
        # OpenAI-style messages: the last user message's content
        msgs = body.get("messages")
        if isinstance(msgs, list) and msgs:
            for i in range(len(msgs) - 1, -1, -1):
                if isinstance(msgs[i], dict) and msgs[i].get("role") == "user" and isinstance(msgs[i].get("content"), str):
                    return f"{path}messages.{i}.content"
        for k, v in body.items():
            found = _find_question(v, f"{path}{k}.")
            if found:
                return found
    return None


def _set(body: Any, path: str, value: Any) -> Any:
    parts = path.split(".")
    cur = body
    for p in parts[:-1]:
        cur = cur[int(p)] if isinstance(cur, list) else cur[p]
    last = parts[-1]
    if isinstance(cur, list):
        cur[int(last)] = value
    else:
        cur[last] = value
    return body


def parse_curl(command: str) -> dict[str, Any]:
    """Turn a curl command into request settings. Secret headers come back separately."""
    text = command.strip().replace("\\\r\n", " ").replace("\\\n", " ").replace("^\r\n", " ").replace("^\n", " ")
    try:
        tokens = shlex.split(text, posix=True)
    except ValueError as exc:
        raise ValueError(f"Could not read the command: {exc}") from exc
    if not tokens or tokens[0].lower() not in ("curl", "curl.exe"):
        raise ValueError("Paste a command that starts with curl.")
    url, method, headers, data = None, None, {}, None
    i = 1
    while i < len(tokens):
        tok = tokens[i]
        nxt = tokens[i + 1] if i + 1 < len(tokens) else None
        if tok in ("-X", "--request") and nxt:
            method, i = nxt.upper(), i + 2
            continue
        if tok in ("-H", "--header") and nxt:
            k, _, v = nxt.partition(":")
            headers[k.strip()] = v.strip()
            i += 2
            continue
        if tok in ("-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--json") and nxt is not None:
            data = nxt
            if tok == "--json":
                headers.setdefault("Content-Type", "application/json")
            i += 2
            continue
        if tok in ("-u", "--user") and nxt:
            headers["Authorization"] = "Basic <from -u>"
            i += 2
            continue
        if tok.startswith("-"):
            # flags without values we can ignore (-s, -L, --compressed, -N...); skip a value for known ones
            i += 2 if tok in ("-o", "--output", "-A", "--user-agent", "-e", "--referer", "-b", "--cookie",
                              "--connect-timeout", "-m", "--max-time") else 1
            continue
        if url is None:
            url = tok
        i += 1
    if not url:
        raise ValueError("No URL found in the command.")
    method = method or ("POST" if data is not None else "GET")
    m = re.match(r"^(https?://[^/]+)(/[^?#]*)?(\?[^#]*)?", url)
    if not m:
        raise ValueError("The URL must start with http:// or https://")
    base_url, endpoint = m.group(1), m.group(2) or "/"
    query = {}
    if m.group(3):
        for pair in m.group(3)[1:].split("&"):
            if pair:
                k, _, v = pair.partition("=")
                query[k] = v
    body: Any = None
    if data is not None:
        try:
            body = json.loads(data)
        except json.JSONDecodeError:
            body = data
    secrets, plain = [], {}
    for k, v in headers.items():
        if _SECRET_HEADER.match(k) or re.search(r"(token|secret|key)", k, re.I):
            prefix = ""
            value = v
            for p in ("Bearer ", "Basic ", "Token "):
                if v.startswith(p):
                    prefix, value = p, v[len(p):]
            secrets.append({"header": k, "prefix": prefix, "value": value,
                            "hint": f"••••{value[-4:]}" if len(value) >= 8 else "••••"})
        elif k.lower() not in ("content-length", "accept-encoding", "user-agent", "origin", "referer", "host",
                               "sec-fetch-mode", "sec-fetch-site", "sec-fetch-dest", "connection"):
            plain[k] = v
    question_path = _find_question(body) if isinstance(body, (dict, list)) else None
    templated = json.loads(json.dumps(body)) if isinstance(body, (dict, list)) else body
    if question_path and isinstance(templated, (dict, list)):
        templated = _set(templated, question_path, "{{input.message}}")
    session_keys = [k for k in (body or {}) if isinstance(body, dict) and re.search(r"(session|conversation|thread|chat)_?id", k, re.I)]
    streaming = "text/event-stream" in json.dumps(headers).lower() or bool(isinstance(body, dict) and body.get("stream"))
    return {
        "base_url": base_url, "endpoint": endpoint, "method": "GET" if method == "GET" else "POST",
        "headers": plain, "query": query, "body": body, "body_template": templated,
        "question_path": question_path, "secrets": secrets, "session_fields": session_keys,
        "looks_streaming": streaming,
    }


# --------------------------------------------------------------------------------------
# One request, everything that came back
# --------------------------------------------------------------------------------------


async def probe(config: dict[str, Any], message: str) -> dict[str, Any]:
    """Send one question with the request settings and report the reply as received."""
    cfg = HttpTargetConfig.model_validate(config)
    scope = {"input": {"message": message, "history": [], "fields": {}}, "case": "connection-test", "trial": 0,
             "uuid": str(uuid.uuid4()), "hex16": uuid.uuid4().hex[:16]}
    url = cfg.base_url.rstrip("/") + "/" + render(cfg.endpoint, scope).lstrip("/")
    headers = dict(cfg.headers)
    if cfg.auth:
        headers[cfg.auth.header] = cfg.auth.prefix + resolve_secret(cfg.auth.secret_ref)
    params = {k: v for k, v in render(cfg.query, scope).items() if v not in (None, "")}
    t0 = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=cfg.timeout_s, verify=cfg.verify_tls) as client:
            if cfg.method == "GET":
                resp = await client.get(url, params=params, headers=headers)
            else:
                resp = await client.post(url, params=params, json=render(cfg.body, scope), headers=headers)
    except (httpx.TimeoutException, httpx.TransportError) as exc:
        return {"ok": False, "url": url, "error": f"{type(exc).__name__} calling {url}",
                "explanation": explain_error(f"{type(exc).__name__} calling {url}", timeout_s=cfg.timeout_s)}
    elapsed = round((time.perf_counter() - t0) * 1000, 1)
    ctype = resp.headers.get("content-type", "")
    out: dict[str, Any] = {"ok": resp.status_code < 400, "url": url, "status": resp.status_code,
                           "content_type": ctype, "elapsed_ms": elapsed}
    if resp.status_code >= 400:
        out["error"] = f"HTTP {resp.status_code}: {resp.text[:300]}"
        out["explanation"] = explain_error(out["error"])
        return out
    text = resp.text
    if "event-stream" in ctype or text.lstrip().startswith(("data:", "event:")):
        events = parse_sse(text)
        out["kind"] = "sse"
    elif "ndjson" in ctype or "jsonl" in ctype:
        events = parse_ndjson(text)
        out["kind"] = "ndjson"
    else:
        events = None
    if events is not None:
        types: dict[str, dict[str, Any]] = {}
        for name, data in events:
            etype = name or (data.get("type") if isinstance(data, dict) else None) or "message"
            entry = types.setdefault(etype, {"type": etype, "count": 0, "sample": data})
            entry["count"] += 1
        out["events"] = list(types.values())[:20]
        out["stream_suggestion"] = suggest_stream(events)
        # Fold the stream as it will be folded, so the reply can be mapped like any JSON reply:
        # the answer from the text pieces, the sources from the event that carries them.
        try:
            rules = cfg.stream if cfg.stream is not None else StreamConfig.model_validate(out["stream_suggestion"])
            collected = {k: v for k, v in collect_stream(events, rules).items() if k != "_events"}
            out["collected"] = collected
            out["suggestion"] = suggest_mapping(collected)
        except Exception:  # a suggestion is a convenience; the probe result stands without it
            pass
        return out
    try:
        out["kind"], out["json"] = "json", resp.json()
    except json.JSONDecodeError:
        out["kind"], out["text"] = "text", text[:5000]
    return out


def suggest_stream(events: list[tuple[str | None, Any]]) -> dict[str, Any]:
    """A stream reducer guess: text deltas are concatenated into the answer, the rest kept by type."""
    rules: dict[str, Any] = {}
    type_path = "type"
    for name, data in events:
        etype = name or (data.get("type") if isinstance(data, dict) else None) or "message"
        if etype in rules:
            continue
        if isinstance(data, dict):
            text_key = next((k for k in ("delta", "text", "content", "token", "chunk") if isinstance(data.get(k), str)), None)
            if text_key and len(str(data.get(text_key))) < 400:
                rules[etype] = {"op": "concat", "path": text_key, "into": "answer"}
                continue
            choice = (data.get("choices") or [{}])[0] if isinstance(data.get("choices"), list) else None
            if isinstance(choice, dict) and isinstance((choice.get("delta") or {}).get("content"), str):
                rules[etype] = {"op": "concat", "path": "choices.0.delta.content", "into": "answer"}
                continue
            rules[etype] = {"op": "set", "path": ".", "into": etype}
        elif isinstance(data, str):
            rules[etype] = {"op": "concat", "path": ".", "into": "answer"}
    return {"format": "sse", "type_path": type_path, "events": rules}


# --------------------------------------------------------------------------------------
# Mapping suggestions
# --------------------------------------------------------------------------------------

_ANSWER_KEYS = ("answer", "output", "reply", "response", "text", "content", "message", "result", "completion")
_SOURCE_KEYS = ("sources", "documents", "docs", "hits", "context", "contexts", "retrieved", "references", "chunks",
                "passages", "results", "evidence")
_ID_KEYS = ("id", "doc_id", "document_id", "source_id", "doc", "code", "key", "url", "source", "name", "title")
_TEXT_KEYS = ("text", "content", "snippet", "chunk", "page_content", "passage", "body")
_SCORE_KEYS = ("score", "similarity", "relevance", "distance", "sim", "rank_score")


def _walk(node: Any, path: str = ""):
    yield path, node
    if isinstance(node, dict):
        for k, v in node.items():
            yield from _walk(v, f"{path}.{k}" if path else str(k))
    elif isinstance(node, list) and node:
        yield from _walk(node[0], f"{path}.0" if path else "0")


def _first_key(d: dict[str, Any], keys: tuple[str, ...]) -> str | None:
    lower = {k.lower(): k for k in d}
    for k in keys:
        if k in lower:
            return lower[k]
    return None


def suggest_mapping(raw: Any) -> dict[str, Any]:
    """Guess a response mapping from one reply. Each guess carries a reason; nothing is final."""
    out: dict[str, Any] = {"mapping": {}, "reasons": {}, "standard": matches_standard(raw)}
    if out["standard"]["matches"]:
        out["mapping"] = dict(STANDARD_MAPPING)
        out["reasons"]["answer"] = "The reply follows the standard Assay shape."
        return out
    if not isinstance(raw, (dict, list)):
        out["mapping"]["answer"] = "."
        out["reasons"]["answer"] = "The reply is plain text; all of it is the answer."
        return out
    nodes = list(_walk(raw))
    # answer: a string under a well-known key, else the longest string
    strings = [(p, v) for p, v in nodes if isinstance(v, str) and p]
    best = None
    for key in _ANSWER_KEYS:
        cands = [(p, v) for p, v in strings if p.split(".")[-1].lower() == key]
        if cands:
            best = max(cands, key=lambda pv: len(pv[1]))
            out["reasons"]["answer"] = f"'{best[0]}' is a text field named '{key}'."
            break
    if best is None and strings:
        best = max(strings, key=lambda pv: len(pv[1]))
        out["reasons"]["answer"] = f"'{best[0]}' is the longest text in the reply."
    if best:
        out["mapping"]["answer"] = best[0]
    # sources: lists of objects with an id-like field; prefer ones that also carry text and a score.
    # A list that only names documents (no text) and is called sources/citations reads as citations.
    lists: list[tuple[int, str, dict[str, Any], str, str | None, str | None]] = []
    for p, v in nodes:
        if not (isinstance(v, list) and v and all(isinstance(x, dict) for x in v[:5])):
            continue
        last = p.split(".")[-1].lower() if p else ""
        if last in ("tool_calls", "tools", "steps", "messages", "choices", "events"):
            continue
        sample: dict[str, Any] = {}  # items differ (a table record next to a passage): read the first few together
        for x in v[:8]:
            sample.update({k: val for k, val in x.items() if k not in sample})
        idk, textk = _first_key(sample, _ID_KEYS), _first_key(sample, _TEXT_KEYS)
        if not idk:
            continue
        sk = _first_key(sample, _SCORE_KEYS)
        rank = 3 * bool(textk and textk != idk) + (last in _SOURCE_KEYS) + bool(sk) + ("retriev" in p.lower())
        lists.append((rank, p, sample, idk, textk, sk))
    lists.sort(key=lambda c: -c[0])
    if lists:
        rank, p, sample, idk, textk, sk = lists[0]
        # A document id names the document (what a question set expects); a passage id, one piece of it.
        doc = _first_key(sample, ("doc_id", "document_id", "source_id", "doc"))
        each: dict[str, str] = {"id": f"{doc}|{idk}" if doc and doc != idk else idk}
        titles = [k for k in ("doc_title", "document_title", "source_title", "title", "name", "heading")
                  if (k2 := _first_key(sample, (k,))) and k2 != idk]
        if titles:
            each["title"] = "|".join(titles[:2])
        if textk and textk != idk:
            each["text"] = textk
        if rows := _first_key(sample, ("rows", "table", "records")):
            each["text"] = f"{each['text']}|{rows}" if "text" in each else rows
        if sk:
            each["score"] = sk
        for extra in ("label", "page", "date", "n"):
            if (k := _first_key(sample, (extra,))) and k not in each.values():
                each[extra] = k
        out["mapping"]["retrieved_documents"] = {"path": p.replace(".0.", ".*.") if p else ".", "each": each}
        out["reasons"]["retrieved_documents"] = (f"'{p}' is a list of objects with '{idk}'"
                                                 + (f" and text in '{textk}'." if textk and textk != idk else "."))
        for _, p2, _s2, id2, text2, _ in lists[1:]:
            last2 = p2.split(".")[-1].lower()
            if not text2 and last2 in ("sources", "citations", "references", "cited"):
                out["mapping"]["citations"] = {"path": p2, "each": {"id": id2}}
                out["reasons"]["citations"] = f"'{p2}' lists document ids without text: the documents the answer cites."
                break
        # Inline markers such as [3] in the answer, numbered like the source list: the citations.
        answer_text = get_path(raw, out["mapping"].get("answer") or "") if out["mapping"].get("answer") else None
        num_key = _first_key(sample, ("n", "num", "number", "index", "ref", "marker"))
        if isinstance(answer_text, str) and num_key and re.search(r"\[\d+\]", answer_text):
            cite_each = {k: v for k, v in each.items() if k in ("id", "title", "label", "page")}
            if "text" in each:
                cite_each["quote"] = each["text"]
            cite_each["n"] = num_key
            out["mapping"].pop("citations", None)
            out["mapping"]["citations_from_markers"] = {"pattern": r"\[(\d+)\]", "lookup": p, "key": num_key,
                                                        "each": cite_each}
            out["reasons"]["citations"] = (f"The answer has markers like [1], numbered like '{p}' by '{num_key}': "
                                           "each marker is a citation of that source.")
    # tool calls: a list of objects with a name and arguments
    for p, v in nodes:
        if isinstance(v, list) and v and isinstance(v[0], dict):
            s = v[0]
            fn = s.get("function") if isinstance(s.get("function"), dict) else None
            if fn and "name" in fn:
                out["mapping"]["tool_calls"] = {"path": p, "each": {"name": "function.name", "arguments": "function.arguments"}}
                out["reasons"]["tool_calls"] = f"'{p}' holds OpenAI-style function calls."
                break
            namek = _first_key(s, ("name", "tool", "tool_name", "function"))
            argk = _first_key(s, ("arguments", "args", "input", "parameters", "params"))
            if namek and argk:
                each = {"name": namek, "arguments": argk}
                if rk := _first_key(s, ("result", "output", "response", "observation")):
                    each["result"] = rk
                out["mapping"]["tool_calls"] = {"path": p, "each": each}
                out["reasons"]["tool_calls"] = f"'{p}' is a list of objects with '{namek}' and '{argk}'."
                break
    # citations: a list of strings or objects under a citation-like key
    for p, v in nodes:
        last = p.split(".")[-1].lower() if p else ""
        if "citations" in out["mapping"]:
            break
        if last in ("citations", "cited", "cites", "references_used") and isinstance(v, list):
            out["mapping"]["citations"] = p
            out["reasons"]["citations"] = f"'{p}' is named like a citation list."
            break
    # usage
    usage: dict[str, str] = {}
    for p, v in nodes:
        last = p.split(".")[-1].lower() if p else ""
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            in_usage = "usage" in p.lower() or "token" in p.lower()
            if last in ("prompt_tokens", "input_tokens", "prompt_eval_count", "tokens_in") or                     (in_usage and last in ("input", "prompt", "in")):
                usage.setdefault("input_tokens", p)
            elif last in ("completion_tokens", "output_tokens", "eval_count", "tokens_out") or                     (in_usage and last in ("output", "completion", "out")):
                usage.setdefault("output_tokens", p)
    if usage:
        out["mapping"]["usage"] = usage
        out["reasons"]["usage"] = "Token counts found: " + ", ".join(usage.values()) + "."
    # model
    for p, v in nodes:
        parts = p.lower().split(".") if p else []
        named = parts and (parts[-1] in ("model", "model_name", "model_id")
                           or (parts[-1] in ("name", "id") and len(parts) > 1 and parts[-2] == "model"))
        if named and isinstance(v, str):
            out["mapping"]["provider"] = {"model": p}
            out["reasons"]["provider"] = f"'{p}' names the model."
            break
    return out


CAPABILITIES = [
    {"field": "answer", "label": "Answer", "unlocks": "correctness, relevance, must-mention, refusal checks"},
    {"field": "retrieved_documents", "label": "Sources",
     "unlocks": "recall@k, MRR, groundedness, numbers grounded, citation checks"},
    {"field": "citations", "label": "Citations", "unlocks": "citation validity"},
    {"field": "tool_calls", "label": "Tool calls", "unlocks": "tool selection, arguments, forbidden and unnecessary tools"},
    {"field": "usage", "label": "Tokens", "unlocks": "token budgets and cost estimates"},
    {"field": "provider", "label": "Model name", "unlocks": "cost estimates from the price table"},
]


def capabilities(normalized: dict[str, Any] | None, mapping: dict[str, Any]) -> list[dict[str, Any]]:
    """What a mapping gives you: each telemetry field, whether it came back, and the checks it unlocks."""
    out = []
    for c in CAPABILITIES:
        f = c["field"]
        val = (normalized or {}).get(f)
        got = bool(val) if f != "answer" else bool((normalized or {}).get("answer"))
        mapped = f in mapping or (f == "citations" and "citations_from_markers" in mapping)
        out.append({**c, "mapped": mapped, "received": got,
                    "count": len(val) if isinstance(val, list) else None})
    return out


# --------------------------------------------------------------------------------------
# Errors a person can act on
# --------------------------------------------------------------------------------------


def explain_error(error: str | None, timeout_s: float | None = None) -> str | None:
    if not error:
        return None
    e = error.lower()
    if "http 401" in e or "http 403" in e:
        return "The key was refused. Check the API key (Settings > Models & keys, or the connection's secret)."
    if "http 404" in e:
        return "Nothing answers at that address. Check the base URL and the endpoint path."
    if "http 405" in e:
        return "The endpoint exists but not for this method. Try POST instead of GET (or the other way round)."
    if "http 400" in e or "http 422" in e:
        return "The bot rejected the request body. Compare the body template with what the bot expects."
    if "http 429" in e:
        return "The bot is rate-limiting. Lower the number of questions sent in parallel."
    if re.search(r"http 5\d\d", e):
        return "The bot crashed while answering (a server error on its side). Check its logs."
    if "connecterror" in e or "connecttimeout" in e or "connection" in e or "transport" in e:
        return "Could not connect. Is the bot running, and is the base URL (host and port) right?"
    if "timeout" in e:
        return f"No reply within {int(timeout_s or 60)} s. Is the bot running, and is it slow on its first call?"
    if "is not set" in e:
        return "A secret this connection needs is not set. Add it in Settings > Models & keys."
    if "no answer" in e or "answer" in e and "mapping" in e:
        return "The reply came back, but nothing is mapped as the answer."
    return None


# --------------------------------------------------------------------------------------
# Built-in connector templates
# --------------------------------------------------------------------------------------

BUILTIN_TEMPLATES: list[dict[str, Any]] = [
    {"id": "builtin:standard", "name": "Assay reply shape", "adapter": "http", "builtin": True,
     "description": "Your bot returns {answer, sources, citations, tool_calls, usage}. Nothing to map.",
     "config": {"base_url": "http://localhost:8000", "endpoint": "/eval", "method": "POST",
                "body": {"message": "{{input.message}}", "session_id": "eval-{{uuid}}"}, "reply_shape": "assay"}},
    {"id": "builtin:openai-chat", "name": "OpenAI-compatible chat", "adapter": "http", "builtin": True,
     "description": "Any /v1/chat/completions endpoint (OpenAI, Azure, vLLM, LM Studio, OpenRouter, a gateway).",
     "config": {"base_url": "https://api.openai.com", "endpoint": "/v1/chat/completions", "method": "POST",
                "auth": {"header": "Authorization", "secret_ref": "keyring:OPENAI_API_KEY", "prefix": "Bearer "},
                "body": {"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "{{input.message}}"}]},
                "response": {"answer": "choices.0.message.content",
                             "tool_calls": {"path": "choices.0.message.tool_calls",
                                            "each": {"name": "function.name", "arguments": "function.arguments"}},
                             "usage": {"input_tokens": "usage.prompt_tokens", "output_tokens": "usage.completion_tokens"},
                             "provider": {"provider": "=openai", "model": "model"}}}},
    {"id": "builtin:anthropic", "name": "Anthropic Messages", "adapter": "http", "builtin": True,
     "description": "The Messages API, for a model you want to evaluate directly.",
     "config": {"base_url": "https://api.anthropic.com", "endpoint": "/v1/messages", "method": "POST",
                "headers": {"anthropic-version": "2023-06-01"},
                "auth": {"header": "x-api-key", "secret_ref": "keyring:ANTHROPIC_API_KEY", "prefix": ""},
                "body": {"model": "claude-haiku-4-5", "max_tokens": 1024,
                         "messages": [{"role": "user", "content": "{{input.message}}"}]},
                "response": {"answer": "content.0.text",
                             "usage": {"input_tokens": "usage.input_tokens", "output_tokens": "usage.output_tokens"},
                             "provider": {"provider": "=anthropic", "model": "model"}}}},
    {"id": "builtin:langserve", "name": "LangServe", "adapter": "http", "builtin": True,
     "description": "A LangChain runnable served with LangServe (/invoke).",
     "config": {"base_url": "http://localhost:8000", "endpoint": "/chain/invoke", "method": "POST",
                "body": {"input": {"question": "{{input.message}}"}},
                "response": {"answer": "output.answer|output",
                             "retrieved_documents": {"path": "output.context",
                                                     "each": {"id": "metadata.source|metadata.id", "text": "page_content"}}}}},
    {"id": "builtin:flowise", "name": "Flowise", "adapter": "http", "builtin": True,
     "description": "A Flowise chatflow prediction endpoint.",
     "config": {"base_url": "http://localhost:3000", "endpoint": "/api/v1/prediction/<chatflow-id>", "method": "POST",
                "body": {"question": "{{input.message}}", "overrideConfig": {"sessionId": "eval-{{uuid}}"}},
                "response": {"answer": "text",
                             "retrieved_documents": {"path": "sourceDocuments",
                                                     "each": {"id": "metadata.source|metadata.id", "text": "pageContent"}}}}},
    {"id": "builtin:dify", "name": "Dify", "adapter": "http", "builtin": True,
     "description": "A Dify chat app (blocking mode).",
     "config": {"base_url": "http://localhost", "endpoint": "/v1/chat-messages", "method": "POST",
                "auth": {"header": "Authorization", "secret_ref": "keyring:DIFY_API_KEY", "prefix": "Bearer "},
                "body": {"query": "{{input.message}}", "inputs": {}, "response_mode": "blocking", "user": "assay-{{hex16}}"},
                "response": {"answer": "answer",
                             "retrieved_documents": {"path": "metadata.retriever_resources",
                                                     "each": {"id": "document_name|document_id", "text": "content",
                                                              "score": "score"}},
                             "usage": {"input_tokens": "metadata.usage.prompt_tokens",
                                       "output_tokens": "metadata.usage.completion_tokens"}}}},
    {"id": "builtin:n8n", "name": "n8n webhook", "adapter": "http", "builtin": True,
     "description": "An n8n workflow behind a webhook that responds with JSON.",
     "config": {"base_url": "http://localhost:5678", "endpoint": "/webhook/<path>", "method": "POST",
                "body": {"chatInput": "{{input.message}}", "sessionId": "eval-{{uuid}}"},
                "response": {"answer": "output|text"}}},
    {"id": "builtin:sse", "name": "Streaming chat (SSE)", "adapter": "http", "builtin": True,
     "description": "A bot that streams its reply as server-sent events: text deltas plus a sources event.",
     "config": {"base_url": "http://localhost:8080", "endpoint": "/api/chat", "method": "POST", "timeout_s": 120,
                "body": {"question": "{{input.message}}"},
                "stream": {"format": "sse", "type_path": "type",
                           "events": {"delta": {"op": "concat", "path": "text", "into": "answer"},
                                      "sources": {"path": "sources", "into": "sources"},
                                      "done": {"path": ".", "into": "done"}}},
                "response": {"answer": "answer",
                             "retrieved_documents": {"path": "sources", "each": {"id": "id", "title": "title", "text": "text"}}}}},
]
