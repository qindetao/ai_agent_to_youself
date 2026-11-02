"use strict";
const $ = id => document.getElementById(id);
const labels = {
  supported:"有证据支持",partial:"部分支持",conflicting:"来源存在冲突",insufficient:"证据不足",
  contradicted:"证据相反",uncertain:"时间版本无法确认",not_assessed:"未涉及时间版本核验",
  applicable_as_of:"证据支持参考日期适用",version_confirmed:"官方证据匹配目标版本",
  historical:"历史信息",superseded:"存在明确替代",version_mismatch:"版本不匹配",
  official:"已登记官网",institution:"机构",authoritative_media:"登记权威媒体",
  research_repository:"研究资料库",preferred_unverified:"优先域名但身份未确认",
  unclassified:"身份未分类",official_document:"官方文档",official_community:"官方社区/论坛",
  official_announcement:"官方公告/发布页",institutional_source:"机构资料",
  community_or_blog:"社区/博客",other:"其他页面",page_extract:"网页正文",search_snippet:"搜索摘要"
};
const relationLabels = {supports:"支持",contradicts:"反驳",context:"相关背景"};
$("close-evidence").addEventListener("click",() => $("evidence-dialog").close());
$("evidence-dialog").addEventListener("click",event => {
  if (event.target === $("evidence-dialog")) $("evidence-dialog").close();
});
let lastResult = null;
let lastQuestion = "";
let historyRecords = [];
let activeRecordId = null;
let busy = false;
let historyStorageAvailable = true;
let selectedRecords = new Set();
function rememberActiveVersion(id) {
  try {
    if (id) sessionStorage.setItem("ai-search-active-version",id);
    else sessionStorage.removeItem("ai-search-active-version");
  } catch { /* Snapshot persistence still works if session storage is unavailable. */ }
}

