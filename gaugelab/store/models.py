"""Database tables.

Reproducibility rules encoded here:
* Test cases are immutable rows. Editing a case writes a new row; a dataset version is a
  list of case rows (``dataset_version_test_cases``).
* A dataset version is ``draft`` until a run uses it, then ``frozen`` for good. Changing a
  frozen version means creating a child version.
* Target configurations are versioned the same way (``target_versions``).
* A run stores a resolved snapshot of everything it used (target config, dataset version,
  evaluator versions, judge provider/model/rubric hashes), so it stays interpretable after
  anything "current" changes.
* Secrets are never stored: provider configs hold an ``env:NAME`` reference only.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> datetime:
    return datetime.now(UTC)


NullableJSON = JSON(none_as_null=True)  # None is SQL NULL, not the JSON value null


class Base(DeclarativeBase):
    type_annotation_map = {dict[str, Any]: JSON, list[Any]: JSON}


class Project(Base):
    __tablename__ = "projects"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), unique=True)
    description: Mapped[str] = mapped_column(Text, default="")
    color: Mapped[str] = mapped_column(String(20), default="")  # a palette name chosen in the UI
    icon: Mapped[str] = mapped_column(String(40), default="")
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False)  # seeded sample data; can be hidden
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ProviderConfig(Base):
    __tablename__ = "provider_configs"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"))
    name: Mapped[str] = mapped_column(String(200))
    provider: Mapped[str] = mapped_column(String(40))  # openai | ollama | anthropic | heuristic
    model: Mapped[str] = mapped_column(String(200))
    base_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    api_key_ref: Mapped[str | None] = mapped_column(String(200), nullable=True)  # env:NAME, never the key
    temperature: Mapped[float] = mapped_column(Float, default=0.0)
    max_tokens: Mapped[int] = mapped_column(Integer, default=600)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Target(Base):
    __tablename__ = "targets"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"))
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    adapter: Mapped[str] = mapped_column(String(20))  # http | python | replay
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    # Its answers may only be graded by a judge running on this machine (Ollama, LM Studio...).
    local_judges_only: Mapped[bool] = mapped_column(Boolean, default=False)
    # Other people use this bot: runs default to few questions at a time.
    shared: Mapped[bool] = mapped_column(Boolean, default=False)
    # What one answer costs when the bot reports no token counts (set by the user; an estimate).
    cost_per_answer_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    # The last connection check: {"ok", "at", "elapsed_ms", "error", "explanation", "coverage"}.
    last_check: Mapped[dict[str, Any] | None] = mapped_column(NullableJSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    versions: Mapped[list[TargetVersion]] = relationship(back_populates="target", order_by="TargetVersion.version")


class TargetVersion(Base):
    __tablename__ = "target_versions"
    __table_args__ = (UniqueConstraint("target_id", "version"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    target_id: Mapped[int] = mapped_column(ForeignKey("targets.id"))
    version: Mapped[int] = mapped_column(Integer)
    config: Mapped[dict[str, Any]] = mapped_column(JSON)
    config_hash: Mapped[str] = mapped_column(String(64))
    variant_label: Mapped[str] = mapped_column(String(200), default="")  # e.g. "prompt v3 / hybrid top-20"
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    target: Mapped[Target] = relationship(back_populates="versions")


class Dataset(Base):
    __tablename__ = "datasets"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"))
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    archived: Mapped[bool] = mapped_column(Boolean, default=False)  # hidden; kept because runs used it
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    versions: Mapped[list[DatasetVersion]] = relationship(back_populates="dataset", order_by="DatasetVersion.version")


class DatasetVersion(Base):
    __tablename__ = "dataset_versions"
    __table_args__ = (UniqueConstraint("dataset_id", "version"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    dataset_id: Mapped[int] = mapped_column(ForeignKey("datasets.id"))
    version: Mapped[int] = mapped_column(Integer)
    parent_version_id: Mapped[int | None] = mapped_column(ForeignKey("dataset_versions.id"), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="draft")  # draft | frozen
    content_hash: Mapped[str] = mapped_column(String(64), default="")
    case_count: Mapped[int] = mapped_column(Integer, default=0)
    change_summary: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    frozen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    dataset: Mapped[Dataset] = relationship(back_populates="versions")


class TestCaseRow(Base):
    __tablename__ = "test_cases"
    __test__ = False
    id: Mapped[int] = mapped_column(primary_key=True)
    dataset_id: Mapped[int] = mapped_column(ForeignKey("datasets.id"))
    case_key: Mapped[str] = mapped_column(String(200))  # the human id, e.g. warranty_018
    content: Mapped[dict[str, Any]] = mapped_column(JSON)
    content_hash: Mapped[str] = mapped_column(String(64))
    origin: Mapped[str] = mapped_column(String(40), default="manual")  # manual | import | generated-approved
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class DatasetVersionTestCase(Base):
    __tablename__ = "dataset_version_test_cases"
    dataset_version_id: Mapped[int] = mapped_column(ForeignKey("dataset_versions.id"), primary_key=True)
    test_case_id: Mapped[int] = mapped_column(ForeignKey("test_cases.id"), primary_key=True)
    position: Mapped[int] = mapped_column(Integer, default=0)


class EvaluatorRow(Base):
    __tablename__ = "evaluators"
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    kind: Mapped[str] = mapped_column(String(40))
    gating: Mapped[bool] = mapped_column(Boolean, default=True)
    description: Mapped[str] = mapped_column(Text, default="")


class EvaluatorVersion(Base):
    __tablename__ = "evaluator_versions"
    __table_args__ = (UniqueConstraint("evaluator_id", "version", "definition_hash"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    evaluator_id: Mapped[str] = mapped_column(ForeignKey("evaluators.id"))
    version: Mapped[str] = mapped_column(String(40))
    definition_hash: Mapped[str] = mapped_column(String(64), default="")
    definition: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # rubric text for judges
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Experiment(Base):
    __tablename__ = "experiments"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"))
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    target_version_id: Mapped[int] = mapped_column(ForeignKey("target_versions.id"))
    dataset_version_id: Mapped[int] = mapped_column(ForeignKey("dataset_versions.id"))
    judge_config_id: Mapped[int | None] = mapped_column(ForeignKey("provider_configs.id"), nullable=True)
    gate_id: Mapped[int | None] = mapped_column(ForeignKey("regression_gates.id"), nullable=True)
    baseline_run_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    config: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # evaluators, trials, concurrency, seed...
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Run(Base):
    __tablename__ = "runs"
    id: Mapped[int] = mapped_column(primary_key=True)
    experiment_id: Mapped[int] = mapped_column(ForeignKey("experiments.id"))
    status: Mapped[str] = mapped_column(String(30), default="queued")
    source: Mapped[str] = mapped_column(String(20), default="live")  # live | imported | reevaluated
    parent_run_id: Mapped[int | None] = mapped_column(ForeignKey("runs.id"), nullable=True)
    stop_reason: Mapped[str | None] = mapped_column(String(40), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    progress_done: Mapped[int] = mapped_column(Integer, default=0)
    progress_total: Mapped[int] = mapped_column(Integer, default=0)
    snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    summary: Mapped[dict[str, Any] | None] = mapped_column(NullableJSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Trial(Base):
    __tablename__ = "trials"
    __table_args__ = (UniqueConstraint("run_id", "case_key", "trial_index"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("runs.id"), index=True)
    test_case_id: Mapped[int | None] = mapped_column(ForeignKey("test_cases.id"), nullable=True)
    case_key: Mapped[str] = mapped_column(String(200))
    trial_index: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(20))
    answer: Mapped[str] = mapped_column(Text, default="")
    result: Mapped[dict[str, Any] | None] = mapped_column(NullableJSON, nullable=True)
    raw: Mapped[Any] = mapped_column(NullableJSON, nullable=True)
    latency_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    total_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    target_cost_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    judge_cost_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, default=1)
    failure_types_override: Mapped[list[Any] | None] = mapped_column(NullableJSON, nullable=True)
    failure_note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    scores: Mapped[list[Score]] = relationship(back_populates="trial", cascade="all, delete-orphan")


class TraceRow(Base):
    __tablename__ = "traces"
    id: Mapped[int] = mapped_column(primary_key=True)
    trial_id: Mapped[int] = mapped_column(ForeignKey("trials.id"), unique=True)
    trace_id: Mapped[str] = mapped_column(String(64))
    spans: Mapped[list[SpanRow]] = relationship(back_populates="trace", cascade="all, delete-orphan",
                                                order_by="SpanRow.start_time")


class SpanRow(Base):
    __tablename__ = "spans"
    id: Mapped[int] = mapped_column(primary_key=True)
    trace_row_id: Mapped[int] = mapped_column(ForeignKey("traces.id"), index=True)
    span_id: Mapped[str] = mapped_column(String(32))
    parent_span_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    type: Mapped[str] = mapped_column(String(30))
    name: Mapped[str] = mapped_column(String(300))
    start_time: Mapped[float] = mapped_column(Float)
    end_time: Mapped[float] = mapped_column(Float)
    duration_ms: Mapped[float] = mapped_column(Float)
    status: Mapped[str] = mapped_column(String(20), default="ok")
    input_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    output_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    metadata_: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, default=dict)
    usage: Mapped[dict[str, Any] | None] = mapped_column(NullableJSON, nullable=True)
    cost_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    trace: Mapped[TraceRow] = relationship(back_populates="spans")


class Score(Base):
    __tablename__ = "scores"
    id: Mapped[int] = mapped_column(primary_key=True)
    trial_id: Mapped[int] = mapped_column(ForeignKey("trials.id"), index=True)
    evaluator_id: Mapped[str] = mapped_column(String(80))
    evaluator_version: Mapped[str] = mapped_column(String(40))
    kind: Mapped[str] = mapped_column(String(30))
    status: Mapped[str] = mapped_column(String(20))
    gating: Mapped[bool] = mapped_column(Boolean, default=True)
    score: Mapped[float | None] = mapped_column(Float, nullable=True)
    label: Mapped[str | None] = mapped_column(String(40), nullable=True)
    threshold: Mapped[float | None] = mapped_column(Float, nullable=True)
    explanation: Mapped[str] = mapped_column(Text, default="")
    evidence: Mapped[list[Any]] = mapped_column(JSON, default=list)
    failure_type: Mapped[str | None] = mapped_column(String(40), nullable=True)
    judge_cost_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    duration_ms: Mapped[float] = mapped_column(Float, default=0.0)
    metadata_: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, default=dict)
    trial: Mapped[Trial] = relationship(back_populates="scores")


class HumanAnnotation(Base):
    __tablename__ = "human_annotations"
    __table_args__ = (UniqueConstraint("trial_id", "dimension", "annotator"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    trial_id: Mapped[int] = mapped_column(ForeignKey("trials.id"), index=True)
    dimension: Mapped[str] = mapped_column(String(80))  # an evaluator id, e.g. correctness
    label: Mapped[str] = mapped_column(String(20))  # PASS | FAIL | UNKNOWN
    score: Mapped[float | None] = mapped_column(Float, nullable=True)
    annotator: Mapped[str] = mapped_column(String(120), default="anonymous")
    note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class RegressionGate(Base):
    __tablename__ = "regression_gates"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"))
    name: Mapped[str] = mapped_column(String(200))
    config: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class GateResult(Base):
    __tablename__ = "gate_results"
    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("runs.id"), index=True)
    gate_id: Mapped[int | None] = mapped_column(ForeignKey("regression_gates.id"), nullable=True)
    baseline_run_id: Mapped[int | None] = mapped_column(ForeignKey("runs.id"), nullable=True)
    status: Mapped[str] = mapped_column(String(20))
    config: Mapped[dict[str, Any]] = mapped_column(JSON)
    results: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class DocumentSource(Base):
    __tablename__ = "document_sources"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"))
    filename: Mapped[str] = mapped_column(String(300))
    content_type: Mapped[str] = mapped_column(String(100), default="text/plain")
    text: Mapped[str] = mapped_column(Text)
    sha256: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class GeneratedTestCandidate(Base):
    __tablename__ = "generated_test_candidates"
    id: Mapped[int] = mapped_column(primary_key=True)
    dataset_id: Mapped[int] = mapped_column(ForeignKey("datasets.id"), index=True)
    document_source_id: Mapped[int | None] = mapped_column(ForeignKey("document_sources.id"), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="unreviewed")  # unreviewed | approved | rejected
    kind: Mapped[str] = mapped_column(String(40), default="factual")
    case: Mapped[dict[str, Any]] = mapped_column(JSON)
    evidence: Mapped[list[Any]] = mapped_column(JSON, default=list)
    generator: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    reviewer: Mapped[str | None] = mapped_column(String(120), nullable=True)
    review_note: Mapped[str] = mapped_column(Text, default="")
    edited: Mapped[bool] = mapped_column(Boolean, default=False)
    approved_in_version_id: Mapped[int | None] = mapped_column(ForeignKey("dataset_versions.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ImportBatch(Base):
    __tablename__ = "import_batches"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"))
    name: Mapped[str] = mapped_column(String(200))
    source_filename: Mapped[str] = mapped_column(String(300))
    config: Mapped[dict[str, Any]] = mapped_column(JSON)
    count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ImportedResult(Base):
    __tablename__ = "imported_results"
    __table_args__ = (UniqueConstraint("batch_id", "case_key"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    batch_id: Mapped[int] = mapped_column(ForeignKey("import_batches.id"), index=True)
    case_key: Mapped[str] = mapped_column(String(200))
    message: Mapped[str] = mapped_column(Text)
    result: Mapped[dict[str, Any]] = mapped_column(JSON)


class PriceOverride(Base):
    __tablename__ = "price_overrides"
    id: Mapped[int] = mapped_column(primary_key=True)
    provider: Mapped[str] = mapped_column(String(60))
    model: Mapped[str] = mapped_column(String(200))
    input_per_1m: Mapped[float] = mapped_column(Float)
    output_per_1m: Mapped[float] = mapped_column(Float)
    effective_from: Mapped[str] = mapped_column(String(10))
    source_note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AppSetting(Base):
    """Workspace-wide defaults (judge, generator, spend cap). Values are JSON; never secrets."""

    __tablename__ = "app_settings"
    key: Mapped[str] = mapped_column(String(80), primary_key=True)
    value: Mapped[Any] = mapped_column(NullableJSON, nullable=True)


class ConnectorTemplate(Base):
    """A target configuration saved for reuse ("connect another bot like this one")."""

    __tablename__ = "connector_templates"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    adapter: Mapped[str] = mapped_column(String(20))
    config: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class JudgeBakeoff(Base):
    """Several judges graded the same human-labelled answers; who agrees with the person most?"""

    __tablename__ = "judge_bakeoffs"
    id: Mapped[int] = mapped_column(primary_key=True)
    dimension: Mapped[str] = mapped_column(String(80))
    status: Mapped[str] = mapped_column(String(20), default="running")  # running | completed | failed
    judges: Mapped[list[Any]] = mapped_column(JSON, default=list)
    progress_done: Mapped[int] = mapped_column(Integer, default=0)
    progress_total: Mapped[int] = mapped_column(Integer, default=0)
    results: Mapped[dict[str, Any] | None] = mapped_column(NullableJSON, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
