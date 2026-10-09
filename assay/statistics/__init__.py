"""Statistics kept small enough to read in one sitting. Pure Python, seeded, reproducible.

* ``summarize`` - n, mean, median, sd, pass rate
* ``bootstrap_ci`` / ``paired_bootstrap_delta`` - percentile bootstrap, resampling CASES
  (trials of one case are not independent, so they move together)
* ``mcnemar_exact`` - paired pass/fail comparison on the same cases
* ``pass_at_k`` / ``pass_hat_k`` - repeated-trial reliability (unbiased estimators)
* ``binary_agreement`` / ``cohen_kappa`` / ``spearman`` / ``mae`` - judge calibration
"""

from __future__ import annotations

import math
import random
import statistics as st
import sys
from array import array
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass
from functools import lru_cache
from operator import itemgetter
from typing import Any

# --------------------------------------------------------------------------------------
# Aggregates
# --------------------------------------------------------------------------------------


@dataclass
class Summary:
    n: int
    mean: float | None
    median: float | None
    sd: float | None
    min: float | None
    max: float | None

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def summarize(values: Sequence[float]) -> Summary:
    vals = [float(v) for v in values if v is not None]
    if not vals:
        return Summary(0, None, None, None, None, None)
    return Summary(len(vals), st.fmean(vals), st.median(vals), st.stdev(vals) if len(vals) > 1 else None,
                   min(vals), max(vals))


def percentile(values: Sequence[float], q: float) -> float | None:
    """Linear-interpolation percentile (q in 0..100), same as numpy's default."""
    vals = sorted(float(v) for v in values if v is not None)
    if not vals:
        return None
    if len(vals) == 1:
        return vals[0]
    pos = (len(vals) - 1) * q / 100
    lo, hi = math.floor(pos), math.ceil(pos)
    return vals[lo] + (vals[hi] - vals[lo]) * (pos - lo)


# --------------------------------------------------------------------------------------
# Bootstrap
# --------------------------------------------------------------------------------------


@dataclass
class Interval:
    estimate: float | None
    low: float | None
    high: float | None
    n: int
    level: float = 0.95
    resamples: int = 0

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@lru_cache(maxsize=8)
def _resample_rows(n: int, resamples: int, seed: int) -> tuple[Callable[[Sequence[float]], Sequence[float]], ...]:
    """The index rows ``random.Random(seed).randrange(n)`` draws, resample after resample, one getter each.

    Identical to calling ``randrange`` n * resamples times, only faster: ``randrange(n)`` takes the top
    ``n.bit_length()`` bits of one 32-bit Mersenne Twister word and redraws when the result is ``>= n``, so the
    accepted draws are the words of one long ``getrandbits`` read, shifted, with the too-big ones dropped.
    They depend on (n, resamples, seed) and never on the values, so every metric of a size shares them.
    """
    rng = random.Random(seed)
    shift = 32 - n.bit_length()
    need = resamples * n
    idx: list[int] = []
    while len(idx) < need:
        m = max(1024, (need - len(idx)) * 2 + 64)
        words = array("I")
        words.frombytes(rng.getrandbits(32 * m).to_bytes(4 * m, "little"))
        if sys.byteorder == "big":
            words.byteswap()
        idx.extend(x for x in (w >> shift for w in words) if x < n)
    del idx[need:]
    return tuple(itemgetter(*idx[i * n:(i + 1) * n]) for i in range(resamples))


_BOOT_CACHE: dict[tuple[tuple[float, ...], int, float, int], Interval] = {}


def bootstrap_ci(values: Sequence[float], stat: Callable[[Sequence[float]], float] = st.fmean,
                 resamples: int = 2000, level: float = 0.95, seed: int = 20240601) -> Interval:
    vals = [float(v) for v in values if v is not None]
    n = len(vals)
    if n == 0:
        return Interval(None, None, None, 0, level, 0)
    est = stat(vals)
    if n == 1:
        return Interval(est, None, None, 1, level, 0)
    key = (tuple(vals), resamples, level, seed)
    if stat is st.fmean:
        if (hit := _BOOT_CACHE.get(key)) is not None:
            return Interval(**hit.as_dict())
        boots = sorted(st.fmean(row(vals)) for row in _resample_rows(n, resamples, seed))
    else:
        rng = random.Random(seed)
        boots = sorted(stat([vals[rng.randrange(n)] for _ in range(n)]) for _ in range(resamples))
    a = (1 - level) / 2
    out = Interval(est, percentile(boots, 100 * a), percentile(boots, 100 * (1 - a)), n, level, resamples)
    if stat is st.fmean:
        if len(_BOOT_CACHE) > 512:
            _BOOT_CACHE.clear()
        _BOOT_CACHE[key] = out
    return out


def paired_bootstrap_delta(pairs: Sequence[tuple[float, float]], resamples: int = 2000, level: float = 0.95,
                           seed: int = 20240601) -> Interval:
    """CI for mean(candidate) - mean(baseline) over the SAME cases (pairs = (baseline, candidate))."""
    diffs = [c - b for b, c in pairs]
    return bootstrap_ci(diffs, st.fmean, resamples, level, seed)