function chosenHistory() {
  return historyRecords.filter(record => selectedRecords.has(record.id)).sort((a,b) => a.sequence-b.sequence);
}
function updateVersionLabel() {
  const record = historyRecords.find(item => item.id === activeRecordId);
  $("current-version").textContent = record
    ? `正在查看版本 ${record.sequence} · ${record.parents.length ? `基于版本 ${record.parents.map(p => p.sequence).join("、")} · ` : ""}${new Date(record.createdAt).toLocaleString()}` : "";
}
function renderHistory() {
  $("history-list").replaceChildren();
  if (!historyRecords.length) el("p","完成一次查询后，结果会保存在这里。",$("history-list"),"muted");
  for (const record of historyRecords) {
    const row = el("div",null,$("history-list"),`history-row${record.id === activeRecordId ? " history-active" : ""}`);
    const label = el("label",null,row,"history-select");
    const checkbox = el("input",null,label);
    checkbox.type = "checkbox";
    checkbox.checked = selectedRecords.has(record.id);
    checkbox.disabled = busy;
    checkbox.addEventListener("change",() => {
      if (checkbox.checked) selectedRecords.add(record.id); else selectedRecords.delete(record.id);
      renderHistory();
    });
    const text = el("span",null,label);
    el("strong",`版本 ${record.sequence} · ${record.result.result_kind === "history_summary" ? "历史总结" : "搜索结果"}`,text);
    el("span",record.question,text,"history-question");
    el("small",new Date(record.createdAt).toLocaleString(),text);
    const restore = el("button",record.id === activeRecordId ? "当前版本" : "返回此版",row,"secondary");
    restore.type = "button";
    restore.disabled = busy || record.id === activeRecordId;
    restore.addEventListener("click",() => restoreHistory(record));
  }
  const count = chosenHistory().length;
  for (const id of ["summarize-history","search-history"]) $(id).disabled = busy || count < 1 || count > 5;
  $("clear-history").disabled = busy || !historyRecords.length;
  $("history-instruction").disabled = busy;
  $("history-notice").textContent = (!historyStorageAvailable ? "浏览器未能保存历史；当前记录仅在本页保留，刷新后可能丢失。 " : "")
    + (count > 5 ? "最多选择 5 条记录。" : `已选择 ${count} 条记录。`);
  updateVersionLabel();
}
function restoreHistory(record) {
  if (busy) return;
  activeRecordId = record.id;
  rememberActiveVersion(record.id);
  lastQuestion = record.question;
  lastResult = record.result;
  selectedRecords = new Set([record.id]);
  const settings = record.settings || {};
  $("question").value = record.question;
  $("as-of").value = settings.as_of || "";
  $("version").value = settings.target_version || "";
  $("language").value = settings.language || "zh";
  $("rounds").value = String(settings.max_search_rounds || 2);
  $("follow-up-question").value = "";
  $("error").hidden = true;
  render(lastResult);
  renderHistory();
  $("progress").textContent = `已返回版本 ${record.sequence}，显示当时的回答与来源，未重新联网。`;
}
async function rememberResult(question,result,payload,parentIds) {
  const record = {
    id: crypto.randomUUID(), sequence: Math.max(0,...historyRecords.map(r => r.sequence))+1,
    createdAt: new Date().toISOString(), question, result,
    parents: historyRecords.filter(r => parentIds.includes(r.id)).map(r => ({id:r.id,sequence:r.sequence,question:r.question})),
    settings: {language:payload.language,as_of:payload.as_of,target_version:payload.target_version,max_search_rounds:payload.max_search_rounds},
  };
  const evicted = historyRecords.slice(19);
  historyRecords = [record,...historyRecords].slice(0,20);
  activeRecordId = record.id;
  rememberActiveVersion(record.id);
  selectedRecords = new Set([record.id]);
  try {
    await SearchHistory.save(record);
    for (const item of evicted) await SearchHistory.remove(item.id);
  } catch { historyStorageAvailable = false; }
}
async function loadHistory() {
  try {
    historyRecords = (await SearchHistory.list()).filter(r => r.id && r.result && Array.isArray(r.result.claims)
      && Array.isArray(r.result.sources) && Array.isArray(r.result.limitations)).sort((a,b) => b.sequence-a.sequence).slice(0,20);
    let previousId;
    try { previousId = sessionStorage.getItem("ai-search-active-version"); } catch { previousId = null; }
    if (!busy && !lastResult && historyRecords.length) restoreHistory(historyRecords.find(r => r.id === previousId) || historyRecords[0]);
  } catch { historyStorageAvailable = false; }
  renderHistory();
}

