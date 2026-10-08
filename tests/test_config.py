"""Config-as-code helpers: reduced suites and judge overrides."""

import pytest

from assay.cli import judge_override
from assay.store.service import select_cases
from tests.conftest import make_case


def test_case_filter_selects_a_reduced_suite():
    cases = [make_case(id="a", category="factual"), make_case(id="b", category="tool_use", tags=["smoke"]),
             make_case(id="c", category="tool_use"), make_case(id="d", category="factual", enabled=False)]
    assert [c.id for c in select_cases(cases, None)] == ["a", "b", "c"]  # disabled cases never run
    assert [c.id for c in select_cases(cases, {"categories": ["factual"]})] == ["a"]
    assert [c.id for c in select_cases(cases, {"tags": ["smoke"], "ids": ["a"]})] == ["a", "b"]


def test_judge_override_parsing():
    assert judge_override(None) is None
    assert judge_override("heuristic") == {"provider": "heuristic"}
    assert judge_override("ollama:llama3.1:8b") == {"provider": "ollama", "model": "llama3.1:8b"}
    assert judge_override("openai:some-model")["api_key_ref"] == "env:OPENAI_API_KEY"
    with pytest.raises(SystemExit):
        judge_override("gemini")
