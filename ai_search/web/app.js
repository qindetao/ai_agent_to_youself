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
let cancelRequest = null;
let retryRequest = null;
let retryQuick = null;
let starredGroups = readStarredGroups();
let historyStorageAvailable = true;
const selectedRecords = new Set();
let openHistoryGroupId = null;
let historySummaryMode = "timeline";
let historyInstruction = "";

const summaryPresets = {
  timeline: ["时间线","按事件发生日期从早到晚整理。区分事件日期和报道日期，标出日期不明的事项，合并重复事件并保留引用。"],
  overview: ["要点概览","先交代查询背景，再归纳关键结论与待核实事项。合并重复内容并保留引用。"],
  changes: ["历次结果的变化","对比各版本，区分新增事实、补充来源、被修正的结论和仍有争议的说法。说明没有实质变化的情况。"],
  evidence: ["来源与证据","归纳每条主要结论的原始出处与证据，区分官方原文、媒体转述和待证实内容。"]
};
function readStarredGroups() {
  try {
    const groups = JSON.parse(localStorage.getItem("ai-search-starred-groups") || "[]");
    return new Set(Array.isArray(groups) ? groups.filter(id => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function saveStarredGroups() {
  try {
    localStorage.setItem("ai-search-starred-groups",JSON.stringify([...starredGroups]));
    $("star-status").textContent = "";
  } catch {
    $("star-status").textContent = "星标仅在本页保留，浏览器暂时无法保存。";
  }
}

function rememberActiveVersion(id) {
  try {
    if (id) sessionStorage.setItem("ai-search-active-version",id);
    else sessionStorage.removeItem("ai-search-active-version");
  } catch { /* Snapshot persistence still works if session storage is unavailable. */ }
}

function activeHistoryRecord() {
  return historyRecords.find(record => record.id === activeRecordId);
}

function historyVersionLabel(record) {
  if (record.result.result_kind === "history_summary") return record.question;
  const title = record.groupVersion === 1 ? "首次搜索" : "继续查找";
  return `版本 ${record.groupVersion} · ${title}`;
}

function renderResultActions() {
  const active = activeHistoryRecord();
  const versions = active
    ? historyRecords.filter(record => record.groupId === active.groupId).slice().reverse()
    : [];
  const nav = $("version-list");
  nav.replaceChildren();
  nav.hidden = versions.length < 2;
  if (!nav.hidden) {
    for (const record of versions) {
      const label = historyVersionLabel(record);
      const button = el("button",label,nav,"secondary");
      button.type = "button";
      button.disabled = busy;
      if (record.id === active.id) button.setAttribute("aria-current","true");
      button.addEventListener("click",() => {
        if (busy || record.id === activeRecordId) return;
        restoreHistory(record);
        showResult();
      });
    }
  }

  const deeper = active?.result.result_kind !== "history_summary"
    && active?.settings?.max_search_rounds === 1
    && (!active.result.claims.length || active.result.claims.some(claim => claim.status !== "supported"));
  $("deeper-search").hidden = !deeper;
  $("deeper-submit").disabled = busy;
  for (const button of $("suggested-questions").querySelectorAll("button")) button.disabled = busy;
}

function updateVersionLabel() {
  const record = historyRecords.find(item => item.id === activeRecordId);
  $("current-version").textContent = record
    ? `查询：${record.groupQuestion} · ${historyVersionLabel(record)} · ${new Date(record.createdAt).toLocaleString()}` : "";
}
function selectHistoryGroup(groupId, records) {
  openHistoryGroupId = openHistoryGroupId === groupId ? null : groupId;
  selectedRecords.clear();
  historySummaryMode = "timeline";
  historyInstruction = "";
  if (openHistoryGroupId) {
    const versions = records.filter(record => record.result.result_kind !== "history_summary");
    const first = versions.find(record => record.groupVersion === 1);
    const defaults = first ? [first,...versions.filter(record => record !== first).slice(0,4)] : versions.slice(0,5);
    for (const record of defaults) selectedRecords.add(record.id);
  }
  renderHistory(groupId);
}

function renderHistoryVersions(records, parent) {
  const versions = records.slice().reverse();
  const picked = () => versions.filter(record => selectedRecords.has(record.id));
  const actionButtons = [];
  const notice = el("p",null,parent,"muted");
  function updateSelection() {
    const count = picked().length;
    notice.textContent = `已选 ${count} 个版本，可选 1–5 个版本一起整理。`;
    for (const button of actionButtons) button.disabled = busy || count < 1 || count > 5;
  }

  for (const record of versions) {
    const row = el("div",null,parent,`history-row${record.id === activeRecordId ? " history-active" : ""}`);
    const label = el("label",null,row,"history-select");
    if (record.result.result_kind !== "history_summary") {
      const checkbox = el("input",null,label);
      checkbox.type = "checkbox";
      checkbox.checked = selectedRecords.has(record.id);
      checkbox.disabled = busy;
      checkbox.addEventListener("change",() => {
        if (checkbox.checked) selectedRecords.add(record.id);
        else selectedRecords.delete(record.id);
        updateSelection();
      });
    }
    const text = el("span",null,label);
    el("strong",historyVersionLabel(record),text);
    if (record.question !== record.groupQuestion && record.result.result_kind !== "history_summary") {
      el("span",record.question,text,"history-question");
    }
    el("small",new Date(record.createdAt).toLocaleString(),text);
    const restore = el("button",record.id === activeRecordId ? "正在查看" : "查看",row,"secondary");
    restore.type = "button";
    restore.disabled = busy || record.id === activeRecordId;
    restore.addEventListener("click",() => {
      restoreHistory(record);
      showResult();
    });
  }

  const actions = el("div",null,parent,"history-summary-tools");
  const label = el("label","总结方式",actions);
  const preset = el("select",null,label);
  for (const [value,[title]] of Object.entries(summaryPresets)) {
    el("option",title,preset).value = value;
  }
  preset.value = historySummaryMode;
  preset.disabled = busy;
  preset.addEventListener("change",() => { historySummaryMode = preset.value; });
  const instructionLabel = el("label","补充要求（可选）",actions);
  const instruction = el("textarea",null,instructionLabel);
  instruction.rows = 2;
  instruction.maxLength = 1500;
  instruction.value = historyInstruction;
  instruction.disabled = busy;
  instruction.addEventListener("input",() => { historyInstruction = instruction.value; });
  const buttons = el("div",null,actions,"action-row");
  const summarize = el("button","总结所选版本",buttons,"secondary");
  const search = el("button","结合所选版本重新搜索",buttons,"secondary");
  for (const button of [summarize,search]) {
    button.type = "button";
    actionButtons.push(button);
  }
  summarize.addEventListener("click",() => {
    const selected = picked();
    if (busy || !selected.length || selected.length > 5) return;
    const [title,direction] = summaryPresets[historySummaryMode];
    const extra = historyInstruction.trim();
    const payload = {
      language:records[0].settings?.language || "zh",
      instruction: extra ? `${direction}\n补充要求：${extra}` : direction,
      records:selected.map(record => ({record_id:record.id,question:record.question,result:record.result}))
    };
    runRequest("/v1/ai-search/summarize",payload,`总结 · ${title}`,selected.map(record => record.id),{destination:records[0]});
  });
  search.addEventListener("click",() => {
    const selected = picked();
    if (busy || !selected.length || selected.length > 5) return;
    const topic = records[0].groupQuestion;
    const question = historyInstruction.trim() || topic;
    runSearch(question,{
      context:SearchHistory.context(selected),
      destination:records[0],
      parentIds:selected.map(record => record.id)
    });
  });
  updateSelection();
}

function renderHistory(focusGroupId = null) {
  const groups = new Map();
  for (const record of historyRecords) {
    if (!groups.has(record.groupId)) groups.set(record.groupId, []);
    groups.get(record.groupId).push(record);
  }
  if (!groups.has(openHistoryGroupId)) openHistoryGroupId = null;
  const list = $("history-list");
  $("history-title").textContent = `查看历史（${groups.size}）`;
  list.replaceChildren();
  if (!groups.size) el("p","完成一次查询后，结果会保存在这里。",list,"muted");
  const filter = $("history-filter").value.trim().toLocaleLowerCase();
  const matching = [...groups.entries()].filter(([,records]) =>
    !filter || records.some(record => [record.groupQuestion,record.question].some(text => text.toLocaleLowerCase().includes(filter))));
  matching.sort(([a],[b]) => Number(starredGroups.has(b))-Number(starredGroups.has(a)));
  if (groups.size && !matching.length) el("p","没有符合的历史记录。",list,"muted");
  for (const [groupId,records] of matching) {
    const group = el("section",null,list,"history-group");
    const heading = el("div",null,group,"history-group-heading");
    const expanded = groupId === openHistoryGroupId;
    const topic = el("button",records[0].groupQuestion,heading,"history-topic");
    topic.type = "button";
    topic.setAttribute("aria-expanded",String(expanded));
    topic.setAttribute("aria-controls",`history-versions-${groupId}`);
    topic.disabled = busy;
    topic.addEventListener("click",() => selectHistoryGroup(groupId,records));
    if (focusGroupId === groupId) topic.focus();
    const starred = starredGroups.has(groupId);
    const star = el("button",starred ? "★ 已加星标" : "☆ 加星标",heading,"secondary");
    star.type = "button";
    star.setAttribute("aria-pressed",String(starred));
    star.setAttribute("aria-label",`${star.textContent}：${records[0].groupQuestion}`);
    star.disabled = busy;
    star.addEventListener("click",() => {
      if (busy) return;
      if (starredGroups.has(groupId)) starredGroups.delete(groupId);
      else starredGroups.add(groupId);
      saveStarredGroups();
      renderHistory();
    });
    const versions = el("div",null,group,"history-versions");
    versions.id = `history-versions-${groupId}`;
    versions.hidden = !expanded;
    if (expanded) renderHistoryVersions(records,versions);
  }
  $("clear-history").disabled = busy || !historyRecords.length;
  $("history-notice").textContent = historyStorageAvailable ? ""
    : "浏览器未能保存历史；当前记录仅在本页保留，刷新后可能丢失。";
  updateVersionLabel();
  renderResultActions();
}
function restoreHistory(record, {restoreSearchMode = true} = {}) {
  if (busy) return;
  activeRecordId = record.id;
  rememberActiveVersion(record.id);
  lastQuestion = record.question;
  lastResult = record.result;
  const settings = record.settings || {};
  $("question").value = record.groupQuestion;
  $("as-of").value = settings.as_of || "";
  $("version").value = settings.target_version || "";
  $("language").value = settings.language || "zh";
  if (restoreSearchMode && [1, 2].includes(settings.max_search_rounds)) {
    $("rounds").value = String(settings.max_search_rounds);
  }
  $("follow-up-question").value = "";
  $("error").hidden = true;
  $("retry-request").hidden = true;
  $("retry-quick").hidden = true;
  retryRequest = null;
  retryQuick = null;
  render(lastResult);
  renderHistory();
  $("progress").textContent = `已打开${historyVersionLabel(record)}，显示保存的回答和出处。`;
}
async function rememberResult(question,result,payload,parentIds,destination) {
  const id = crypto.randomUUID();
  const record = {
    id, groupId: destination?.groupId || id, groupQuestion: destination?.groupQuestion || question,
    sequence: Math.max(0,...historyRecords.map(r => r.sequence))+1,
    createdAt: new Date().toISOString(), question, result,
    parents: historyRecords.filter(r => parentIds.includes(r.id)).map(r => ({id:r.id,sequence:r.sequence,question:r.question})),
    settings: {
      language:payload.language, as_of:payload.as_of, target_version:payload.target_version,
      max_search_rounds:payload.max_search_rounds, follow_up_context:payload.follow_up_context,
      prefer_new:payload.prefer_new
    },
  };
  if (result.result_kind !== "history_summary") {
    const versions = historyRecords.filter(item => item.groupId === record.groupId);
    record.groupVersion = 1 + Math.max(0,...versions.map(item => item.groupVersion || 0));
  }
  const evicted = historyRecords.slice(19);
  historyRecords = [record,...historyRecords].slice(0,20);
  activeRecordId = record.id;
  rememberActiveVersion(record.id);
  try {
    await SearchHistory.save(record);
    for (const item of evicted) await SearchHistory.remove(item.id);
  } catch { historyStorageAvailable = false; }
}
async function loadHistory() {
  try {
    historyRecords = (await SearchHistory.list()).filter(r => r.id && r.result && Array.isArray(r.result.claims)
      && Array.isArray(r.result.sources) && Array.isArray(r.result.limitations)).sort((a,b) => b.sequence-a.sequence).slice(0,20);
    // Older snapshots stored parent links but had no query group.
    const byId = new Map(historyRecords.map(record => [record.id,record]));
    for (const record of [...historyRecords].reverse()) {
      if (record.groupId) continue;
      const parentLink = (record.parents || [])[0];
      const parent = byId.get(parentLink?.id);
      record.groupId = parent?.groupId || parentLink?.id || record.id;
      record.groupQuestion = parent?.groupQuestion || parentLink?.question || record.question;
    }
    const counters = new Map();
    for (const record of [...historyRecords].reverse()) {
      if (record.result.result_kind === "history_summary") continue;
      const before = counters.get(record.groupId) ?? (record.id === record.groupId ? 0 : 1);
      record.groupVersion ||= before + 1;
      counters.set(record.groupId,Math.max(before,record.groupVersion));
    }
    let previousId;
    try { previousId = sessionStorage.getItem("ai-search-active-version"); } catch { previousId = null; }
    if (!busy && !lastResult && historyRecords.length) {
      const record = historyRecords.find(r => r.id === previousId) || historyRecords[0];
      restoreHistory(record, {restoreSearchMode:false});
    }
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
function sourcePreview(source) {
  const publisher = /^域名匹配：([^；]+)/.exec(source.authority_reason || "")?.[1];
  let host = "";
  try { host = new URL(source.url).hostname.replace(/^www\./,""); } catch { /* Missing URL. */ }
  const name = publisher || host || source.title;
  const role = labels[source.source_role];
  return role && source.source_role !== "other" ? `${name} · ${role}` : name;
}

function renderSuggestedQuestions() {
  const area = $("suggested-questions");
  area.replaceChildren();
  const topic = activeHistoryRecord()?.groupQuestion || lastQuestion;
  const isCase = /案件|诉讼|法院|判决|爱泼斯坦|[\p{Script=Han}]案|\b(case|court|epstein)\b/iu.test(topic);
  const suggestions = isCase ? [
    ["查最新进展","查找本案尚未覆盖的最新进展，注明事件日期和出处。"],
    ["找法院原文","查找与本案直接相关的法院原文，区分判决、裁定和起诉材料。"],
    ["整理时间线","按日期整理本案的关键时间线，区分指控、司法结论和待确认信息。"]
  ] : [
    ["查最新进展","查找这个问题相关的最新变化，注明日期和出处。"],
    ["找一手资料","优先查找能直接回答原问题的一手资料，并给出出处。"],
    ["找不同说法","查找是否存在有证据支持的不同说法，说明分歧在哪里。"]
  ];
  for (const [label,question] of suggestions) {
    const button = el("button",label,area,"secondary");
    button.type = "button";
    button.disabled = busy;
    button.addEventListener("click",() => searchFollowUp(`${topic.slice(0,1700)}\n${question}`));
  }
}

function render(data) {
  const sources = new Map(data.sources.map(source => [source.id, source]));
  $("result-question").textContent = lastQuestion;
  $("answer").replaceChildren();
  $("copy-status").textContent = "";
  $("copy-text").hidden = true;
  renderSuggestedQuestions();
  const overviewSize = 3;
  const extra = data.claims.length > overviewSize
    ? details(`展开其余 ${data.claims.length-overviewSize} 条详情`,$("answer"))
    : null;
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
    const paragraph = el("p",null,extra && index >= overviewSize ? extra : $("answer"),"answer-paragraph");
    if (extra && index < overviewSize) $("answer").insertBefore(paragraph,extra);
    const sentence = el("button",null,paragraph,"answer-sentence");
    sentence.type = "button";
    sentence.setAttribute("aria-haspopup","dialog");
    el("span",claim.text,sentence,"sentence-text");
    badge(claim.status,sentence);
    const cited = [...new Set(claim.evidence.map(item => item.source_id))]
      .map(id => sources.get(id)).filter(Boolean);
    const previews = [...new Set(cited.map(sourcePreview))].filter(Boolean);
    if (previews.length) {
      const more = previews.length > 2 ? ` · 另有 ${previews.length-2} 个出处` : "";
      el("span",previews.slice(0,2).join(" / ") + more,sentence,"source-preview");
    }
    sentence.title = "点击查看这条回答的来源、证据原文和判断依据";
    sentence.addEventListener("click",() => {
      $("evidence-content").replaceChildren(card.cloneNode(true));
      $("evidence-title").textContent = `回答依据 · 第 ${index+1} 条`;
      $("evidence-dialog").showModal();
    });
  });
  if (!data.claims.length) el("p",data.answer || "本次没有找到足够证据形成回答。",$("answer"));
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
function followUpContext(active) {
  if (!active) return SearchHistory.context([{sequence:"当前",question:lastQuestion,result:lastResult}]);
  const related = historyRecords.filter(record => record.groupId === active.groupId && record.id !== active.id);
  return SearchHistory.context([active,...related]);
}

async function runSearch(question, {context = null, destination = null, parentIds = [], followUpInput = null, newSearch = false} = {}) {
  if (!question) return;
  const payload = {question,language:$("language").value,max_search_rounds:Number($("rounds").value)};
  if ($("as-of").value) payload.as_of = $("as-of").value;
  if ($("version").value.trim()) payload.target_version = $("version").value.trim();
  if (context) {
    payload.follow_up_context = context;
    payload.prefer_new = true;
  }
  return runRequest("/v1/ai-search",payload,question,parentIds,{destination,followUpInput,newSearch});
}
function showResult() {
  $("result-title").focus({preventScroll:true});
  $("result").scrollIntoView({block:"start"});
}

$("cancel-request").addEventListener("click",() => cancelRequest?.());
$("retry-request").addEventListener("click",() => retryRequest?.());
$("retry-quick").addEventListener("click",() => retryQuick?.());

$("deeper-submit").addEventListener("click",() => {
  const active = activeHistoryRecord();
  if (busy || !active || $("deeper-search").hidden) return;
  const {language,as_of,target_version,follow_up_context,prefer_new} = active.settings;
  const parents = (active.parents || []).map(parent => parent.id);
  const previous = historyRecords.filter(record => parents.includes(record.id));
  const context = follow_up_context || SearchHistory.context(previous);
  const payload = {question:active.question,language,max_search_rounds:2};
  if (as_of) payload.as_of = as_of;
  if (target_version) payload.target_version = target_version;
  if (context) {
    payload.follow_up_context = context;
    payload.prefer_new = prefer_new ?? true;
  }
  runRequest("/v1/ai-search",payload,active.question,[active.id],{destination:active});
});

async function runRequest(url,payload,question,parentIds,{destination = null,followUpInput = null,newSearch = false} = {}) {
  if (busy) return;
  busy = true;
  retryRequest = null;
  retryQuick = null;
  renderHistory();
  $("submit").disabled = true;
  $("follow-up-submit").disabled = true;
  $("error").hidden = true;
  $("retry-request").hidden = true;
  $("retry-quick").hidden = true;
  if (newSearch) $("result").hidden = true;

  const controller = new AbortController();
  const started = performance.now();
  let cancelled = false;
  const updateElapsed = () => {
    const seconds = Math.floor((performance.now()-started)/1000);
    $("elapsed").textContent = `已等待 ${seconds} 秒`;
  };
  cancelRequest = () => {
    cancelled = true;
    controller.abort();
  };
  $("progress").textContent = url.endsWith("/summarize")
    ? "正在整理选中的历史证据。"
    : "正在等待检索与核验结果。";
  updateElapsed();
  $("elapsed").hidden = false;
  $("cancel-request").hidden = false;
  $("progress").scrollIntoView({block:"nearest"});
  const tick = setInterval(updateElapsed,1000);
  const timeout = setTimeout(() => controller.abort(),220000);
  let receivedResult = false;
  let serverTimedOut = false;
  try {
    const response = await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload),signal:controller.signal});
    const data = await response.json();
    if (!response.ok) {
      let message = Array.isArray(data.detail) ? data.detail.map(item => `${item.loc.join(".")}：${item.msg}`).join("；") : data.detail;
      const requestId = response.headers.get("x-request-id");
      const retries = response.headers.get("x-retry-count");
      if (response.status === 502) message = "上游检索或模型服务出错，请查看运行服务的终端日志";
      if (response.status === 504) {
        serverTimedOut = true;
        message = "查询超过时间限制，请重试";
      }
      if (requestId) message += `（排查编号：${requestId}，已重试${retries || "0"}次）`;
      throw new Error(message || `请求失败（${response.status}）`);
    }
    if (controller.signal.aborted) throw controller.signal.reason;
    receivedResult = true;
    $("cancel-request").hidden = true;
    clearTimeout(timeout);
    await rememberResult(question,data,payload,parentIds,destination);
    lastResult = data;
    lastQuestion = question;
    render(data);
    $("progress").textContent = "查询完成。点击回答中的句子可查看来源和核验依据。";
    if (newSearch || (followUpInput !== null && $("follow-up-question").value.trim() === followUpInput)) {
      $("follow-up-question").value = "";
    }
    showResult();
  } catch (error) {
    if (lastResult) $("result").hidden = false;
    if (cancelled) {
      $("progress").textContent = "已取消等待。";
    } else {
      $("error").textContent = controller.signal.aborted
        ? "等待超时，请稍后重试。"
        : `查询失败：${error.message}`;
      $("error").hidden = false;
      $("progress").textContent = "本次查询未完成。";
    }
    if (!receivedResult) {
      retryRequest = () => runRequest(url,payload,question,parentIds,{destination,followUpInput,newSearch});
      $("retry-request").hidden = false;
      if (!cancelled && (serverTimedOut || controller.signal.aborted) && url === "/v1/ai-search" && payload.max_search_rounds === 2) {
        retryQuick = () => runRequest(url,{...payload,max_search_rounds:1},question,parentIds,{destination,followUpInput,newSearch});
        $("retry-quick").hidden = false;
      }
      if (cancelled) $("retry-request").focus();
    }
  } finally {
    clearInterval(tick);
    clearTimeout(timeout);
    cancelRequest = null;
    $("elapsed").hidden = true;
    $("cancel-request").hidden = true;
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
  runSearch($("question").value.trim(),{newSearch:true});
});
function searchFollowUp(question, followUpInput = null) {
  if (busy || !lastResult) return;
  const active = activeHistoryRecord();
  const topic = active?.groupQuestion || lastQuestion;
  return runSearch(question || topic,{
    context:followUpContext(active),
    destination:active,
    parentIds:active ? [active.id] : [],
    followUpInput
  });
}

$("follow-up-form").addEventListener("submit",event => {
  event.preventDefault();
  const input = $("follow-up-question").value.trim();
  searchFollowUp(input,input);
});
$("history-filter").addEventListener("input",renderHistory);
$("copy-answer").addEventListener("click",async () => {
  if (!lastResult) return;
  const result = lastResult;
  const cited = new Set(result.claims.flatMap(claim => claim.evidence.map(item => item.source_id)));
  const sources = result.sources.filter(source => cited.has(source.id) && /^https?:\/\//i.test(source.url));
  const lines = [lastQuestion,result.answer];
  if (sources.length) lines.push("出处",...sources.map(source => `[${source.id}] ${source.title} ${source.url}`));
  const text = lines.join("\n\n");
  try {
    await navigator.clipboard.writeText(text);
    if (lastResult === result) {
      $("copy-text").hidden = true;
      $("copy-status").textContent = "已复制答案和出处。";
    }
  } catch {
    if (lastResult !== result) return;
    const field = $("copy-text");
    field.value = text;
    field.hidden = false;
    field.focus();
    field.select();
    $("copy-status").textContent = "请复制下方已选中的文字。";
  }
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
$("history-panel").addEventListener("toggle",() => {
  if (!$("history-panel").open && openHistoryGroupId) {
    openHistoryGroupId = null;
    selectedRecords.clear();
    renderHistory();
  }
});
$("clear-history").addEventListener("click",async () => {
  if (busy) return;
  try {
    await SearchHistory.clear();
    historyRecords = [];
    starredGroups.clear();
    saveStarredGroups();
    selectedRecords.clear();
    openHistoryGroupId = null;
    activeRecordId = null;
    rememberActiveVersion(null);
    renderHistory();
  } catch {
    $("history-notice").textContent = "清空历史失败，请稍后重试。";
  }
});
loadHistory();