function el(tag, text, parent, cls) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (cls) node.className = cls;
  if (parent) parent.append(node);
  return node;
}
function badge(value, parent, label) {
  el("span", label || labels[value] || value, parent, `badge ${value}`);
}
function sourceLink(source, parent, id) {
  if (!source) return el("span", `来源 ${id || "未知"} 不在当前列表`, parent);
  let url;
  try { url = new URL(source.url); } catch { return el("span", source.title, parent); }
  if (!["http:","https:"].includes(url.protocol)) return el("span", source.title, parent);
  const link = el("a", `[${source.id}] ${source.title}`, parent);
  link.href = url.href; link.target = "_blank"; link.rel = "noopener noreferrer";
  return link;
}
function details(title, parent) {
  const node = el("details", null, parent);
  el("summary", title, node);
  return node;
}
function sourceDescription(source) {
  if (!source) return "来源信息不可用";
  return `${labels[source.source_role] || source.source_role || "其他页面"} · 网页日期 ${source.published_at || "未知"}`;
}
function renderFactEvidence(fact, sources, parent) {
  const evidence = fact.evidence || [];
  const supporting = evidence.filter(item => item.relation === "supports");
  const contradicting = evidence.filter(item => item.relation === "contradicts");
  const context = evidence.filter(item => !["supports","contradicts"].includes(item.relation));
  const grid = el("div", null, parent, "fact-grid");
  for (const [title, items, kind] of [
    ["支持该事实", supporting, "support-column"],
    ["不同说法或反驳", contradicting, "conflict-column"]
  ]) {
    const column = el("div", null, grid, `fact-column ${kind}`);
    el("strong", title, column);
    if (!items.length) el("p", "本轮没有找到这类原文。", column, "muted");
    items.forEach(item => {
      const source = sources.get(item.source_id);
      sourceLink(source, column, item.source_id);
      el("p", sourceDescription(source), column, "muted");
      el("blockquote", item.quote, column);
    });
  }
  if (context.length) {
    const background = el("div", null, parent, "fact-context");
    el("strong", "相关背景材料", background);
    context.forEach(item => {
      sourceLink(sources.get(item.source_id), background, item.source_id);
      badge("other", background, relationLabels[item.relation] || "相关背景");
      el("blockquote", item.quote, background);
    });
  }
}
function render(data) {
  const sources = new Map(data.sources.map(source => [source.id, source]));
  $("answer").replaceChildren();
  $("summary").textContent = data.result_kind === "history_summary"
    ? `历史总结 · 未重新联网 · 原记录参考日期：${(data.history_reference_dates || []).join("、") || "未提供"} · ${data.sources.length} 个来源`
    : `参考日期：${data.checked_as_of || "未提供"} · 目标版本：${data.target_version || "未限定"} · 搜索 ${data.search_rounds} 轮 · ${data.sources.length} 个来源`;
  for (const id of ["claims","sources","groups","limitations"]) $(id).replaceChildren();
  if (!data.claims.length) el("p","没有形成可核验结论，请查看下方限制说明。",$("claims"));
  data.claims.forEach((claim,index) => {
    const card = el("article",null,$("claims"),"claim");
    badge(claim.status,card);
    const temporal = claim.temporal || {};
    badge(temporal.status || "not_assessed",card);
    el("h4",`${index+1}. ${claim.text}`,card);
    el("p",claim.reason,card);
    el("p",`有效证据组：${claim.evidence_group_count}（${claim.evidence_group_ids.join("、") || "无"}）`,card,"muted");
    if ((claim.fact_checks || []).length) {
      const facts = details(`事实与来源观点对照（${claim.fact_checks.length}）`,card);
      claim.fact_checks.forEach(fact => {
        const row = el("section",null,facts,"fact-check");
        badge(fact.status,row,fact.status === "uncertain" ? "事实无法确认" : labels[fact.status]);
        el("p",fact.statement,row);
        renderFactEvidence(fact,sources,row);
      });
    } else el("p","本条没有逐条事实核验。",card,"muted");
    const citations = details(`来源与原文（${claim.evidence.length}）`,card);
    citations.open = true;
    if (!claim.evidence.length) el("p","暂无有效证据。",citations);
    claim.evidence.forEach(item => {
      sourceLink(sources.get(item.source_id),citations,item.source_id);
      el("blockquote",item.quote,citations);
    });
    const time = details("查看时间与版本依据",card);
    el("p",temporal.reason || "本条未提供时间版本判断依据。",time);
    el("p",`参考日期：${temporal.checked_as_of || data.checked_as_of || "未提供"}；目标版本：${temporal.requested_version || "未限定"}`,time);
    (temporal.facts || []).forEach(fact => {
      el("p",`${fact.kind}：${fact.value}`,time);
      sourceLink(sources.get(fact.source_id),time,fact.source_id);
      el("blockquote",fact.quote,time);
    });
    if ((temporal.replacement_source_ids || []).length) {
      el("p","明确替代说明来源",time);
      temporal.replacement_source_ids.forEach(id => sourceLink(sources.get(id),el("p",null,time),id));
    }
    const paragraph = el("p",null,$("answer"),"answer-paragraph");
    const sentence = el("button",null,paragraph,"answer-sentence");
    sentence.type = "button";
    sentence.setAttribute("aria-haspopup","dialog");
    el("span",claim.text,sentence,"sentence-text");
    badge(claim.status,sentence);
    sentence.title = "点击查看这条回答的来源、证据原文和判断依据";
    sentence.addEventListener("click",() => {
      $("evidence-content").replaceChildren(card.cloneNode(true));
      $("evidence-title").textContent = `回答依据 · 第 ${index+1} 条`;
      $("evidence-dialog").showModal();
    });
  });
  if (!data.claims.length) el("p","本次没有找到足够证据形成回答，请展开下方查询说明。",$("answer"));
  data.sources.forEach(source => {
    const card = el("article",null,$("sources"),"source");
    sourceLink(source,card);
    const tags = el("p",null,card);
    badge(source.source_type,tags); badge(source.source_role || "other",tags); badge(source.content_type,tags);
    el("p",source.authority_reason,card);
    el("p",`网页日期（供应商估计）：${source.published_at || "未知"}；抓取时间：${source.retrieved_at}；证据组：${source.evidence_group_id || "未分组"}`,card,"muted");
    el("pre",source.content,details("查看本次使用的资料",card));
  });
  (data.source_groups || []).forEach(group => {
    const card = el("div",null,$("groups"),"group");
    el("strong",`${group.id} · ${group.status === "possible_shared_content" ? "正文高度相似，可能同源" : "未确定同源关系"}`,card);
    group.source_ids.forEach(id => sourceLink(sources.get(id),el("p",null,card),id));
    (group.matches || []).forEach(match => el("p",`${match.source_ids.join(" / ")}：文本重合度 ${(match.jaccard*100).toFixed(1)}%，包含度 ${(match.containment*100).toFixed(1)}%（不是同源概率）`,card,"muted"));
  });
  if (!(data.source_groups || []).length) el("p","本次没有可展示的分组。",$("groups"));
  (data.limitations.length ? data.limitations : ["本次未返回额外限制，仍需结合原文判断。"]).forEach(item => el("li",item,$("limitations")));
  $("usage").textContent = JSON.stringify(data.usage,null,2);
  $("result").hidden = false;
}
function followUpContext() {
  if (!lastResult) return "";
  const parts = [`上一轮问题：${lastQuestion}`,"上一轮回答：",lastResult.answer,"上一轮事实明细："];
  lastResult.claims.forEach(claim => {
    parts.push(`- ${claim.status}：${claim.text}`);
    (claim.fact_checks || []).forEach(fact => parts.push(`  - ${fact.status}：${fact.statement}`));
  });
  parts.push("上一轮来源：");
  lastResult.sources.forEach(source => parts.push(`- [${source.id}] ${source.title} ${source.url}`));
  return parts.join("\n").slice(0,6000);
}
async function runSearch(question, context = null, isFollowUp = false, parentIds = null) {
  if (!question) return;
  const payload = {question,language:$("language").value,max_search_rounds:Number($("rounds").value)};
  if ($("as-of").value) payload.as_of = $("as-of").value;
  if ($("version").value.trim()) payload.target_version = $("version").value.trim();
  if (context) payload.follow_up_context = context;
  return runRequest("/v1/ai-search",payload,question,parentIds || (isFollowUp && activeRecordId ? [activeRecordId] : []),isFollowUp);
}
async function runRequest(url,payload,question,parentIds,isFollowUp=false) {
  if (busy) return;
  busy = true;
  renderHistory();
  $("submit").disabled = true;
  $("follow-up-submit").disabled = true;
  $("error").hidden = true;
  $("result").hidden = true;
  $("progress").textContent = url.endsWith("/summarize")
    ? "正在整理选中的历史证据，不会重新联网；最多等待约 3 分半钟。"
    : "正在等待检索与核验结果，最多等待约 3 分半钟。";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(),220000);
  try {
    const response = await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload),signal:controller.signal});
    const data = await response.json();
    if (!response.ok) {
      let message = Array.isArray(data.detail) ? data.detail.map(item => `${item.loc.join(".")}：${item.msg}`).join("；") : data.detail;
      const requestId = response.headers.get("x-request-id");
      const retries = response.headers.get("x-retry-count");
      if (response.status === 502) message = "上游检索或模型服务出错，请查看运行服务的终端日志";
      if (response.status === 504) message = "查询超过时间限制，请查看运行服务的终端日志";
      if (requestId) message += `（排查编号：${requestId}，已重试${retries || "0"}次）`;
      throw new Error(message || `请求失败（${response.status}）`);
    }
    await rememberResult(question,data,payload,parentIds);
    lastResult = data;
    lastQuestion = question;
    render(data);
    $("progress").textContent = "查询完成。点击回答中的句子可查看来源和核验依据。";
    if (isFollowUp) $("follow-up-question").value = "";
  } catch (error) {
    $("error").textContent = error.name === "AbortError" ? "等待超时，请稍后重新查询。" : `查询失败：${error.message}`;
    $("error").hidden = false;
    $("progress").textContent = "本次查询未完成。";
    if (lastResult) render(lastResult);
  } finally {
    clearTimeout(timer);
    $("submit").disabled = false;
    $("follow-up-submit").disabled = false;
    busy = false;
    renderHistory();
  }
}
function downloadFile(name, content, type) {
  const url = URL.createObjectURL(new Blob([content],{type}));
  const anchor = el("a",null,document.body);
  anchor.href = url; anchor.download = name; anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url),1000);
}
function markdownReport() {
  const lines = [
    `# AI 搜索结果`,"",`- 问题：${lastQuestion}`,
    `- 参考日期：${lastResult.checked_as_of || "未提供"}`,
    `- 目标版本：${lastResult.target_version || "未限定"}`,"","## 回答","",lastResult.answer,"","## 事实与来源观点对照",""
  ];
  const sources = new Map(lastResult.sources.map(source => [source.id,source]));
  lastResult.claims.forEach((claim,index) => {
    lines.push(`### ${index+1}. ${claim.text}`,"",`结论状态：${labels[claim.status] || claim.status}。${claim.reason}`,"");
    const temporal = claim.temporal || {};
    if (temporal.status && temporal.status !== "not_assessed") {
      lines.push(`时间/版本核验：${labels[temporal.status] || temporal.status}。${temporal.reason || ""}`,"");
      (temporal.facts || []).forEach(fact => {
        const source = sources.get(fact.source_id);
        lines.push(`- ${fact.kind}：${fact.value}${source ? ` — ${mdLink(source.title,source.url)}` : ""}`,`  > ${fact.quote}`);
      });
      lines.push("");
    }
    (claim.fact_checks || []).forEach(fact => {
      lines.push(`#### ${fact.statement}`,"",`事实状态：${fact.status === "uncertain" ? "事实无法确认" : labels[fact.status] || fact.status}`,"");
      for (const relation of ["supports","contradicts","context"]) {
        const items = fact.evidence.filter(item => item.relation === relation);
        if (!items.length) continue;
        lines.push(`**${relationLabels[relation]}：**`);
        items.forEach(item => {
          const source = sources.get(item.source_id);
          if (source) lines.push(`- [${source.id}] ${mdLink(source.title,source.url)}（${sourceDescription(source)}）`);
          lines.push(`  > ${item.quote}`);
        });
        lines.push("");
      }
    });
  });
  lines.push("## 来源列表","");
  lastResult.sources.forEach(source => lines.push(`- [${source.id}] ${mdLink(source.title,source.url)} — ${labels[source.source_role] || source.source_role}；网页日期 ${source.published_at || "未知"}；证据组 ${source.evidence_group_id || "未分组"}`));
  lines.push("","## 使用限制",...lastResult.limitations.map(item => `- ${item}`),"");
  return lines.join("\n");
}
function mdLink(title,url) {
  const safeTitle = String(title).replaceAll("[","\\[").replaceAll("]","\\]");
  const safeUrl = String(url).replaceAll(")","%29");
  return `[${safeTitle}](<${safeUrl}>)`;
}
function feedbackDraft() {
  const note = $("feedback-note").value.trim();
  const issue = $("feedback-type").value;
  const issueLabel = {unsupported:"引用不支持结论",wrong:"事实错误",missing_source:"缺少重要来源",wrong_version:"版本或时效不对",other:"其他"}[issue] || "其他";
  const evidenceSummary = lastResult.claims.map(claim => ({
    claim:claim.text,status:claim.status,
    facts:(claim.fact_checks || []).map(fact => ({
      statement:fact.statement,status:fact.status,
      evidence:fact.evidence.map(item => ({relation:item.relation,quote:item.quote,source_id:item.source_id,url:sourcesUrl(item.source_id)}))
    }))
  }));
  return {
    id:`feedback-${new Date().toISOString().replace(/[-:.TZ]/g,"").slice(0,14)}-${Math.random().toString(36).slice(2,6)}`,
    category:"用户反馈待复核",question:lastQuestion,
    rubric:note || `用户标记的问题类型：${issueLabel}。请人工核实问题并补充评分要点。`,
    feedback:{issue,issue_label:issueLabel,note,created_at:new Date().toISOString(),claims:evidenceSummary},
    review_status:"待人工复核"
  };
}
function sourcesUrl(id) {
  const source = lastResult.sources.find(item => item.id === id);
  return source ? source.url : "";
}

