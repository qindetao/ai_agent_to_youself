"""Domain identity rules aid prioritization, never establish factual truth."""
import ipaddress
import json
import re
from pathlib import Path
from urllib.parse import urlsplit

POLICY = json.loads(Path(__file__).with_name("source_priority.json").read_text(encoding="utf-8"))

OFFICIAL_DOCUMENT_HOSTS = {
    "docs.python.org", "api-docs.deepseek.com", "docs.pytorch.org", "learn.microsoft.com",
    "platform.openai.com", "help.openai.com", "docs.anthropic.com", "tensorflow.org", "www.tensorflow.org",
    "fastapi.tiangolo.com", "go.dev", "doc.rust-lang.org", "docs.djangoproject.com", "react.dev",
    "kubernetes.io", "docs.docker.com", "nodejs.org", "www.postgresql.org",
}
OFFICIAL_COMMUNITY_HOSTS = {"discuss.pytorch.org", "discuss.python.org", "community.openai.com"}
TECHNICAL_STACKS = (
    (re.compile(r"\bpython\b", re.IGNORECASE), ["docs.python.org"]),
    (re.compile(r"\b(?:pytorch|torch)\b", re.IGNORECASE), ["docs.pytorch.org", "pytorch.org"]),
    (re.compile(r"\bdeepseek\b", re.IGNORECASE), ["api-docs.deepseek.com"]),
    (re.compile(r"\bopenai\b", re.IGNORECASE), ["platform.openai.com", "openai.com"]),
    (re.compile(r"\banthropic\b", re.IGNORECASE), ["docs.anthropic.com"]),
    (re.compile(r"\btensorflow\b", re.IGNORECASE), ["www.tensorflow.org"]),
    (re.compile(r"fastapi", re.IGNORECASE), ["fastapi.tiangolo.com"]),
    (re.compile(r"\b(?:golang|go language)\b|go语言", re.IGNORECASE), ["go.dev"]),
    (re.compile(r"\b(?:rust|rust语言)\b", re.IGNORECASE), ["doc.rust-lang.org"]),
    (re.compile(r"\bdjango\b", re.IGNORECASE), ["docs.djangoproject.com"]),
    (re.compile(r"\breact(?:\.js)?\b|react框架", re.IGNORECASE), ["react.dev"]),
    (re.compile(r"\bkubernetes\b|\bk8s\b", re.IGNORECASE), ["kubernetes.io"]),
    (re.compile(r"\bdocker\b", re.IGNORECASE), ["docs.docker.com"]),
    (re.compile(r"\bnode(?:\.js)?\b|nodejs", re.IGNORECASE), ["nodejs.org"]),
    (re.compile(r"\bpostgres(?:ql)?\b", re.IGNORECASE), ["www.postgresql.org"]),
)
TECHNICAL_TERMS = re.compile(
    r"技术|代码|编程|函数|方法|参数|接口|安装|配置|报错|错误|框架|库|sdk|api|python|pytorch|torch|"
    r"tensorflow|asyncio|transformer|rag|golang|go语言|rust|django|react|kubernetes|docker|nodejs|postgresql|"
    r"模型版本|版本差异|\b(implementation|function|parameter|library|framework|api|sdk|error|install|configure)\b",
    re.IGNORECASE,
)
SEARCH_FILLER = re.compile(
    r"请问|帮我|告诉我|解释一下|有什么区别|有什么不同|怎么使用|如何使用|如何|怎样|为什么|"
    r"的区别|的用法|的原理|是什么|吗|呢|？|\?",
    re.IGNORECASE,
)


def clean_domains(domains: list[str]) -> list[str]:
    result = []
    for value in domains:
        domain = value.strip().lower().rstrip(".")
        if len(domain) > 253 or not re.fullmatch(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}", domain):
            continue
        if domain.endswith((".local", ".internal", ".localhost")):
            continue
        try:
            ipaddress.ip_address(domain)
            continue
        except ValueError:
            pass
        if domain not in result:
            result.append(domain)
    return result[:6]


def matches_domain(host: str, domain: str) -> bool:
    return host == domain or host.endswith("." + domain)


def source_role(url: str) -> str:
    """Describe the page's role separately from who owns its domain."""
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    path = parts.path.lower()
    if any(matches_domain(host, domain) for domain in OFFICIAL_COMMUNITY_HOSTS):
        return "official_community"
    if any(matches_domain(host, domain) for domain in OFFICIAL_DOCUMENT_HOSTS):
        return "official_document"
    for domain, entry in POLICY.items():
        if not matches_domain(host, domain):
            continue
        if entry["type"] == "institution":
            return "institutional_source"
        if entry["type"] == "authoritative_media":
            return "authoritative_media"
        if entry["type"] == "research_repository":
            return "research_repository"
        if any(token in path for token in ("/docs", "/documentation", "/api/", "/reference", "/quick_start")):
            return "official_document"
        return "official_announcement"
    if any(token in host or token in path for token in ("blog", "forum", "community")):
        return "community_or_blog"
    return "other"


def technical_search_profile(question: str) -> tuple[bool, list[str], str | None]:
    """Return a primary-doc search hint and known official domains for technical questions."""
    domains = []
    for pattern, candidates in TECHNICAL_STACKS:
        if pattern.search(question):
            domains.extend(candidates)
    technical = bool(domains or TECHNICAL_TERMS.search(question))
    domains = list(dict.fromkeys(domains))[:6]
    if not technical:
        return False, [], None
    site_hint = f" site:{domains[0]}" if domains else ""
    # Preserve technical identifiers and version strings while dropping conversational filler.
    topic = re.sub(r"\s+", " ", SEARCH_FILLER.sub(" ", question)).strip(" ，,。；;")
    topic = topic or question
    language_hint = " 中文" if re.search(r"[\u4e00-\u9fff]", question) else ""
    return True, domains, f"{topic[:180]} 官方文档{language_hint}{site_hint}"


def source_identity(url: str, preferred_domains: list[str]) -> tuple[str, str, int]:
    host = (urlsplit(url).hostname or "").lower()
    for domain in sorted(POLICY, key=len, reverse=True):
        if matches_domain(host, domain):
            entry = POLICY[domain]
            priority = {"official": 0, "institution": 0, "authoritative_media": 1, "research_repository": 2}[entry["type"]]
            role = source_role(url)
            role_labels = {
                "official_document": "官方文档", "official_community": "官方社区/论坛",
                "official_announcement": "官方公告/发布页", "institutional_source": "机构资料",
                "authoritative_media": "权威媒体", "research_repository": "研究资料库（不代表同行评审）",
                "community_or_blog": "社区/博客内容", "other": "其他页面",
            }
            return entry["type"], f"域名匹配：{entry['name']}；页面类型：{role_labels[role]}；身份分类不代表内容正确。", priority
    if any(matches_domain(host, d) for d in preferred_domains):
        return "preferred_unverified", "命中优先检索域名，但尚未由域名规则确认机构身份。", 2
    return "unclassified", "尚未确认机构身份，作为补充来源核验。", 3
