"""Retrieval for the demo agent: BM25 (lexical), a local hashed character-n-gram embedding
(dense-style, no model download), reciprocal-rank fusion, and an entity-aware reranker.

The 'dense' vectors are TF-IDF weighted character trigrams - deterministic and offline. They
behave like a weak embedding (robust to word forms, blind to meaning) and are labelled as such.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass
from functools import cache
from pathlib import Path

DOCS_DIR = Path(__file__).resolve().parents[1] / "docs"

STOP = set(["a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "is", "are", "was", "were", "be", "been", "it", "its", "this", "that", "with", "as", "at", "by", "from", "your", "you", "i", "we", "our", "can", "will", "do", "does", "did", "has", "have", "had", "if", "then", "than", "so", "but", "which", "what", "when", "how", "my", "me", "there", "their", "any", "all", "about", "into", "up", "out"])

PRODUCT_NAMES = ["device alpha classic", "alpha classic", "device beta pro", "beta pro", "device alpha",
                 "device beta", "device gamma", "adapter c", "adapter d", "mount kit m1"]


def words(text: str) -> list[str]:
    toks = re.findall(r"[a-z0-9][a-z0-9+.-]*", text.lower())
    out = []
    for t in toks:
        t = t.strip(".-")
        if not t or t in STOP:
            continue
        if len(t) > 4 and t.endswith("s") and not t.endswith("ss"):
            t = t[:-1]
        out.append(t)
    return out


@dataclass
class Chunk:
    id: str
    doc_id: str
    title: str
    heading: str
    text: str


@cache
def load_chunks() -> tuple[Chunk, ...]:
    chunks: list[Chunk] = []
    for path in sorted(DOCS_DIR.glob("*.md")):
        raw = path.read_text(encoding="utf-8")
        title = raw.splitlines()[0].lstrip("# ").strip()
        parts = re.split(r"\n(?=## )", raw)
        for i, part in enumerate(parts):
            lines = part.strip().splitlines()
            heading = lines[0].lstrip("# ").strip() if lines else title
            body = "\n".join(lines[1:]).strip() if i > 0 or len(parts) == 1 else "\n".join(lines[1:]).strip()
            if not body:
                continue
            chunks.append(Chunk(id=f"{path.stem}#{i}", doc_id=path.stem, title=title, heading=heading,
                                text=f"{title}. {heading}. {body}" if heading != title else f"{title}. {body}"))
    return tuple(chunks)


class BM25:
    def __init__(self, chunks: tuple[Chunk, ...], k1: float = 1.2, b: float = 0.75):
        self.chunks = chunks
        self.k1, self.b = k1, b
        self.tfs = [Counter(words(c.text)) for c in chunks]
        self.lens = [sum(tf.values()) for tf in self.tfs]
        self.avg = sum(self.lens) / len(self.lens)
        df: Counter[str] = Counter()
        for tf in self.tfs:
            df.update(tf.keys())
        n = len(chunks)
        self.idf = {w: math.log(1 + (n - d + 0.5) / (d + 0.5)) for w, d in df.items()}

    def search(self, query: str, k: int) -> list[tuple[Chunk, float]]:
        q = words(query)
        scores = []
        for i, tf in enumerate(self.tfs):
            s = 0.0
            for w in q:
                if w in tf:
                    f = tf[w]
                    s += self.idf.get(w, 0) * f * (self.k1 + 1) / (f + self.k1 * (1 - self.b + self.b * self.lens[i] / self.avg))
            scores.append(s)
        order = sorted(range(len(scores)), key=lambda i: -scores[i])[:k]
        return [(self.chunks[i], scores[i]) for i in order if scores[i] > 0]


def _grams(text: str) -> Counter[str]:
    g: Counter[str] = Counter()
    for w in words(text):
        w = f"#{w}#"
        for i in range(len(w) - 2):
            g[w[i : i + 3]] += 1
    return g


class NgramEmbedding:
    def __init__(self, chunks: tuple[Chunk, ...]):
        self.chunks = chunks
        grams = [_grams(c.text) for c in chunks]
        df: Counter[str] = Counter()
        for g in grams:
            df.update(g.keys())
        n = len(chunks)
        self.idf = {k: math.log((1 + n) / (1 + d)) + 1 for k, d in df.items()}
        self.vecs = [self._vec(g) for g in grams]

    def _vec(self, g: Counter[str]) -> dict[str, float]:
        v = {k: c * self.idf.get(k, 1.0) for k, c in g.items()}
        norm = math.sqrt(sum(x * x for x in v.values())) or 1.0
        return {k: x / norm for k, x in v.items()}

    def search(self, query: str, k: int) -> list[tuple[Chunk, float]]:
        q = self._vec(_grams(query))
        scores = [sum(q.get(t, 0.0) * w for t, w in v.items()) for v in self.vecs]
        order = sorted(range(len(scores)), key=lambda i: -scores[i])[:k]
        return [(self.chunks[i], scores[i]) for i in order]


@cache
def indexes() -> tuple[BM25, NgramEmbedding]:
    chunks = load_chunks()
    return BM25(chunks), NgramEmbedding(chunks)


def mentioned_products(text: str) -> list[str]:
    t = text.lower()
    found = []
    for name in PRODUCT_NAMES:
        if re.search(rf"\b{re.escape(name)}\b", t) and not any(name in f for f in found):
            found.append(name)
    return found


def rerank_score(query: str, chunk: Chunk) -> float:
    """Entity-aware rerank: overlap with the question, a boost when the chunk's product matches
    the product asked about, a penalty for a sibling product (Classic / Pro) not asked about."""
    q = set(words(query))
    c = set(words(chunk.text))
    score = len(q & c) / (len(q) or 1)
    asked = mentioned_products(query)
    title = chunk.title.lower()
    for name in asked:
        if name.replace("device ", "") in title:
            score += 0.5
    for sibling in ("classic", "pro"):
        if sibling in title and not any(sibling in a for a in asked) and asked:
            score -= 0.6
    return score


def retrieve(query: str, mode: str = "lexical", top_k: int = 5, pool: int = 20) -> list[tuple[Chunk, float]]:
    """Returns ranked CHUNKS (best per document first), up to top_k distinct documents."""
    bm25, emb = indexes()
    if mode == "lexical":
        ranked = bm25.search(query, pool)
    elif mode == "hybrid":
        lists = [bm25.search(query, pool), emb.search(query, pool)]
        fused: dict[str, float] = {}
        by_id: dict[str, Chunk] = {}
        for lst in lists:
            for rank, (ch, _) in enumerate(lst, start=1):
                fused[ch.id] = fused.get(ch.id, 0.0) + 1.0 / (60 + rank)  # reciprocal-rank fusion
                by_id[ch.id] = ch
        candidates = sorted(fused, key=lambda i: -fused[i])[:pool]
        ranked = sorted(((by_id[i], rerank_score(query, by_id[i]) + fused[i]) for i in candidates),
                        key=lambda x: -x[1])
    else:
        raise ValueError(f"unknown retrieval mode {mode!r}")
    out, seen = [], set()
    for ch, sc in ranked:
        if ch.doc_id in seen:
            continue
        seen.add(ch.doc_id)
        out.append((ch, sc))
        if len(out) == top_k:
            break
    return out


def chunks_for(doc_ids: list[str], query: str, per_doc: int = 2) -> list[Chunk]:
    """The best chunks of the given documents for the query (what goes into the prompt)."""
    q = set(words(query))
    out = []
    for d in doc_ids:
        cs = [c for c in load_chunks() if c.doc_id == d]
        cs.sort(key=lambda c: -len(q & set(words(c.text))))
        out.extend(cs[:per_doc])
    return out
