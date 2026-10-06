import pytest

from gaugelab.datasets import DatasetError, content_hash, export_dataset, parse_dataset

YAML = """
name: demo
cases:
  - id: warranty_018
    title: Active warranty lookup
    category: warranty
    tags: [tool-use]
    input: {message: "Is order 18372 still covered by warranty?"}
    expected:
      required_tools: [lookup_order, check_warranty]
      expected_outcome: {warranty_status: active}
      answer: {must_mention: [warranty, active]}
      forbidden_claims: ["extended warranty"]
  - id: plain
    input: "What is Device Alpha?"
    expected: {answer: "A home hub."}
"""


def test_parse_with_aliases():
    ds = parse_dataset(YAML, "d.yaml")
    assert ds.name == "demo" and len(ds.cases) == 2
    c = ds.cases[0]
    assert c.expected.answer.must_not_claim == ["extended warranty"]  # alias forbidden_claims
    assert ds.cases[1].input.message == "What is Device Alpha?"  # input as a plain string
    assert ds.cases[1].expected.answer.reference == "A home hub."  # answer as a plain string


def test_errors_name_the_exact_place():
    bad = """
cases:
  - id: a
    input: {message: hi}
    expected: {tool_calls: [{arguments: {x: 1}}]}
  - id: a
    input: {message: again}
"""
    with pytest.raises(DatasetError) as err:
        parse_dataset(bad, "bad.yaml")
    msgs = err.value.errors
    assert any("cases[0] (id a) > expected > tool_calls > 0 > name" in m for m in msgs)
    assert any("duplicate id 'a'" in m for m in msgs)


def test_unknown_field_rejected():
    with pytest.raises(DatasetError) as err:
        parse_dataset("cases: [{id: a, input: {message: hi}, expectd: {}}]", "x.yaml")
    assert "expectd" in str(err.value)


def test_csv_import_and_row_errors():
    ok = "id,question,reference_answer,must_mention,refusal_expected\nq1,How long?,24 months,24 months,false\n"
    ds = parse_dataset(ok, "s.csv")
    assert ds.cases[0].expected.answer.must_mention == ["24 months"]
    assert ds.cases[0].expected.refusal_expected is False
    bad = "question,refusal_expected\nfine,true\n,false\nok,maybe\n"
    with pytest.raises(DatasetError) as err:
        parse_dataset(bad, "s.csv")
    assert "CSV row 3, column 'question': empty" in err.value.errors
    assert any("CSV row 4, column 'refusal_expected'" in e for e in err.value.errors)


def test_export_roundtrip_and_hash():
    ds = parse_dataset(YAML, "d.yaml")
    for fmt in ("yaml", "json"):
        text = export_dataset("demo", ds.cases, fmt)
        again = parse_dataset(text, f"d.{fmt}")
        assert [c.model_dump() for c in again.cases] == [c.model_dump() for c in ds.cases]
    assert content_hash(ds.cases) == content_hash(list(reversed(ds.cases)))  # order-independent
    changed = [ds.cases[0].model_copy(update={"title": "x"}), ds.cases[1]]
    assert content_hash(changed) != content_hash(ds.cases)


def test_benchmark_dataset_is_valid():
    from pathlib import Path

    path = Path(__file__).resolve().parents[1] / "benchmarks" / "acme_support" / "dataset.yaml"
    ds = parse_dataset(path.read_text(encoding="utf-8"), path.name)
    assert 50 <= len(ds.cases) <= 60