$("search-form").addEventListener("submit",event => {
  event.preventDefault();
  runSearch($("question").value.trim());
});
$("follow-up-form").addEventListener("submit",event => {
  event.preventDefault();
  if (!lastResult) return;
  runSearch($("follow-up-question").value.trim(),followUpContext(),true);
});
$("download").addEventListener("click",() => {
  if (lastResult) downloadFile("ai-search-result.json",JSON.stringify(lastResult,null,2),"application/json");
});
$("download-markdown").addEventListener("click",() => {
  if (lastResult) downloadFile("ai-search-report.md",markdownReport(),"text/markdown;charset=utf-8");
});
$("download-feedback").addEventListener("click",() => {
  if (!lastResult) return;
  downloadFile("ai-search-feedback-case.json",JSON.stringify(feedbackDraft(),null,2),"application/json");
});
$("summarize-history").addEventListener("click",() => {
  const records = chosenHistory();
  if (busy || records.length < 1 || records.length > 5) return;
  const instruction = $("history-instruction").value.trim();
  const payload = {language:$("language").value,records:records.map(r => ({record_id:r.id,question:r.question,result:r.result}))};
  if (instruction) payload.instruction = instruction;
  runRequest("/v1/ai-search/summarize",payload,`历史总结：${instruction || records.map(r => r.question).join("；")}`.slice(0,2000),records.map(r => r.id));
});
$("search-history").addEventListener("click",() => {
  const records = chosenHistory();
  if (busy || records.length < 1 || records.length > 5) return;
  const question = $("history-instruction").value.trim()
    || `综合以下问题重新检索，整理整体情况、变化和分歧：${records.map(r => r.question).join("；")}`.slice(0,2000);
  runSearch(question,SearchHistory.context(records),true,records.map(r => r.id));
});
$("clear-history").addEventListener("click",async () => {
  if (busy) return;
  try {
    await SearchHistory.clear();
    historyRecords = [];
    selectedRecords.clear();
    activeRecordId = null;
    rememberActiveVersion(null);
    renderHistory();
  } catch {
    $("history-notice").textContent = "清空历史失败，请稍后重试。";
  }
});
loadHistory();
