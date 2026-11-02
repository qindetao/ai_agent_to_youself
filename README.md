# Python AI 搜索模块

提供可导入的 `SearchService` 和可选 FastAPI HTTP 接口。后端传入问题，模块返回逐条核验的结论、来源及证据。搜索主题由用户问题决定，不限定为 AI 资讯。

流程：生成搜索词 → Tavily 搜索与正文提取 → 相似正文证据分组 → DeepSeek 提取结论并匹配证据 → 最多一轮补充搜索 → 单独一次模型证据审核 → 程序验证引用及证据组计数、时效版本事实 → 返回。

## 启动

Python 3.10+。在本项目目录执行：

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
Copy-Item .env.example .env
# 编辑 .env，填写自己的 DeepSeek 和 Tavily 密钥
.\.venv\Scripts\python -m uvicorn ai_search.api:app --host 127.0.0.1 --port 8000
```

API 文档：http://127.0.0.1:8000/docs。默认仅本机访问。`.env` 不要提交到版本库。

交互测试页面：http://127.0.0.1:8000/。输入问题后可展开查看每条结论的证据原文、来源身份、同源分组、时间版本依据及限制，也可下载 JSON 或 Markdown。支持在上次结果基础上追问并重新检索，还能把问题反馈导出为待人工复核的测试案例；反馈只在点击下载时保存在本地，不会自动上传或加入正式问题集。页面调用相同的完整查询接口，等待提示不冒充服务端实际阶段进度。页面部署仍需遵循下文鉴权和限流要求。

30 题测试集、批量运行和人工评分说明见 [evaluation/README.md](evaluation/README.md)。在项目根目录运行 `python -m evaluation.run_eval` 只列出问题；加 `--run --limit 1` 才实际请求服务。结构检查与人工准确性评价分别记录。

配置：`DEEPSEEK_API_KEY`、`TAVILY_API_KEY` 必填，`DEEPSEEK_MODEL` 与 `DEEPSEEK_BASE_URL` 可选。模型默认 `deepseek-flash`，部署时按账户可用模型调整。本实现调用 Chat Completions JSON 输出，显式关闭思考模式，不依赖模型内置联网功能。

## 后端直接调用

已有 Python 后端可复制 `ai_search` 包并安装上述依赖，无需再起 HTTP 服务。统一从后端配置加载环境变量；独立脚本可使用 `load_dotenv()`。

```python
import asyncio
import httpx
from dotenv import load_dotenv
from ai_search import SearchRequest, SearchService
from ai_search.providers import DeepSeek, Tavily

load_dotenv()

async def answer_user(question: str) -> dict:
    async with httpx.AsyncClient(timeout=60) as client:
        service = SearchService(DeepSeek(client), Tavily(client))
        result = await asyncio.wait_for(
            service.search(SearchRequest(question=question)), timeout=210
        )
        return result.model_dump(mode="json")
```

生产后端可在应用生命周期创建并复用 AsyncClient 和 SearchService；每次请求状态独立。直接调用时由后端设置整个任务的截止时间。

## HTTP 调用

```python
import httpx

async def search_from_backend(question: str):
    async with httpx.AsyncClient(timeout=225) as client:
        response = await client.post(
            "http://127.0.0.1:8000/v1/ai-search",
            json={"question": question, "language": "zh", "max_search_rounds": 2},
        )
        response.raise_for_status()
        return response.json()
