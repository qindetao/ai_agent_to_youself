"""Validate time/version evidence. No date ranking or semantic version ordering."""
import re
from datetime import date
from urllib.parse import urlsplit

from .authority import source_role
from .models import Claim, SearchRequest, Source

TEMPORAL_INSTRUCTION = (
    "每条结论必须填写temporal。参考日期为as_of，目标版本为target_version（可能为空）。"
    "逐条设置requires_check：结论涉及当前状态、价格、公告、发布日期、生效范围或目标版本时为true；稳定且不随时间变化的概念解释为false。"
    "区分网页发布日期估计、抓取时间、事件日期、生效日期与版本；不得把网页日期或抓取时间当作结论生效日期。"
    "从正文逐字引用提取facts：event_date/effective_from/effective_until的value用YYYY-MM-DD，"
    "日期必须明确出现在quote内；不明确的年月不补成某一天。version的value为正文中的版本标识。"
    "只提取与这条结论直接关联的日期和版本，不混入页面其他功能的版本。"
    "supersession的value必须逐字摘录明确替代/废止/更正旧结论的文字，引用原始官方或机构正文，"
    "replacement_source_ids指向载有替代说明的来源，且注明适用范围。"
    "网页日期更新、版本号更大或两份公告结论不同，都不能单独证明替代关系。"
    "只有明确适用范围/生效区间支持参考日期时才能applicable_as_of，不代表全网最新。"
    "仅有过去事件日期可historical，不等于已过期。明确失效或尚未生效的内容不得作为参考日期的现行结论。"
    "案件或事件概览中，已经发生的起诉、判决、公布文件等分别按event_date核验并标为historical；"
    "不要要求历史事件提供effective_from生效区间。当前案件进展与历史事实分开写，不能用历史日期证明当前状态。"
    "目标版本与适用版本明确不同时version_mismatch；如果引用的原始官方文档直接覆盖目标版本，且引文包含该版本，标记version_confirmed。"
    "version_confirmed仅表示版本范围得到官方原文支持，不代表结论的其他事实自动正确。"
    "真正与时间版本无关的稳定解释可not_assessed；价格、最新消息、API参数不得用not_assessed绕过核验。"
    "时间或版本不适用时，改写text明确历史/未来/版本条件，不能把旧事实写成当前事实。"
    "发现缺少当前或目标版本证据时，优先补查官方更新日志、更正公告或该版本文档。"
    "temporal.reason使用请求语言；不要在reason里另加未经证据支持的结论。"
)

LABELS = {
    "zh": {"not_assessed": "未涉及时间版本核验", "applicable_as_of": "有证据支持参考日期适用", "version_confirmed": "官方证据匹配目标版本", "historical": "历史信息", "superseded": "存在明确替代说明", "version_mismatch": "目标版本不匹配", "uncertain": "时效或版本无法确认"},
    "en": {"not_assessed": "Time/version not assessed", "applicable_as_of": "Evidence supports applicability as of reference date", "version_confirmed": "Official evidence matches target version", "historical": "Historical information", "superseded": "Explicit replacement notice", "version_mismatch": "Target version mismatch", "uncertain": "Time/version uncertain"},
}