# --------------------------------------------------------------------------------------
# Paired binary comparison
# --------------------------------------------------------------------------------------


@dataclass
class McNemar:
    both_pass: int
    only_baseline: int  # passed baseline, failed candidate (regressions)
    only_candidate: int  # failed baseline, passed candidate (improvements)
    both_fail: int
    p_value: float | None  # exact two-sided binomial test on the discordant pairs

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def mcnemar_exact(pairs: Sequence[tuple[bool, bool]]) -> McNemar:
    bp = sum(1 for b, c in pairs if b and c)
    ob = sum(1 for b, c in pairs if b and not c)
    oc = sum(1 for b, c in pairs if not b and c)
    bf = sum(1 for b, c in pairs if not b and not c)
    n = ob + oc
    if n == 0:
        return McNemar(bp, ob, oc, bf, None)
    k = min(ob, oc)
    tail = sum(math.comb(n, i) for i in range(k + 1)) / 2**n
    return McNemar(bp, ob, oc, bf, min(1.0, 2 * tail))


# --------------------------------------------------------------------------------------
# Repeated trials
# --------------------------------------------------------------------------------------


def pass_at_k(n: int, c: int, k: int) -> float:
    """P(at least one of k trials passes), estimated from c passes in n trials (Chen et al. 2021)."""
    if k > n:
        raise ValueError("k cannot be more than the number of tries.")
    if n - c < k:
        return 1.0
    return 1.0 - math.comb(n - c, k) / math.comb(n, k)


def pass_hat_k(n: int, c: int, k: int) -> float:
    """P(all k trials pass) - the 'pass^k' consistency metric - estimated from c of n."""
    if k > n:
        raise ValueError("k cannot be more than the number of tries.")
    return math.comb(c, k) / math.comb(n, k)


# --------------------------------------------------------------------------------------
# Agreement (human vs judge)
# --------------------------------------------------------------------------------------


@dataclass
class Agreement:
    n: int
    accuracy: float | None
    precision: float | None  # for the FAIL class: of the judge's FAILs, how many a human also failed
    recall: float | None  # of the human's FAILs, how many the judge caught
    f1: float | None
    kappa: float | None
    confusion: dict[str, dict[str, int]]  # confusion[human][judge]
    positive: str

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def cohen_kappa(a: Sequence[str], b: Sequence[str]) -> float | None:
    n = len(a)
    if n == 0 or n != len(b):
        return None
    labels = sorted(set(a) | set(b))
    po = sum(1 for x, y in zip(a, b, strict=True) if x == y) / n
    pe = sum((sum(1 for x in a if x == lab) / n) * (sum(1 for y in b if y == lab) / n) for lab in labels)
    if pe == 1:
        return 1.0 if po == 1 else 0.0
    return (po - pe) / (1 - pe)


def binary_agreement(human: Sequence[str], judge: Sequence[str], positive: str = "FAIL",
                     labels: Sequence[str] = ("PASS", "FAIL", "UNKNOWN")) -> Agreement:
    """Precision/recall are reported for ``positive`` (default FAIL: catching bad answers is the job)."""
    n = len(human)
    confusion = {h: {j: 0 for j in labels} for h in labels}
    for h, j in zip(human, judge, strict=True):
        confusion.setdefault(h, {x: 0 for x in labels}).setdefault(j, 0)
        confusion[h][j] += 1
    if n == 0:
        return Agreement(0, None, None, None, None, None, confusion, positive)
    tp = sum(1 for h, j in zip(human, judge, strict=True) if h == positive and j == positive)
    fp = sum(1 for h, j in zip(human, judge, strict=True) if h != positive and j == positive)
    fn = sum(1 for h, j in zip(human, judge, strict=True) if h == positive and j != positive)
    acc = sum(1 for h, j in zip(human, judge, strict=True) if h == j) / n
    prec = tp / (tp + fp) if tp + fp else None
    rec = tp / (tp + fn) if tp + fn else None
    f1 = 2 * prec * rec / (prec + rec) if prec and rec else (0.0 if prec == 0 or rec == 0 else None)
    return Agreement(n, acc, prec, rec, f1, cohen_kappa(human, judge), confusion, positive)


def _ranks(vals: Sequence[float]) -> list[float]:
    order = sorted(range(len(vals)), key=lambda i: vals[i])
    ranks = [0.0] * len(vals)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and vals[order[j + 1]] == vals[order[i]]:
            j += 1
        for k in range(i, j + 1):
            ranks[order[k]] = (i + j) / 2 + 1
        i = j + 1
    return ranks


def spearman(x: Sequence[float], y: Sequence[float]) -> float | None:
    if len(x) < 2 or len(x) != len(y):
        return None
    rx, ry = _ranks(x), _ranks(y)
    mx, my = st.fmean(rx), st.fmean(ry)
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry, strict=True))
    den = math.sqrt(sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry))
    return num / den if den else None


def mae(x: Sequence[float], y: Sequence[float]) -> float | None:
    if not x or len(x) != len(y):
        return None
    return st.fmean(abs(a - b) for a, b in zip(x, y, strict=True))
