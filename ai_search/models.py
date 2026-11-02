from typing import Literal
from datetime import date

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class SearchRequest(StrictModel):
    question: str = Field(min_length=1, max_length=2000)
    language: Literal["zh", "en"] = "zh"
    max_search_rounds: int = Field(default=2, ge=1, le=2)
    as_of: date | None = None
    target_version: str | None = Field(default=None, min_length=1, max_length=100)
    follow_up_context: str | None = Field(default=None, max_length=6000)


class Source(StrictModel):
    id: str
    title: str
    url: str
    published_at: str | None = None
    retrieved_at: str
    content: str
    content_type: Literal["page_extract", "search_snippet"]
    evidence_group_id: str | None = None
    content_fingerprint: str | None = None
    source_type: Literal["official", "institution", "authoritative_media", "research_repository", "preferred_unverified", "unclassified"] = "unclassified"
    source_role: Literal["official_document", "official_community", "official_announcement", "institutional_source", "research_repository", "authoritative_media", "community_or_blog", "other"] = "other"
    authority_reason: str = "尚未确认机构身份。"
    published_at_basis: Literal["provider_estimate_or_update", "unknown"] = "unknown"


class SourceMatch(StrictModel):
    source_ids: list[str]
    jaccard: float
    containment: float
    length_ratio: float
    method: str = "normalized_token_5gram"


class SourceGroup(StrictModel):
    id: str
    source_ids: list[str]
    status: Literal["possible_shared_content", "undetermined"]
    matches: list[SourceMatch] = Field(default_factory=list)


class Evidence(StrictModel):
    source_id: str
    quote: str = Field(min_length=12, max_length=1200)


class FactEvidence(Evidence):
    relation: Literal["supports", "contradicts", "context"] = "context"


class FactCheck(StrictModel):
    statement: str = Field(min_length=1, max_length=500)
    status: Literal["supported", "contradicted", "conflicting", "uncertain"] = "uncertain"
    evidence: list[FactEvidence] = Field(default_factory=list, max_length=4)


Status = Literal["supported", "partial", "conflicting", "insufficient"]


class TemporalFact(StrictModel):
    kind: Literal["event_date", "effective_from", "effective_until", "version", "supersession"]
    value: str = Field(min_length=1, max_length=300)
    source_id: str
    quote: str = Field(min_length=12, max_length=1200)


class TemporalCheck(StrictModel):
    requires_check: bool | None = None
    status: Literal["not_assessed", "applicable_as_of", "version_confirmed", "historical", "superseded", "version_mismatch", "uncertain"] = "not_assessed"
    reason: str = Field(default="", max_length=1500)
    facts: list[TemporalFact] = Field(default_factory=list, max_length=8)
    replacement_source_ids: list[str] = Field(default_factory=list, max_length=4)
    checked_as_of: date | None = None
    requested_version: str | None = None


class Claim(StrictModel):
    text: str = Field(min_length=1, max_length=1500)
    status: Status
    evidence: list[Evidence] = Field(default_factory=list, max_length=6)
    fact_checks: list[FactCheck] = Field(default_factory=list, max_length=8)
    reason: str = Field(min_length=1, max_length=1500)
    evidence_group_ids: list[str] = Field(default_factory=list)
    evidence_group_count: int = 0
    temporal: TemporalCheck = Field(default_factory=TemporalCheck)


class Plan(StrictModel):
    queries: list[str] = Field(min_length=1, max_length=3)
    preferred_domains: list[str] = Field(default_factory=list, max_length=6)


class Assessment(StrictModel):
    claims: list[Claim] = Field(max_length=6)
    follow_up_queries: list[str] = Field(default_factory=list, max_length=2)


class Review(StrictModel):
    claims: list[Claim] = Field(max_length=6)


class SearchResponse(StrictModel):
    answer: str
    claims: list[Claim]
    sources: list[Source]
    limitations: list[str]
    search_rounds: int
    usage: dict[str, int]
    source_groups: list[SourceGroup] = Field(default_factory=list)
    checked_as_of: date | None = None
    target_version: str | None = None
    result_kind: Literal["search", "history_summary"] = "search"
    history_reference_dates: list[date] = Field(default_factory=list)


class HistoryRecord(StrictModel):
    record_id: str = Field(min_length=1, max_length=80)
    question: str = Field(min_length=1, max_length=2000)
    result: SearchResponse


class HistorySummaryRequest(StrictModel):
    records: list[HistoryRecord] = Field(min_length=1, max_length=5)
    instruction: str = Field(default="请综合这些记录，去除重复，保留差异与不确定性，给出一份连贯概览。", max_length=2000)
    language: Literal["zh", "en"] = "zh"

    @model_validator(mode="after")
    def limit_saved_material(self):
        if len({r.record_id for r in self.records}) != len(self.records):
            raise ValueError("请选择不同的历史记录")
        if sum(len(r.result.sources) for r in self.records) > 40:
            raise ValueError("选中记录包含过多来源，请减少记录数量")
        if len(self.model_dump_json()) > 400000:
            raise ValueError("历史记录过大，请减少选中数量")
        for record in self.records:
            if len({s.id for s in record.result.sources}) != len(record.result.sources):
                raise ValueError("历史记录包含重复来源编号")
        return self
