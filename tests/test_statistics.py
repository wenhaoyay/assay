import math

import pytest

from assay.evaluators.retrieval.metrics import ndcg_at_k, precision_at_k, recall_at_k, reciprocal_rank
from assay.statistics import (
    binary_agreement,
    bootstrap_ci,
    cohen_kappa,
    mcnemar_exact,
    paired_bootstrap_delta,
    pass_at_k,
    pass_hat_k,
    percentile,
    spearman,
    summarize,
)


def test_ir_metrics_known_values():
    retrieved = ["d3", "d1", "d7", "d2", "d9"]
    rel = {"d1", "d2", "d4"}
    assert precision_at_k(retrieved, rel, 5) == pytest.approx(2 / 5)
    assert recall_at_k(retrieved, rel, 5) == pytest.approx(2 / 3)
    assert recall_at_k(retrieved, rel, 2) == pytest.approx(1 / 3)
    assert reciprocal_rank(retrieved, rel) == pytest.approx(1 / 2)
    dcg = 1 / math.log2(3) + 1 / math.log2(5)
    idcg = 1 + 1 / math.log2(3) + 1 / math.log2(4)
    assert ndcg_at_k(retrieved, rel, 5) == pytest.approx(dcg / idcg)
    assert reciprocal_rank(["x"], rel) == 0.0


def test_relevance_groups_count_once():
    # "a|b": either document satisfies the requirement, and it counts once.
    assert recall_at_k(["b", "a"], {"a|b"}, 5) == 1.0
    assert ndcg_at_k(["x", "b", "a"], {"a|b"}, 5) == pytest.approx(1 / math.log2(3))
    assert precision_at_k(["a", "b"], {"a|b"}, 2) == 1.0


def test_bootstrap_is_reproducible_and_sane():
    vals = [1, 0, 1, 1, 0, 1, 1, 1, 0, 1]
    a, b = bootstrap_ci(vals, seed=3), bootstrap_ci(vals, seed=3)
    assert (a.low, a.high) == (b.low, b.high)
    assert a.low <= a.estimate == 0.7 <= a.high
    assert bootstrap_ci([1]).low is None  # one case: no interval, not a fake one
    d = paired_bootstrap_delta([(0, 1)] * 10)
    assert d.estimate == 1 and d.low == 1


def test_pass_at_k_and_pass_hat_k():
    assert pass_at_k(3, 1, 1) == pytest.approx(1 / 3)
    assert pass_at_k(3, 1, 3) == 1.0
    assert pass_hat_k(3, 1, 3) == 0.0
    assert pass_hat_k(3, 3, 3) == 1.0
    assert pass_hat_k(5, 4, 2) == pytest.approx(math.comb(4, 2) / math.comb(5, 2))
    with pytest.raises(ValueError):
        pass_at_k(2, 1, 3)


def test_mcnemar_exact():
    pairs = [(True, False)] * 1 + [(False, True)] * 9 + [(True, True)] * 20
    r = mcnemar_exact(pairs)
    assert (r.only_baseline, r.only_candidate, r.both_pass) == (1, 9, 20)
    assert r.p_value == pytest.approx(2 * (1 + 10) / 2**10)
    assert mcnemar_exact([(True, True)]).p_value is None


def test_kappa_and_agreement():
    # Classic example: 20 items, two raters.
    human = ["PASS"] * 10 + ["FAIL"] * 10
    judge = ["PASS"] * 8 + ["FAIL"] * 2 + ["FAIL"] * 7 + ["PASS"] * 3
    assert cohen_kappa(human, judge) == pytest.approx(0.5)
    agg = binary_agreement(human, judge)
    assert agg.accuracy == 0.75
    assert agg.confusion["FAIL"]["FAIL"] == 7 and agg.confusion["PASS"]["FAIL"] == 2
    assert agg.precision == pytest.approx(7 / 9) and agg.recall == pytest.approx(7 / 10)
    assert cohen_kappa(["PASS"] * 3, ["PASS"] * 3) == 1.0


def test_summaries():
    s = summarize([1, 2, 3, 4])
    assert (s.n, s.mean, s.median) == (4, 2.5, 2.5)
    assert summarize([]).mean is None
    assert percentile([1, 2, 3, 4, 5], 95) == pytest.approx(4.8)
    assert spearman([1, 2, 3], [10, 20, 30]) == pytest.approx(1.0)


def _reference_bootstrap(values, resamples=2000, level=0.95, seed=20240601):
    """The original draw-by-draw bootstrap, kept so the fast one is held to its exact numbers."""
    import random
    import statistics as st

    vals = [float(v) for v in values]
    n = len(vals)
    rng = random.Random(seed)
    boots = sorted(st.fmean([vals[rng.randrange(n)] for _ in range(n)]) for _ in range(resamples))
    a = (1 - level) / 2
    return percentile(boots, 100 * a), percentile(boots, 100 * (1 - a))


@pytest.mark.parametrize("n", [2, 3, 7, 8, 16, 33, 58, 64, 100])
@pytest.mark.parametrize("seed", [20240601, 7])
def test_fast_bootstrap_is_identical_to_the_original(n, seed):
    vals = [((i * 7919) % 101) / 100 for i in range(n)]
    ci = bootstrap_ci(vals, resamples=300, seed=seed)
    assert (ci.low, ci.high) == _reference_bootstrap(vals, resamples=300, seed=seed)
    again = bootstrap_ci(vals, resamples=300, seed=seed)  # the cached answer is the same answer
    assert (again.estimate, again.low, again.high, again.n) == (ci.estimate, ci.low, ci.high, ci.n)