def norm(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def docs_edition(url: str) -> str | None:
    parts = urlsplit(url)
    if source_role(url) != "official_document":
        return None
    for segment in parts.path.split("/"):
        match = re.fullmatch(r"v?(\d+\.\d+(?:\.\d+)?)", segment, re.IGNORECASE)
        if match:
            return match.group(1)
    # Go publishes versioned docs under paths such as /doc/go1.26.0/.
    if (parts.hostname or "").lower() == "go.dev":
        match = re.search(r"/doc/go(\d+\.\d+(?:\.\d+)?)(?:/|$)", parts.path, re.IGNORECASE)
        if match:
            return match.group(1)
    return None


def version_value_applies(value: str, target: str) -> bool:
    """Match an explicit version token, without confusing 3.1 with 3.10."""
    target = target.strip()
    return bool(target and re.search(r"(?<![\w.])" + re.escape(target) + r"(?![\w.])", value, re.IGNORECASE))


def date_in_quote(value: str, quote: str) -> bool:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return False
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        return False
    # Recognize explicit full dates only, not copyright years or guessed dates.
    for y, m, d in re.findall(r"(?<!\d)(\d{4})\s*(?:[-/.]|年)\s*(\d{1,2})\s*(?:[-/.]|月)\s*(\d{1,2})(?!\d)", quote):
        try:
            if date(int(y), int(m), int(d)) == parsed:
                return True
        except ValueError:
            pass
    months = {name: i for i, name in enumerate((
        "january", "february", "march", "april", "may", "june",
        "july", "august", "september", "october", "november", "december",
    ), 1)}
    aliases = {name[:3]: number for name, number in months.items()}
    months.update(aliases)
    month_pattern = "(?:" + "|".join(sorted(months, key=len, reverse=True)) + r")\.?"
    patterns = (
        (rf"\b({month_pattern})\s+(\d{{1,2}})(?:st|nd|rd|th)?[,]?\s+(\d{{4}})\b", False),
        (rf"\b(\d{{1,2}})(?:st|nd|rd|th)?\s+({month_pattern})[,]?\s+(\d{{4}})\b", True),
    )
    for pattern, day_first in patterns:
        for first, second, year in re.findall(pattern, quote, re.IGNORECASE):
            month, day = (second, first) if day_first else (first, second)
            try:
                if date(int(year), months[month.lower().rstrip(".")], int(day)) == parsed:
                    return True
            except ValueError:
                pass
    return False


def is_time_sensitive(question: str) -> bool:
    return bool(re.search(r"最新|目前|当前|现在|今天|新闻|消息|价格|收费|生效|版本|更新|发布|公告|\b(latest|current|today|news|pricing|price|version|update|release)\b", question, re.IGNORECASE))


def is_date_sensitive(question: str) -> bool:
    return bool(re.search(r"最新|目前|当前|现在|今天|新闻|消息|价格|收费|生效|发布日期|发布于|公告|\b(latest|current|today|news|pricing|price|effective|release)\b", question, re.IGNORECASE))


def extract_reference_date(question: str) -> date | None:
    """Use an explicit as-of/cutoff date in the question as the temporal baseline."""
    pattern = r"(?:截至|截止(?:日期)?(?:为|到)?|参考日期(?:为|是)?|as\s+of)\s*(20\d{2})\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})\s*日?"
    for year, month, day in re.findall(pattern, question, re.IGNORECASE):
        try:
            return date(int(year), int(month), int(day))
        except ValueError:
            continue
    return None


def check_temporal(claims: list[Claim], sources: list[Source], request: SearchRequest, as_of: date, require_assessment: bool = False) -> list[Claim]:
    source_map = {s.id: s for s in sources}
    for claim in claims:
        check = claim.temporal
        check.reason = re.sub(r"\[S\d+\]", "", check.reason)
        check.checked_as_of = as_of
        check.requested_version = request.target_version
        kept = []
        rejected = False
        foreign_edition_evidence = False
        for fact in check.facts:
            wrong_edition = False
            source = source_map.get(fact.source_id)
            valid = bool(source and source.content_type == "page_extract" and norm(fact.quote) in norm(source.content))
            if valid and fact.kind in ("event_date", "effective_from", "effective_until"):
                valid = date_in_quote(fact.value, fact.quote)
            elif valid and fact.kind == "version":
                valid = bool(re.search(r"(?<![\w.])" + re.escape(fact.value) + r"(?!\w|\.\w)", fact.quote, re.IGNORECASE))
                edition = docs_edition(source.url) if source else None
                if valid and request.target_version and edition and edition != request.target_version:
                    foreign_edition_evidence = True
                    wrong_edition = True
                    valid = False
            elif valid and fact.kind == "supersession":
                valid = norm(fact.value).casefold() in norm(fact.quote).casefold()
            if valid:
                kept.append(fact)
            elif not wrong_edition:
                rejected = True
        check.facts = kept
        replacements = {
            f.source_id for f in kept if f.kind == "supersession"
            and source_map[f.source_id].source_type in ("official", "institution")
        }
        check.replacement_source_ids = list(dict.fromkeys(
            sid for sid in check.replacement_source_ids if sid in replacements
        ))
        dates = {kind: {date.fromisoformat(f.value) for f in kept if f.kind == kind}
                 for kind in ("event_date", "effective_from", "effective_until")}
        versions = {f.value.casefold().strip() for f in kept if f.kind == "version"}
        invalid_state = rejected
        if check.status == "superseded" and not check.replacement_source_ids:
            invalid_state = True
        if check.status == "superseded":
            effective_replacements = {
                f.source_id for f in kept if f.kind == "effective_from" and date.fromisoformat(f.value) <= as_of
            }
            invalid_state |= not set(check.replacement_source_ids).issubset(effective_replacements)
        if check.status == "version_mismatch":
            invalid_state |= not request.target_version or not versions or any(version_value_applies(v, request.target_version) for v in versions)
        if check.status == "version_confirmed" and not request.target_version:
            invalid_state = True
        if check.status == "historical":
            invalid_state |= not any(d <= as_of for kind in ("event_date", "effective_until") for d in dates[kind])
        if check.status == "applicable_as_of":
            # A bounded interval must be unambiguous; a newer page alone is not enough.
            starts, ends = dates["effective_from"], dates["effective_until"]
            invalid_state |= len(starts) != 1 or len(ends) > 1
            invalid_state |= bool(starts and max(starts) > as_of) or bool(ends and min(ends) < as_of)
            invalid_state |= bool(starts and ends and max(starts) > min(ends))
            if request.target_version:
                invalid_state |= not any(version_value_applies(v, request.target_version) for v in versions)

        if request.target_version:
            matching_official_version_evidence = False
            for evidence in claim.evidence:
                source = source_map.get(evidence.source_id)
                if not source or source.source_role not in ("official_document", "official_announcement"):
                    continue
                edition = docs_edition(source.url)
                if edition and edition != request.target_version:
                    continue
                # A quote from a URL explicitly versioned for the requested edition is
                # already scoped by that official page, even when the excerpt omits its header.
                if edition == request.target_version or version_value_applies(evidence.quote, request.target_version):
                    matching_official_version_evidence = True
                    break
            if not matching_official_version_evidence:
                matching_official_version_evidence = any(
                    source_map[fact.source_id].source_role in ("official_document", "official_announcement")
                    and version_value_applies(fact.value, request.target_version)
                    for fact in kept if fact.kind == "version"
                )
            if (matching_official_version_evidence and not rejected and check.status in ("uncertain", "not_assessed", "version_confirmed")
                    and not request.as_of and not is_date_sensitive(request.question)):
                check.status = "version_confirmed"
                check.reason = (
                    f"引用的官方页面明确匹配目标版本 {request.target_version}；这只确认版本范围，不代表结论中的其他事实自动正确。"
                    if request.language == "zh" else
                    f"The cited official page explicitly matches target version {request.target_version}; this confirms scope only, not every factual detail."
                )
            elif check.status == "version_confirmed" or foreign_edition_evidence:
                invalid_state = True
        # Do not accept an active claim if the supplied end date says it has expired.
        expired = any(d < as_of for d in dates["effective_until"])
        future = any(d > as_of for d in dates["effective_from"])
        if expired or future:
            invalid_state |= check.status not in ("historical", "superseded", "version_mismatch", "uncertain")
        claim_temporal_text = re.sub(r"当前批次|当前batch|\bcurrent\s+(?:mini-)?batch\b", "", claim.text, flags=re.IGNORECASE)
        claim_text_needs_check = bool(re.search(
            r"最新|目前|当前|现在|截至|价格|收费|生效|有效期|发布日期|发布于|已发布|版本\s*(?:\d+(?:\.\d+)*|[A-Za-z][A-Za-z0-9._-]*)|API\s*(?:价格|限额|参数|当前|版本|支持)|下一个版本|下一代|\b20\d{2}\b|\b(latest|current|today|pricing|price|effective|version\s*(?:\d+(?:\.\d+)*|[A-Za-z][A-Za-z0-9._-]*)|released)\b",
            claim_temporal_text, re.IGNORECASE,
        ))
        question_requires_check = require_assessment or is_time_sensitive(request.question)
        model_requires_check = check.requires_check is True or (check.requires_check is None and question_requires_check)
        if (check.status == "uncertain" and check.requires_check is False and not question_requires_check
                and not claim_text_needs_check and not request.target_version and not request.as_of
                and not check.facts and not rejected):
            # Do not turn stable, explicitly non-temporal explanations into partial claims
            # just because the model supplied an unnecessary uncertain temporal status.
            check.status = "not_assessed"
            check.reason = (
                "该结论不涉及时间或版本适用性，无需进行时效核验。" if request.language == "zh" else
                "This claim does not depend on time or version applicability."
            )
        if check.status == "not_assessed" and (model_requires_check or claim_text_needs_check or request.target_version or request.as_of):
            invalid_state = True
        if invalid_state:
            check.status = "uncertain"
            check.reason = (
                "时间或版本证据未通过完整校验，无法确认参考日期和目标版本的适用性。"
                if request.language == "zh" else
                "Time/version evidence did not pass validation; applicability remains uncertain."
            )
        if check.status != "not_assessed" and not check.reason:
            check.reason = LABELS[request.language][check.status]
        # Keep conflicting/insufficient as-is. Otherwise signal applicability limitations.
        if claim.status not in ("conflicting", "insufficient") and (check.status in ("uncertain", "superseded", "version_mismatch") or expired or future):
            claim.status = "partial"
            claim.reason = (
                "结论的时间或版本适用性尚未确认，因此只能视为部分支持。" if request.language == "zh" else
                "The claim's time or version applicability is unconfirmed, so it can only be treated as partially supported."
            )
    return claims