```

请求支持 `question`（1–2000 字符）、`language`（zh/en）、`max_search_rounds`（1–2）。返回：

另可传 `as_of`（YYYY-MM-DD，参考日期；默认北京时间当天）、`target_version`（精确版本字符串；默认不限定版本）和可选的 `follow_up_context`（最多6000字符，上一轮讨论摘要）。追问上下文只帮助理解指代，本轮回答仍需用新检索到的来源重新核验。新增返回 `checked_as_of` 与 `target_version`。

| 字段 | 含义 |
|---|---|
| answer | 按阅读顺序拼接的回答正文，句末保留证据支持标记及 [S1] 等引用；核验理由保存在 claims 中 |
| claims | text、status、reason、逐条拆分的 fact_checks，以及 evidence 中的 source_id 和逐字 quote；事实引用用 relation 区分支持、反驳和背景；temporal.requires_check 表示该条结论是否需要时效/版本核验 |
| sources | 来源 ID、标题、URL、发布日期（可能缺失）、抓取时间、实际提供给模型的 content |
| source_groups | 可能同源的正文分组，包含 source_ids、状态与两两相似度依据 |
| limitations | 搜索/提取失败、正文截断、证据不足等限制 |
| search_rounds | 实际搜索轮数 |
| usage | 搜索/提取/模型调用次数和 DeepSeek 返回的 token 计数；不是费用估算 |

status 为 `supported`、`partial`、`conflicting`、`insufficient`。来源只有搜索摘要时，supported 会降级为 partial；不存在的来源 ID 或无法在正文找到的引用会被剔除，无有效证据则降为 insufficient。冲突至少要有两个来源 ID，但两个网站不自动代表两个独立来源。

### 逐条事实与引用核验

每条结论会拆成若干个原子事实，返回在 `claims[].fact_checks` 中。每个事实包含 `statement`、`status`（`supported`、`contradicted`、`conflicting`、`uncertain`）和该事实对应的 `evidence`。事实引用的 `relation` 标为 `supports`、`contradicts` 或 `context`，页面会把支持与反驳原文并排显示。模型判断引用不能直接支持事实时应标为无法确认；程序会核验来源、逐字引用和正文类型，只有搜索摘要或引用校验失败不能作为已支持的事实。外层结论缺少逐条核验或事实依据时会降级；若来源分别支持和反驳同一事实，则会显示冲突。

程序能确认引用来源存在且引文逐字出现在已提取内容中，也会拦下缺少逐条核验的 `supported` 结论；“引文在语义上是否足以证明事实”仍由模型作判断，同一模型供应商可能有共同盲点，不能当作数学证明或独立人工审核。

### 同源转载识别

`sources` 新增 `evidence_group_id` 和规范化内容的 SHA-256 `content_fingerprint`。`claims` 新增 `evidence_group_ids`、`evidence_group_count`，由程序根据有效引用重新计算，不能由模型随意指定。多个网页归入同组后只算一组证据，回答中的理由也会提示可能同源。

`source_groups` 的 `possible_shared_content` 表示正文高度相似、可能同源；`undetermined` 表示未检测到相似来源，不代表已证明独立。保留所有来源链接，不删除转载页面。直接事实可由单份一手资料支持，不因分组自动降级；需要独立交叉佐证的结论交由模型按组核验。同组页面如果存在相互矛盾的数字，仍然保留冲突状态。程序会把“不同组等于独立来源”的理由改写为谨慎说明。

算法实现于 `ai_search/provenance.py`，不额外调用付费 API：Unicode NFKC 与大小写规范化，中文按字、英文按词（保留数字）生成连续5词片段；只比较至少80个 token 的正文，且至少共享60个不同片段。文本长度比至少0.65，并满足片段集合 Jaccard ≥0.80 或较短文本片段被包含比例 ≥0.90 才匹配。分组要求新成员与组内每个成员均匹配，避免相似关系链把不同文章误合并。返回的相似度是文本重合度，不是同源概率。

这是可解释的启发式识别，不能确定原作者、转载方向或最早发布时间；改写、翻译、短文、搜索摘要、公共模板和正文截断均有局限。每篇正文最多向模型提供前6000字符，以控制上下文长度；长文后段可能因此未进入本轮分析。分组只在本次请求有效，不是跨请求稳定的来源身份。

### 默认优先官方和权威来源

搜索规划选择与问题相关的最多6个官网/机构域名，Tavily 使用 `include_domains_mode: prefer` 优先检索这些域名，同时保留全网补充证据。技术问题会额外优先搜索已登记的产品官方文档；目前可识别 Python、PyTorch、DeepSeek、Go、Rust、Django、React、Kubernetes、Docker、Node.js 和 PostgreSQL 等技术栈，并从问题中保留 API、函数名和版本号，移除口语化填充词；中文问题会提示搜索中文官方文档。模型提出的未知域名不会自动被认定为官网。每轮最多提取5篇、总计最多8篇。技术问题提高正式官方文档的排序优先级，并降低官方社区/论坛页面的排序；仍保留补充来源以便发现反例。搜索分数只作相关性参考，不代表可信度。

返回 `sources.source_type` 与 `authority_reason`，说明域名分类依据；新增 `sources.source_role` 用于说明页面是官方文档、官方公告、官方社区/论坛、机构资料、研究资料库、权威媒体、社区/博客或其他页面。论坛即使属于官方域名，也会明确标为社区/论坛，不能当成正式文档。域名规则表在 `ai_search/source_priority.json`，可以由维护者扩展。目前是有限规则集，不覆盖所有机构；未知来源分类为 `preferred_unverified` 或 `unclassified`，不能解释成不可信。若没有规则表确认的官方/机构来源，limitations 会说明。

`official` 表示命中登记的厂商/项目域名，`institution` 表示政府/科研等机构域名，`authoritative_media` 表示登记的媒体域名，`research_repository` 表示论文库（例如 arXiv 预印本不代表已同行评审）。这些是域名身份分类，不是正确概率，也不能证明网页一定是机构原创。规则匹配带域名边界，避免 `python.org.evil.com` 之类误命中。

生成与审核均优先引用相关原始资料；厂商成绩明确标注自报，仍需独立证据支持比较结论，不能以官方身份覆盖反证。该策略不额外增加搜索调用次数。真实检索效果仍取决于供应商索引与问题，不能保证每次都取得官方资料。

### 搜索历史与历史总结

网页自动把最近20次成功结果保存在当前浏览器的 IndexedDB 中，包括问题、回答、逐句证据和原始来源。追问不会覆盖旧版；点击“返回此版”可恢复当时的快照，刷新仍可继续查看。记录不会跨浏览器同步，清理浏览器数据也会删除记录。

可选择1至5条历史记录：“总结选中记录”调用模型整理已有资料，不重新联网；“结合选中记录重新搜索”用这些记录帮助理解问题，并重新检索核验。两种操作都会保存为新版本。可在“整理要求或下一步问题”中指定要整理时间线、变化或分歧。

历史总结接口为 `POST /v1/ai-search/summarize`，请求包含 `records`（每项为 `record_id`、`question`、`result`）、可选 `instruction` 和 `language`。接口重映射来源编号、核对引用，保留不同参考日期；返回 `result_kind=history_summary`、`history_reference_dates`，`search_rounds=0`。汇总不代表重新确认信息最新，也不会因为多份旧答案重复相同说法就提高确定性。该接口与搜索接口一样，正式部署需接入后端鉴权和限流。

### 时效性和版本核验

示例请求：

```json
{
  "question": "Python 3.10 中 asyncio.run 的作用和参数是什么？",
  "language": "zh",
  "max_search_rounds": 2,
  "as_of": "2026-10-02",
  "target_version": "3.10"
}
```

`claims.temporal` 返回状态、理由、参考日期、目标版本、facts（时间/版本的正文引用）和 replacement_source_ids（明确替代通知来源）。facts 类型为 event_date、effective_from、effective_until、version、supersession；每条都含 value、source_id、quote。

| temporal.status | 含义 |
|---|---|
| not_assessed | 未涉及时间/版本核验，不代表已确认最新 |
| applicable_as_of | 明确的生效日期/区间支持参考日期适用，不保证全网最新 |
| version_confirmed | 官方文档或公告的正文引用直接匹配目标版本；只确认版本范围，不自动证明结论其他部分正确 |
| historical | 有过去事件日期或失效日期证据，不自动等同于虚假信息 |
| superseded | 有官方/机构正文明确替代说明，且替代生效日期不晚于参考日期 |
| version_mismatch | 证据标明的适用版本与指定目标版本不匹配 |
| uncertain | 证据不足，或引用、日期、版本、替代关系未通过校验 |

时效和版本信息保存在 claims[].temporal 中，网页点击回答句子后可查看；answer 正文不再混入核验理由和时间检查报告。模型对每条结论分别填写 temporal.requires_check；问题涉及日期或版本时仍会触发相应核验，显式 as_of 或 target_version 会要求对结论核验。稳定概念可以选择不涉及时间版本核验，避免整份答案被统一降为 uncertain。证据缺口触发下一轮官方更新/生效日期检索，仍受 max_search_rounds 上限控制。

程序验证来源ID、正文逐字引用、完整数字或中文年月日、版本字符串边界，以及生效区间和参考日期关系。指定版本时也检查官方文档 URL 中明确标出的版本路径；例如 Django 5.2 文档不能单独确认 Django 6.0 的事实。匹配的官方文档引用可标为 `version_confirmed`，它只说明版本范围对上，不自动证明结论语义正确。版本按精确字符串匹配，不按大小排序，也不自动推断 semver 兼容范围。3.1 不会被当作 3.10 的证据；无法从 URL 确认文档版本的页面，仍要求正文证据明确匹配目标版本。

网页 published_at 是供应商估计的发布或更新时间，新增 published_at_basis 标明这一点；它和 retrieved_at 均不能直接作为生效日期。旧网页不自动失效，新网页不自动覆盖旧网页。日期缺失、仅有年月、英文月份文字日期及复杂版本范围可能保持 uncertain。缺少明确生效日期时，不能确认为 applicable_as_of。

当支持程度原为 supported，但适用性不确定、版本不符、已替代、明确失效或尚未生效时，降为 partial；原 conflicting/insufficient 不会被升级。历史事件结论可以仍为 supported。关系是否对应同一产品和规则范围由模型审核，程序检查不等于证明该语义关系正确。参考过去日期也不能完全重建历史网页，已更新的网页可能丢失当时内容；缺少历史证据时必须说明不确定。

输入格式错误返回 422，模型或搜索上游错误返回 502，整个 HTTP 任务超过 210 秒返回 504。模型单次请求最多等待30秒，搜索最多等待15秒，网页提取最多等待25秒；每类临时失败最多重试一次。模型回复不完整或不符合结构时，会追加一次更严格的 JSON 格式修复请求；日志区分截断、JSON 解析和字段校验错误。证据审核只收到已引用来源的引用原句及周边上下文，避免再次发送所有网页全文；审核结果仍需人工抽查语义支持情况。上游失败会在服务端日志记录供应商、操作、错误类别、耗时及白名单错误码；日志和 API 错误响应不含密钥或上游响应正文。502/504 响应通过 `X-Request-ID` 与 `X-Retry-Count` 响应头提供排查信息，可与服务端日志对应，错误正文结构保持兼容。部分搜索失败仍可基于剩余资料回答并在 limitations 标记。`/health` 仅检查进程存活，不检查密钥或上游连接。

## 验证与边界

```powershell
python -m unittest discover -s tests -v
```

测试使用模拟上游，覆盖两轮检索、去重、伪造引用、提取失败降级、无结果、错误信息脱敏、URL 筛选和模型结构错误的一次修复。真实 API 联调需要有效密钥与网络，模拟测试不能证明供应商接口在部署环境可用。

这是可接入的 MVP，不是事实真伪鉴定系统。模型审核与生成使用同一供应商，可能犯相同错误；程序仅证明引用片段存在，不证明片段支持结论或网页本身真实。状态应作为证据充分程度展示，不能解释为正确概率。insufficient/conflicting 内容不能在前端去掉标签后当作确定事实显示。

最多保留8个来源，每轮提取至多5个网页，每个来源提供前8000字符；这可能遗漏页面后部重要证据。每次最多返回6条结论，降低简单问题中过长和跑题的概率；答案是否相关仍由模型审核，不能完全保证。URL 仅移除 fragment 去重，另有正文指纹与相似度分组；尚未做原作者和转载链追踪。发布日期来自搜索供应商，未独立验证。搜索提供方排名不是可信度分数。

网页和用户输入在提示词中均视为不可信资料；模块没有任意网页直连、文件访问或执行工具，但提示词约束不能完全消除注入风险。

正式上线前应在现有后端或网关接入鉴权、限流、并发及费用预算、必要的审计存储，并用真实问题评测引用正确率、证据覆盖率、冲突识别和延迟。本 MVP 不保存查询和页面，仅对临时网络错误、429 和部分服务端错误重试一次，尚未加入缓存；现有 FastAPI 路由没有身份认证，请用于本机开发或接入内部后端。

官方接口参考：

- DeepSeek：https://api-docs.deepseek.com/api/create-chat-completion/
- Tavily Search：https://docs.tavily.com/documentation/api-reference/endpoint/search
- Tavily Extract：https://docs.tavily.com/documentation/api-reference/endpoint/extract

