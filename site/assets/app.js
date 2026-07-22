const state = {
  filters: null,
  offset: 0,
  limit: 50,
  token: localStorage.getItem("justra_auth_token") || "",
  user: null,
  conversationId: localStorage.getItem("justra_conversation_id") || "",
  conversations: [],
  chatLoaded: false,
  chatLoading: null,
  billing: null,
  billingLoading: null,
  googleConfigured: false,
  filtersLoading: null,
  lastJurimetrics: null,
  duckdbInfo: null,
  radar: null,
  collector: null,
  djen: null,
  pjeOperator: null,
  pjeExtension: null,
  pjeAccounts: null,
  deadlines: null,
  updates: null,
  processCenter: null,
  updateTimelineProcess: "",
  collectorTab: "d1",
  cases: [],
  selectedCase: null,
  caseTab: "overview",
  pendingCaseFile: null,
  pendingCaseFiles: [],
  activeCaseDocumentId: "",
  pendingDocumentVersionId: "",
  caseChatPolling: false,
  interviewRecorder: null,
  interviewStream: null,
  interviewChunks: [],
  interviewBlob: null,
  interviewStartedAt: 0,
  interviewTimer: null,
  openInterviewAudioId: "",
  interviewAudioUrls: {},
  interviewAudioLoadingId: "",
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const numberFmt = new Intl.NumberFormat("pt-BR");
const compactFmt = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });
const ADMIN_ONLY_VIEWS = new Set(["jurimetria", "bot", "mapa", "coleta", "djen", "pje-operator", "sql"]);

function fmt(value) {
  if (value === null || value === undefined || value === "") return "0";
  return numberFmt.format(Number(value) || 0);
}

function fmtTokens(value) {
  return `${compactFmt.format(Number(value) || 0)} tokens`;
}

function fmtCycleDate(value) {
  if (!value) return "data de renovação indisponível";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "data de renovação indisponível";
  return parsed.toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });
}

function fmtMoment(value) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "medium" });
}

function text(value, fallback = "Não informado") {
  return value === null || value === undefined || value === "" ? fallback : String(value);
}

function normalizeText(value) {
  return text(value, "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function short(value, size = 120) {
  const content = text(value, "");
  return content.length > size ? `${content.slice(0, size - 1)}…` : content;
}

function escapeHtml(value) {
  return text(value, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function officialProcessUrl(value) {
  const url = safeUrl(String(value || "").trim());
  if (!url) return "";
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  return host === "jus.br" || host.endsWith(".jus.br") ? parsed.toString() : "";
}

function officialPjeUrlForProcessNumber(value, degree = "1") {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length !== 20) return "";
  const formatted = formatCompactProcessNumber(digits);
  const court = digits.slice(14, 16);
  const trtNumber = String(Number(court) || 2);
  return `https://pje.trt${trtNumber}.jus.br/consultaprocessual/detalhe-processo/${formatted}/${degree}`;
}

function formatCompactProcessNumber(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length !== 20) return "";
  return `${digits.slice(0, 7)}-${digits.slice(7, 9)}.${digits.slice(9, 13)}.${digits.slice(13, 14)}.${digits.slice(14, 16)}.${digits.slice(16, 20)}`;
}

function extractProcessNumber(value) {
  const textValue = String(value || "");
  const formatted = textValue.match(/\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/);
  if (formatted) return formatted[0];
  const compact = textValue.match(/(?:^|\D)(\d{20})(?!\d)/);
  return compact ? formatCompactProcessNumber(compact[1]) : "";
}

function tstUrlIsGeneric(value) {
  const url = safeUrl(value);
  if (!url || !url.includes("jurisprudencia.tst.jus.br")) return false;
  const parsed = new URL(url);
  return !parsed.searchParams.get("e") && !parsed.searchParams.get("numProc");
}

function tstSearchUrl(tipo, terms, extra = {}) {
  const params = new URLSearchParams({
    tipoJuris: tipo,
    orgao: "TST",
    pesquisar: "1",
    registrosPorPagina: tipo === "ACORDAO" ? "20" : "1000",
    ...extra,
  });
  if (tipo !== "ACORDAO") params.set("indLeiaMais", "true");
  if (terms) params.set("e", terms);
  return `https://jurisprudencia.tst.jus.br/?${params.toString()}`;
}

function processUrlFromText(value) {
  const match = text(value, "").match(/(\d{1,7})-(\d{2})\.(\d{4})\.(\d)\.(\d{2})\.(\d{4})/);
  if (!match) return "";
  return tstSearchUrl("ACORDAO", "", {
    ordenacao: "data",
    numProc: String(Number(match[1])),
    digProc: match[2],
    anoProc: match[3],
    numTribunal: String(Number(match[5])),
    numVara: match[6],
  });
}

function compactTstTerms(code, title) {
  const number = text(code, "").match(/(\d{1,4})\s*$/)?.[1] || "";
  const stop = new Set(["de", "da", "do", "das", "dos", "com", "para", "por", "que", "uma", "sobre", "tst", "sum", "oj", "pn", "sumula", "súmula"]);
  const words = text(title, "")
    .replace(/\b(?:TST\s+)?(?:SUM|PN)-?\s*\d{1,4}\b/gi, " ")
    .replace(/\b(?:TST\s+)?OJ(?:-[A-Z][A-Z0-9/]*)?-?\s*\d{1,4}\b/gi, " ")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((item) => item.length >= 3 && !stop.has(item.toLowerCase()) && !/^\d+$/.test(item));
  return [number, ...words.slice(0, 5)].filter(Boolean).join(" ");
}

function sourceSpecificUrl(source = {}) {
  const current = safeUrl(source.source_url || "");
  if (!current) return "";
  const sourceName = source.source || "";
  const layer = source.source_layer || "";
  const kind = source.kind || "";
  const code = source.code || "";
  const title = source.title || "";
  if (sourceName !== "tst") return current;
  if ((kind === "acordao" || layer === "tst_acordaos") && tstUrlIsGeneric(current)) {
    return processUrlFromText(`${code} ${title}`) || current;
  }
  const type = source.type_code
    || (kind === "sumula" ? "SUM" : kind === "orientacao_jurisprudencial" ? "OJ" : kind === "precedente_normativo" ? "PN" : "")
    || (/^SUM-/i.test(code) ? "SUM" : /^OJ-/i.test(code) ? "OJ" : /^PN-/i.test(code) ? "PN" : "");
  if (type && tstUrlIsGeneric(current)) return tstSearchUrl(type, compactTstTerms(code, title));
  return current;
}

function enhanceLegalUrl(label, url) {
  const safe = safeUrl(url);
  if (!safe || !tstUrlIsGeneric(safe)) return safe;
  const content = text(label, "");
  const simpleRef = content.match(/\b(?:TST\s+)?(SUM|PN)-?\s*(\d{1,4})\b/i);
  const ojRef = content.match(/\b(?:TST\s+)?OJ(?:-[A-Z][A-Z0-9/]*)?-?\s*(\d{1,4})\b/i);
  const sumulaRef = content.match(/\bS[úu]mula\s*(\d{1,4})\b/i);
  if (simpleRef || ojRef || sumulaRef) {
    const tipo = simpleRef ? simpleRef[1].toUpperCase() : ojRef ? "OJ" : "SUM";
    const number = simpleRef ? simpleRef[2] : ojRef ? ojRef[1] : sumulaRef[1];
    return tstSearchUrl(tipo, compactTstTerms(number, content));
  }
  return processUrlFromText(content) || safe;
}

function renderMessageHtml(value) {
  const links = [];
  let content = text(value, "");
  content = content.replace(/\[([^\]]{1,180})\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
    const safe = enhanceLegalUrl(label, url);
    if (!safe) return label;
    const index = links.push(`<a href="${escapeHtml(safe)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`) - 1;
    return `__JUSTRA_LINK_${index}__`;
  });
  content = content.replace(/https?:\/\/[^\s<>()]+/g, (url) => {
    const safe = safeUrl(url);
    if (!safe) return url;
    const index = links.push(`<a href="${escapeHtml(safe)}" target="_blank" rel="noreferrer">${escapeHtml(url)}</a>`) - 1;
    return `__JUSTRA_LINK_${index}__`;
  });
  let html = escapeHtml(content)
    .replace(/\*\*([^*]{1,180})\*\*/g, "<strong>$1</strong>")
    .replaceAll("\n", "<br>");
  links.forEach((link, index) => {
    html = html.replaceAll(`__JUSTRA_LINK_${index}__`, link);
  });
  return html;
}

function stripLegacyGraphText(value) {
  return text(value, "").replace(/\n*Grafo histórico e relações:[\s\S]*$/i, "").trim();
}

function stripRenderedAppendices(value) {
  return stripLegacyGraphText(value)
    .replace(/\n*Fontes jurídicas relacionadas do acervo:[\s\S]*?(?=\n\nAcórdãos com inteiro teor relacionados no Falcão|$)/i, "")
    .replace(/\n*Acórdãos com inteiro teor relacionados no Falcão \(amostra textual, não estatística\):[\s\S]*$/i, "")
    .trim();
}

let legalBriefSequence = 0;

function renderAnswerSections(value, prefix) {
  const lines = stripRenderedAppendices(value).split(/\r?\n/);
  const sections = [];
  let current = { title: "Análise", lines: [] };
  const knownHeading = /^(resposta curta|síntese|conclusão|o que os dados mostram|o que sustenta a leitura|o contraponto|como usar na prática|estratégia prática|limites(?: da análise)?|próximos passos)\s*:?[\s]*$/i;
  for (const line of lines) {
    const markdownHeading = line.match(/^#{1,3}\s+(.+)$/);
    if (markdownHeading || knownHeading.test(line.trim())) {
      if (current.lines.some((item) => item.trim())) sections.push(current);
      current = { title: (markdownHeading?.[1] || line).replace(/:$/, "").trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.some((item) => item.trim())) sections.push(current);
  if (!sections.length) sections.push({ title: "Análise", lines: ["Sem resposta disponível."] });

  const renderLines = (sectionLines) => {
    const blocks = [];
    let bullets = [];
    let prose = [];
    const flushBullets = () => {
      if (!bullets.length) return;
      blocks.push(`<ul>${bullets.map((item) => `<li>${renderMessageHtml(item)}</li>`).join("")}</ul>`);
      bullets = [];
    };
    const flushProse = () => {
      if (!prose.length) return;
      blocks.push(`<p>${renderMessageHtml(prose.join("\n"))}</p>`);
      prose = [];
    };
    for (const line of sectionLines) {
      const bullet = line.match(/^\s*[-*]\s+(.+)$/);
      if (bullet) {
        flushProse();
        bullets.push(bullet[1]);
      } else if (!line.trim()) {
        flushProse();
        flushBullets();
      } else {
        flushBullets();
        prose.push(line);
      }
    }
    flushProse();
    flushBullets();
    return blocks.join("");
  };

  return {
    sections: sections.map((section, index) => ({
      ...section,
      id: `${prefix}-answer-${index + 1}`,
      html: `<section class="brief-section" id="${prefix}-answer-${index + 1}"><h3><span>${String(index + 1).padStart(2, "0")}</span>${escapeHtml(section.title)}</h3><div class="brief-prose">${renderLines(section.lines)}</div></section>`,
    })),
  };
}

function legalBriefLabel(kind) {
  return {
    legal_research: "Análise jurídica",
    judgment_metrics: "Análise jurimétrica",
    top_subjects: "Panorama do acervo",
    top_claims: "Panorama do acervo",
  }[kind || ""] || "Resposta fundamentada";
}

function legalBriefScope(toolResult = {}) {
  const values = [];
  if (toolResult.court_unit) values.push(toolResult.court_unit);
  if (toolResult.period?.label) values.push(toolResult.period.label);
  if (toolResult.claim_type) values.push(text(toolResult.claim_type, "").replaceAll("_", " "));
  return values.slice(0, 3).join(" · ") || "Acervo jurídico disponível";
}

function renderMetricEvidence(toolResult = {}) {
  if (toolResult.kind !== "judgment_metrics") return "";
  const finalTotal = Number(toolResult.final_outcome_processes || 0);
  const favorable = Number(toolResult.favorable_to_employee_proxy || 0);
  const favorableRate = finalTotal ? Math.round((favorable / finalTotal) * 100) : null;
  const outcomes = (toolResult.outcomes || []).slice(0, 6);
  const maxOutcome = Math.max(1, ...outcomes.map((item) => Number(item.total || 0)));
  return `
    <div class="brief-metrics">
      <article><strong>${fmt(toolResult.judged_processes)}</strong><span>processos julgados</span></article>
      <article><strong>${fmt(finalTotal)}</strong><span>com desfecho identificado</span></article>
      <article><strong>${favorableRate === null ? "—" : `${favorableRate}%`}</strong><span>favoráveis pela proxy</span></article>
    </div>
    ${outcomes.length ? `<div class="outcome-bars">${outcomes.map((item) => `
      <div class="outcome-row">
        <span>${escapeHtml(text(item.outcome, "sem classificação").replaceAll("_", " "))}</span>
        <i><b style="width:${Math.max(4, Math.round((Number(item.total || 0) / maxOutcome) * 100))}%"></b></i>
        <strong>${fmt(item.total)}</strong>
      </div>`).join("")}</div>` : ""}
  `;
}

function renderEvidenceReading(toolResult = {}) {
  const legalSources = toolResult.legal_sources || [];
  const fullTextSources = toolResult.full_text_sources || [];
  const active = legalSources.filter((source) => source.is_active).length;
  const historical = legalSources.length - active;
  const finalTotal = Number(toolResult.final_outcome_processes || 0);
  const favorable = Number(toolResult.favorable_to_employee_proxy || 0);
  const other = Math.max(0, finalTotal - favorable);
  const support = [];
  const caution = [];
  if (active) support.push(`${fmt(active)} fonte${active === 1 ? " ativa localizada" : "s ativas localizadas"} para sustentar a base jurídica.`);
  if (fullTextSources.length) support.push(`${fmt(fullTextSources.length)} acórdão${fullTextSources.length === 1 ? " com" : "s com"} inteiro teor relacionado para leitura qualitativa.`);
  if (favorable) support.push(`${fmt(favorable)} desfecho${favorable === 1 ? " favorável" : "s favoráveis"} pela proxy do recorte.`);
  if (historical) caution.push(`${fmt(historical)} fonte${historical === 1 ? " exige" : "s exigem"} cautela por caráter histórico ou cancelado.`);
  if (!fullTextSources.length) caution.push("O acervo não trouxe inteiro teor relacionado; fundamentos e provas não podem ser inferidos.");
  if (other) caution.push(`${fmt(other)} desfecho${other === 1 ? " não entra" : "s não entram"} na proxy favorável e precisa${other === 1 ? "" : "m"} ser considerado${other === 1 ? "" : "s"}.`);
  if (!support.length && !caution.length) return "";
  return `
    <div class="evidence-balance">
      <article class="supports"><span>Sustenta a leitura</span><ul>${(support.length ? support : ["Não há evidência positiva suficiente neste recorte."]).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></article>
      <article class="cautions"><span>Contraponto e cautela</span><ul>${(caution.length ? caution : ["Nenhuma cautela adicional foi identificada nos metadados disponíveis."]).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></article>
    </div>
  `;
}

function renderFullTextCard(source, index) {
  const url = safeUrl(source.source_url || "");
  const title = [source.process_number, source.court_unit].filter(Boolean).join(" · ") || "Acórdão relacionado";
  const meta = [source.decision_date, source.reporting_judge].filter(Boolean).join(" · ");
  return `
    <article class="full-text-card">
      <span class="source-index">${index}</span>
      <div><h4>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(title)}</a>` : escapeHtml(title)}</h4>
      ${meta ? `<small>${escapeHtml(meta)}</small>` : ""}
      <p>${escapeHtml(short(source.excerpt || "", 520))}</p></div>
    </article>`;
}

function renderSourcesLibrary(toolResult = {}) {
  const legalSources = toolResult.legal_sources || [];
  const fullTextSources = toolResult.full_text_sources || [];
  if (!legalSources.length && !fullTextSources.length) return `<p class="brief-empty">Nenhuma fonte correspondente foi localizada no acervo.</p>`;
  return `
    ${fullTextSources.length ? `<div class="source-group"><h4>Decisões com inteiro teor <span>${fmt(fullTextSources.length)}</span></h4>${fullTextSources.map((source, index) => renderFullTextCard(source, index + 1)).join("")}</div>` : ""}
    ${legalSources.length ? `<div class="source-group"><h4>Base legal e jurisprudencial <span>${fmt(legalSources.length)}</span></h4><div class="brief-source-grid">${legalSources.map((source) => sourceCard(source)).join("")}</div></div>` : ""}
  `;
}

function renderLegalBrief(item = {}) {
  const toolResult = item.tool_result || {};
  const answer = item.content || item.answer || "Sem resposta.";
  const substantive = ["legal_research", "judgment_metrics", "top_subjects", "top_claims"].includes(toolResult.kind)
    || (toolResult.legal_sources || []).length
    || (toolResult.full_text_sources || []).length;
  if (!substantive) return null;

  const prefix = `legal-brief-${++legalBriefSequence}`;
  const parsed = renderAnswerSections(answer, prefix);
  const legalSources = toolResult.legal_sources || [];
  const fullTextSources = toolResult.full_text_sources || [];
  const sourceCount = legalSources.length + fullTextSources.length;
  const wordCount = stripRenderedAppendices(answer).trim().split(/\s+/).filter(Boolean).length;
  const readTime = Math.max(1, Math.ceil(wordCount / 180));
  const quality = fullTextSources.length ? "Com inteiro teor" : legalSources.length ? "Base jurídica localizada" : "Leitura por metadados";
  const evidenceHtml = `${renderMetricEvidence(toolResult)}${renderEvidenceReading(toolResult)}`;
  const hasEvidence = Boolean(evidenceHtml.trim());
  const hasLimits = (toolResult.limits || []).length > 0;
  const hasSources = sourceCount > 0;
  const hasMap = Boolean((toolResult.legal_graph?.nodes || []).length);
  const extraSections = [
    hasEvidence ? { id: `${prefix}-evidence`, label: "Evidências" } : null,
    hasLimits ? { id: `${prefix}-limits`, label: "Nota metodológica" } : null,
    { id: `${prefix}-sources`, label: "Fontes" },
    hasMap ? { id: `${prefix}-map`, label: "Mapa da tese" } : null,
  ].filter(Boolean);
  const navItems = [
    ...parsed.sections.map((section) => ({ id: section.id, label: section.title })),
    ...extraSections,
  ];
  const title = short(toolResult.question || "Análise do recorte jurídico", 150);
  const article = document.createElement("article");
  article.className = "legal-brief";
  article.innerHTML = `
    <header class="brief-header">
      <p>${escapeHtml(legalBriefLabel(toolResult.kind))}</p>
      <h2>${escapeHtml(title)}</h2>
      <div class="brief-meta">
        <span>${readTime} min de leitura</span><span>${fmt(sourceCount)} fontes</span><span class="quality">${escapeHtml(quality)}</span>
      </div>
      <small>${escapeHtml(legalBriefScope(toolResult))}</small>
    </header>
    <div class="brief-layout">
      <div class="brief-main">
        ${parsed.sections.map((section) => section.html).join("")}
        ${hasEvidence ? `<section class="brief-section" id="${prefix}-evidence"><h3><span>↗</span>Evidências do acervo</h3>${evidenceHtml}</section>` : ""}
        ${hasLimits ? `<section class="brief-section limits-section" id="${prefix}-limits"><h3><span>!</span>Escopo e confiabilidade</h3><ul>${toolResult.limits.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>` : ""}
        <section class="brief-section sources-section" id="${prefix}-sources"><h3><span>§</span>Fontes consultadas</h3>${renderSourcesLibrary(toolResult)}</section>
      </div>
      <nav class="brief-toc" aria-label="Nesta resposta"><strong>Nesta resposta</strong>${navItems.map((item) => `<a href="#${item.id}">${escapeHtml(item.label)}</a>`).join("")}</nav>
    </div>`;
  if (hasMap) {
    const details = document.createElement("details");
    details.className = "brief-map-details";
    details.id = `${prefix}-map`;
    details.innerHTML = `<summary><span>Mapa da tese</span><small>Explore as relações entre as fontes</small></summary>`;
    details.appendChild(renderLegalMap(toolResult));
    article.querySelector(".brief-main").appendChild(details);
  }
  return article;
}

function sourceRoleLabel(role) {
  return {
    base_legal: "Base legal",
    jurisprudencia_ativa: "Jurisprudência ativa",
    acordao_recente: "Acórdão recente",
    historico_cancelado: "Histórico/cancelado",
    doutrina: "Doutrina",
    fonte_relacionada: "Fonte relacionada",
  }[role || ""] || "Fonte relacionada";
}

function sourceRoleNote(role) {
  return {
    base_legal: "Use para sustentar o fundamento jurídico inicial.",
    jurisprudencia_ativa: "Use para interpretar e reforçar a aplicação da tese.",
    acordao_recente: "Use para ver como o TST aplicou o tema recentemente.",
    historico_cancelado: "Não use como fundamento principal sem validar a vigência.",
    doutrina: "Use para contexto e construção argumentativa.",
    fonte_relacionada: "Material correlato no acervo.",
  }[role || ""] || "Material correlato no acervo.";
}

function sourceCard(source, compact = false) {
  const role = source.role || "fonte_relacionada";
  const url = sourceSpecificUrl(source);
  const fullTitle = source.title || source.code || "Fonte jurídica";
  const title = escapeHtml(compact ? short(fullTitle, 96) : fullTitle);
  const code = escapeHtml(source.code || "");
  const snippet = compact ? "" : escapeHtml(short(source.snippet || source.observation || "", 230));
  const meta = [source.publication_date, source.status].filter(Boolean).map((item) => escapeHtml(item)).join(" · ");
  return `
    <article class="legal-source-card ${statusSlug(role)} ${source.is_active ? "active" : "inactive"}" title="${escapeHtml(fullTitle)}">
      <div class="source-card-top">
        <span>${escapeHtml(sourceRoleLabel(role))}</span>
        ${code ? `<strong>${code}</strong>` : ""}
      </div>
      <h4>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${title}</a>` : title}</h4>
      ${meta ? `<small>${meta}</small>` : ""}
      ${snippet ? `<p>${snippet}</p>` : ""}
      ${compact ? "" : `<em>${escapeHtml(sourceRoleNote(role))}</em>`}
    </article>
  `;
}

function legalGroup(sources, role, limit = 3) {
  return sources.filter((source) => source.role === role).slice(0, limit);
}

function relationLabel(edge, nodeById) {
  const from = nodeById.get(edge.from);
  const to = nodeById.get(edge.to);
  const fromLabel = from?.label || edge.from || "Fonte";
  const toLabel = to?.label || edge.to || "tema";
  return `${short(fromLabel, 54)} ${edge.label || "relaciona"} ${short(toLabel, 54)}`;
}

function renderLegalMap(toolResult) {
  const graph = toolResult?.legal_graph || {};
  const sources = toolResult?.legal_sources || [];
  if (!sources.length && !graph.nodes?.length) return null;
  const div = document.createElement("div");
  div.className = "legal-map";
  const nodeById = new Map((graph.nodes || []).map((node) => [node.id, node]));
  const latest = graph.latest_active || {};
  const latestUrl = sourceSpecificUrl(latest);
  const latestTitleFull = latest.title || latest.code || "Fonte ativa";
  const latestTitle = escapeHtml(short(latestTitleFull, 96));
  const latestDate = escapeHtml(latest.publication_date || "data não identificada");
  const latestHtml = latestTitle && latest.is_active
    ? `
      <div class="map-latest">
        <span>Fonte ativa mais recente</span>
        ${latestUrl ? `<a href="${escapeHtml(latestUrl)}" target="_blank" rel="noreferrer" title="${escapeHtml(latestTitleFull)}">${latestTitle}</a>` : `<strong>${latestTitle}</strong>`}
        <small>${latestDate}</small>
      </div>
    `
    : "";
  const base = legalGroup(sources, "base_legal", 2);
  const active = legalGroup(sources, "jurisprudencia_ativa", 2);
  const recent = legalGroup(sources, "acordao_recente", 1);
  const historical = legalGroup(sources, "historico_cancelado", 1);
  const doctrine = legalGroup(sources, "doutrina", 1);
  const relationHtml = (graph.edges || [])
    .filter((edge) => edge.to === "topic" || edge.label === "validar com ativa")
    .slice(0, 4)
    .map((edge) => `<li>${escapeHtml(relationLabel(edge, nodeById))}</li>`)
    .join("");
  const empty = `<div class="map-empty">Sem item forte nesta camada.</div>`;
  div.innerHTML = `
    <div class="legal-map-head">
      <div>
        <strong>${escapeHtml(graph.title || "Mapa da tese")}</strong>
        <small>Fontes organizadas por função jurídica, não só por relevância textual.</small>
      </div>
      <span>${fmt(sources.length)} fontes</span>
    </div>
    ${latestHtml}
    <div class="legal-map-flow">
      <section class="map-column base">
        <h3>Base legal</h3>
        ${base.length ? base.map((source) => sourceCard(source, true)).join("") : empty}
      </section>
      <section class="map-column active">
        <h3>Interpretação ativa</h3>
        ${active.length ? active.map((source) => sourceCard(source, true)).join("") : empty}
      </section>
      <section class="map-column recent">
        <h3>Aplicação atual</h3>
        ${recent.length ? recent.map((source) => sourceCard(source, true)).join("") : empty}
      </section>
      <section class="map-column historical">
        <h3>Histórico e cautelas</h3>
        ${historical.length ? historical.map((source) => sourceCard(source, true)).join("") : empty}
      </section>
    </div>
    ${doctrine.length ? `<div class="map-extra"><h3>Doutrina/contexto</h3>${doctrine.map((source) => sourceCard(source, true)).join("")}</div>` : ""}
    ${relationHtml ? `<div class="map-relations"><h3>Relações úteis</h3><ul>${relationHtml}</ul></div>` : ""}
  `;
  return div;
}

function statusSlug(value) {
  return text(value, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function badge(value, kind = "") {
  const cls = kind ? ` ${kind}` : "";
  return `<span class="badge${cls}">${escapeHtml(value)}</span>`;
}

function statusBadge(value) {
  return `<span class="badge status-${statusSlug(value)}">${escapeHtml(value)}</span>`;
}

function formatDataJudDate(value) {
  const raw = text(value, "");
  if (/^\d{14}$/.test(raw)) {
    return `${raw.slice(6, 8)}/${raw.slice(4, 6)}/${raw.slice(0, 4)}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    return `${raw.slice(8, 10)}/${raw.slice(5, 7)}/${raw.slice(0, 4)}`;
  }
  return raw || "Não informado";
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const raw = await res.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { error: raw.startsWith("<!DOCTYPE") ? `HTTP ${res.status}: resposta HTML inesperada` : raw || `HTTP ${res.status}` };
  }
  if (!res.ok) {
    const error = new Error(data.error || "Erro na API");
    error.status = res.status;
    error.code = data.code || "api_error";
    error.data = data;
    throw error;
  }
  return data;
}

function setAuthVisible(visible) {
  $("#authScreen").classList.toggle("hidden", !visible);
  $(".app-shell").classList.toggle("auth-locked", visible);
}

function setAuthMessage(message) {
  $("#authMessage").textContent = message || "";
}

async function applyAuth(data) {
  state.token = data.token;
  state.user = data.user;
  localStorage.setItem("justra_auth_token", state.token);
  setAuthVisible(false);
  $$(".nav-item.admin").forEach((item) => {
    item.style.display = state.user.role === "admin" ? "" : "none";
  });
  if (state.user.role !== "admin" && ADMIN_ONLY_VIEWS.has(initialView())) {
    setView("processos-v2");
  }
  await loadAppData();
}

async function checkAuth() {
  if (!state.token) {
    setAuthVisible(true);
    return false;
  }
  try {
    const data = await api("/api/auth/me");
    state.user = data.user;
    setAuthVisible(false);
    $$(".nav-item.admin").forEach((item) => {
      item.style.display = state.user.role === "admin" ? "" : "none";
    });
    if (state.user.role !== "admin" && ADMIN_ONLY_VIEWS.has(initialView())) {
      setView("processos-v2");
    }
    return true;
  } catch {
    state.token = "";
    localStorage.removeItem("justra_auth_token");
    setAuthVisible(true);
    return false;
  }
}

async function loadGoogleConfig() {
  const button = $("#googleButton");
  const hint = $("#googleHint");
  try {
    const data = await api("/api/auth/google/config");
    state.googleConfigured = Boolean(data.configured);
    button.disabled = !state.googleConfigured;
    hint.textContent = state.googleConfigured
      ? "Login seguro pela sua conta Google."
      : "Adicione o Client ID e o Client Secret para ativar.";
  } catch {
    state.googleConfigured = false;
    button.disabled = true;
    hint.textContent = "Google indisponível no momento.";
  }
}

function startGoogleLogin() {
  if (!state.googleConfigured) {
    setAuthMessage("Login com Google ainda não configurado.");
    return;
  }
  setAuthMessage("");
  location.href = "/api/auth/google/start";
}

async function completeGoogleLoginFromUrl() {
  if (!location.pathname.includes("/auth/google/complete")) return false;
  const params = new URLSearchParams(location.search);
  const errorMessage = params.get("google_error");
  if (errorMessage) {
    history.replaceState({}, "", "/");
    setAuthVisible(true);
    setAuthMessage(`Não foi possível entrar com Google: ${errorMessage}`);
    return true;
  }
  const loginCode = params.get("login_code");
  if (!loginCode) {
    history.replaceState({}, "", "/");
    setAuthVisible(true);
    setAuthMessage("O retorno do Google não trouxe um código de login válido.");
    return true;
  }
  try {
    const data = await api("/api/auth/google/complete", {
      method: "POST",
      body: JSON.stringify({ login_code: loginCode }),
    });
    const destination = data.user?.role === "admin" ? "jurimetria" : "processos-v2";
    history.replaceState({ view: destination }, "", destination === "jurimetria" ? "/jurimetria" : "/processos");
    setView(destination);
    await applyAuth(data);
  } catch (err) {
    history.replaceState({}, "", "/");
    setAuthVisible(true);
    setAuthMessage(err.message);
  }
  return true;
}

function setView(view) {
  if (state.user && state.user.role !== "admin" && ADMIN_ONLY_VIEWS.has(view)) {
    view = "processos-v2";
  }
  $$(".view").forEach((item) => item.classList.toggle("active", item.id === `view-${view}`));
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  document.body.classList.toggle("chat-view-active", view === "chat");
  if (view !== "chat") setAuditOpen(false);
  const path =
    view === "jurimetria"
      ? "/jurimetria"
      : view === "processos-v2"
        ? "/processos"
      : view === "processos"
        ? "/processos-legado"
      : view === "document-analysis"
        ? "/analise-documento"
      : view === "updates"
        ? "/atualizacoes"
      : view === "deadlines"
        ? "/prazos"
      : view === "entrevista"
        ? "/entrevista"
      : view === "radar"
        ? "/radar"
      : view === "billing"
        ? "/assinatura"
      : view === "bot"
        ? "/admin/bot"
        : view === "mapa"
          ? "/admin/mapa"
          : view === "coleta"
            ? "/admin/coleta"
          : view === "djen"
            ? "/admin/djen"
          : view === "pje-operator"
            ? "/admin/pje"
          : view === "sql"
            ? "/admin/sql"
            : "/chat";
  if (location.pathname !== path) history.pushState({ view }, "", path);
  if (state.user && view === "bot") loadBotHealth();
  if (state.user && view === "processos-v2") loadProcessCenter().catch(renderProcessCenterError);
  if (state.user && view === "processos") loadCases();
  if (state.user && view === "document-analysis") loadDocumentAnalysisHub().catch(renderDocumentAnalysisError);
  if (state.user && view === "updates") loadUpdates().catch(() => {});
  if (state.user && view === "deadlines") loadDeadlines().catch(() => {});
  if (state.user && view === "entrevista") loadInterviewCases();
  if (state.user && view === "mapa") loadCoverageMap();
  if (state.user && view === "radar") loadRadar();
  if (state.user && view === "coleta") loadCollector();
  if (state.user && view === "djen") loadDjen().catch(() => {});
  if (state.user && view === "pje-operator") loadPjeOperator().catch(() => {});
  if (state.user && view === "sql") loadDuckdbWorkbench();
  if (state.user && view === "billing") loadBilling();
  if (state.user && view === "jurimetria") loadJurimetrics();
  if (state.user && view === "chat") loadChatShell();
}

function setAuditOpen(open) {
  const panel = $("#auditPanel");
  const button = $("#toggleAudit");
  if (!panel || !button) return;
  panel.classList.toggle("hidden", !open);
  button.classList.toggle("active", open);
  button.textContent = open ? "Ocultar auditoria" : "Auditoria";
  button.title = open ? "Ocultar auditoria" : "Abrir auditoria";
}

function initialView() {
  if (location.pathname.includes("/chat")) return "chat";
  if (location.pathname.includes("/entrevista")) return "entrevista";
  if (location.pathname.includes("/atualizacoes")) return "updates";
  if (location.pathname.includes("/prazos")) return "deadlines";
  if (location.pathname.includes("/processos-legado")) return "processos";
  if (location.pathname.includes("/processos-v2")) return "processos-v2";
  if (location.pathname.includes("/analise-documento")) return "document-analysis";
  if (location.pathname.includes("/processos")) return "processos-v2";
  if (location.pathname.includes("/assinatura")) return "billing";
  if (location.pathname.includes("/radar")) return "radar";
  if (location.pathname.includes("/admin/bot")) return "bot";
  if (location.pathname.includes("/admin/mapa")) return "mapa";
  if (location.pathname.includes("/admin/coleta")) return "coleta";
  if (location.pathname.includes("/admin/djen")) return "djen";
  if (location.pathname.includes("/admin/pje")) return "pje-operator";
  if (location.pathname.includes("/admin/sql")) return "sql";
  return "processos-v2";
}

function optionHtml(value, label, total) {
  const suffix = total === undefined ? "" : ` (${fmt(total)})`;
  return `<option value="${escapeHtml(value)}">${escapeHtml(label)}${suffix}</option>`;
}

function populateFilters(filters) {
  state.filters = filters;
  $("#periodFilter").innerHTML = filters.periods.map((item) => optionHtml(item.value, item.label)).join("");
  $("#claimFilter").innerHTML = optionHtml("", "Todos") + filters.claims.map((item) => optionHtml(item.value, item.label, item.total)).join("");
  $("#courtFilter").innerHTML = optionHtml("", "Todas") + filters.courts.map((item) => optionHtml(item.value, item.label, item.total)).join("");
  $("#outcomeFilter").innerHTML = optionHtml("", "Todos") + filters.outcomes.map((item) => optionHtml(item.value, item.label)).join("");
  if (filters.judges.length) {
    $("#judgeFilter").disabled = false;
    $("#judgeFilter").innerHTML = optionHtml("", "Todos") + filters.judges.map((item) => optionHtml(item.value, item.label, item.total)).join("");
  } else {
    $("#judgeFilter").disabled = true;
    $("#judgeFilter").innerHTML = optionHtml("", "Sem juiz importado");
  }
}

function jurimetricsQuery() {
  const params = new URLSearchParams({
    period: $("#periodFilter").value,
    limit: String(state.limit),
    offset: String(state.offset),
  });
  const pairs = [
    ["claim", $("#claimFilter").value],
    ["court_unit", $("#courtFilter").value],
    ["judge", $("#judgeFilter").value],
    ["outcome", $("#outcomeFilter").value],
    ["q", $("#queryFilter").value.trim()],
  ];
  pairs.forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  return params.toString();
}

async function loadJurimetrics() {
  await ensureFilters();
  $("#dbStatus").textContent = "Consultando DuckDB";
  const data = await api(`/api/jurimetrics?${jurimetricsQuery()}`);
  state.lastJurimetrics = data;
  renderJurimetrics(data);
  $("#dbStatus").textContent = "DuckDB local";
  $(".dot").classList.add("ok");
}

function setBillingNotice(message = "", kind = "") {
  const notice = $("#billingNotice");
  notice.textContent = message;
  notice.classList.toggle("visible", Boolean(message));
  notice.classList.toggle("success", kind === "success");
}

function renderBilling(data) {
  state.billing = data;
  const isPremium = data.plan === "premium";
  $("#navPlanName").textContent = data.plan_name;
  $("#planShortcut").textContent = data.plan_name;
  $("#currentPlanName").textContent = data.plan_name;
  $("#currentPlanKicker").textContent = data.cancel_at_period_end ? "Cancelamento agendado" : "Seu plano atual";
  $("#currentPlanCycle").textContent = `${data.cancel_at_period_end ? "Acesso até" : "Renova em"} ${fmtCycleDate(data.cycle_ends_at)}`;
  $("#tokensRemaining").textContent = compactFmt.format(data.tokens_remaining);
  $("#conversationAllowance").textContent = data.conversation_limit === null ? "Ilimitadas" : `${data.conversation_limit} conversa`;
  $("#usageProgress").style.width = `${data.usage_percent}%`;
  $("#usageProgressLabel").textContent = `${fmtTokens(data.tokens_used)} de ${fmtTokens(data.token_limit)} usados`;
  $("#chatQuotaLabel").textContent = `${data.plan_name} · ${compactFmt.format(data.tokens_remaining)} restantes`;
  $("#chatQuotaProgress").style.width = `${data.usage_percent}%`;
  $("#premiumPrice").textContent = data.premium_price_label;

  $("#freePlanCard").classList.toggle("current", !isPremium);
  $("#premiumPlanCard").classList.toggle("current", isPremium);
  $("#freePlanButton").textContent = isPremium ? "Plano de entrada" : "Plano atual";
  $("#upgradeButton").disabled = isPremium || !data.stripe_configured;
  $("#upgradeButton").textContent = isPremium ? "Premium ativo" : data.stripe_configured ? "Assinar Premium" : "Conectar Stripe para assinar";
  $("#manageBillingButton").classList.toggle("hidden", !data.has_stripe_customer);
  $("#newConversation").disabled = !data.can_create_conversation;
  $("#newConversation").title = data.can_create_conversation
    ? "Criar uma nova conversa"
    : "O plano Grátis inclui uma conversa por ciclo";

  const params = new URLSearchParams(location.search);
  if (params.get("checkout") === "success") {
    setBillingNotice("Pagamento concluído. A Stripe está confirmando sua assinatura; o Premium será ativado em instantes.", "success");
  } else if (params.get("checkout") === "cancelled") {
    setBillingNotice("Checkout cancelado. Seu plano atual continua igual.");
  } else if (!data.stripe_configured) {
    setBillingNotice("A interface está pronta. Quando você criar a conta Stripe, basta adicionar a chave secreta e o segredo do webhook para ativar o checkout.");
  } else if (!data.stripe_webhook_configured) {
    setBillingNotice("Checkout conectado. Falta adicionar o segredo do webhook para a ativação automática do Premium.");
  } else {
    setBillingNotice("");
  }
}

async function loadBilling() {
  const data = await api("/api/billing");
  renderBilling(data);
}

async function ensureBilling() {
  if (state.billing) return state.billing;
  if (!state.billingLoading) {
    state.billingLoading = api("/api/billing")
      .then((data) => {
        renderBilling(data);
        return data;
      })
      .finally(() => {
        state.billingLoading = null;
      });
  }
  return state.billingLoading;
}

async function ensureFilters() {
  if (state.filters) return state.filters;
  if (!state.filtersLoading) {
    state.filtersLoading = api("/api/filters")
      .then((filters) => {
        populateFilters(filters);
        return filters;
      })
      .finally(() => {
        state.filtersLoading = null;
      });
  }
  return state.filtersLoading;
}

async function startCheckout() {
  const button = $("#upgradeButton");
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Abrindo checkout...";
  try {
    const data = await api("/api/billing/checkout", { method: "POST", body: "{}" });
    location.href = data.url;
  } catch (err) {
    button.disabled = false;
    button.textContent = original;
    setBillingNotice(err.message);
  }
}

async function openBillingPortal() {
  const data = await api("/api/billing/portal", { method: "POST", body: "{}" });
  location.href = data.url;
}

function handleQuotaError(err) {
  if (!["conversation_limit", "token_limit", "quota_exceeded", "radar_term_limit"].includes(err.code)) return false;
  if (err.data?.billing) renderBilling(err.data.billing);
  setView("billing");
  setBillingNotice(err.message);
  return true;
}

async function loadConversations(query = "") {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  const data = await api(`/api/chat/conversations?${params.toString()}`);
  state.conversations = data.conversations || [];
  const hasCurrent = state.conversations.some((item) => item.conversation_id === state.conversationId);
  if (!query && state.conversationId && !hasCurrent) {
    state.conversationId = "";
    localStorage.removeItem("justra_conversation_id");
  }
  if (!state.conversationId && state.conversations.length) {
    state.conversationId = state.conversations[0].conversation_id;
    localStorage.setItem("justra_conversation_id", state.conversationId);
  }
  renderConversations();
}

function renderConversations() {
  $("#conversationList").innerHTML = state.conversations.length
    ? state.conversations
        .map(
          (item) => `
            <button class="conversation-item ${item.conversation_id === state.conversationId ? "active" : ""}" data-conversation-id="${escapeHtml(item.conversation_id)}" type="button">
              <strong>${escapeHtml(item.title)}</strong>
              <small>${escapeHtml(item.updated_at)} · ${fmt(item.message_count)} mensagens</small>
              <small>ID ${escapeHtml(item.conversation_id)}</small>
            </button>
          `
        )
        .join("")
    : `<div class="muted">Nenhuma conversa ainda.</div>`;
  $$("#conversationList .conversation-item").forEach((item) => {
    item.addEventListener("click", () => selectConversation(item.dataset.conversationId).catch((err) => addMessage(String(err), "assistant")));
  });
}

async function selectConversation(conversationId) {
  state.conversationId = conversationId;
  localStorage.setItem("justra_conversation_id", conversationId);
  renderConversations();
  $("#messages").innerHTML = `<div class="message assistant">Carregando conversa...</div>`;
  const data = await api(`/api/chat/conversations/${encodeURIComponent(conversationId)}`);
  renderConversationDetail(data.conversation);
}

async function newConversation() {
  const data = await api("/api/chat/conversations", {
    method: "POST",
    body: JSON.stringify({ title: "Nova conversa" }),
  });
  state.conversationId = data.conversation.conversation_id;
  localStorage.setItem("justra_conversation_id", state.conversationId);
  $("#messages").innerHTML = `<div class="message assistant">Nova conversa criada.</div>`;
  renderMemory({});
  renderGraders($("#lastGraders"), []);
  await loadConversations($("#conversationSearch").value.trim());
}

function renderCards(container, cards) {
  container.innerHTML = cards
    .map(
      (card) => `
        <div class="metric-card">
          <span>${escapeHtml(card.label)}</span>
          <strong>${escapeHtml(card.value)}</strong>
          <small>${escapeHtml(card.note || "")}</small>
        </div>
      `
    )
    .join("");
}

function renderJurimetrics(data) {
  const summary = data.summary;
  renderCards($("#summaryCards"), [
    { label: "Processos", value: fmt(summary.processes), note: data.filters.period.label },
    { label: "Classificados", value: fmt(summary.classified_processes), note: "com pedido/assunto" },
    { label: "Julgamento/decisão", value: fmt(summary.judged_processes), note: "por movimento" },
    { label: "Desfecho final", value: fmt(summary.final_outcome_processes), note: "heurística" },
    { label: "Favoráveis", value: fmt(summary.favorable_to_worker_proxy), note: "procedente + parcial" },
    { label: "Inteiro teor", value: fmt(summary.full_text_documents), note: "importados" },
    { label: "Juízes", value: fmt(summary.judges_identified), note: "dependem do inteiro teor" },
  ]);
  renderBars($("#outcomeBars"), data.outcomes, "outcome");
  renderBars($("#claimBars"), data.top_claims, "claim_type");
  renderBars($("#subjectBars"), data.top_subjects, "subject");
  renderBars($("#courtBars"), data.top_courts, "court_unit");
  $("#outcomeByClaimTable").innerHTML = data.outcome_by_claim.length
    ? data.outcome_by_claim
        .map(
          (row) => `
            <tr>
              <td>${escapeHtml(row.claim_type)}</td>
              <td>${escapeHtml(row.outcome)}</td>
              <td>${fmt(row.total)}</td>
            </tr>
          `
        )
        .join("")
    : `<tr><td colspan="3" class="muted">Sem desfechos para o filtro atual.</td></tr>`;
  renderProcesses(data);
}

function renderBars(container, rows, key) {
  if (!rows.length) {
    container.innerHTML = `<div class="muted">Sem dados para o filtro atual.</div>`;
    return;
  }
  const max = Math.max(...rows.map((row) => Number(row.total) || 0), 1);
  container.innerHTML = rows
    .map((row) => {
      const label = row[key];
      const width = Math.max(3, Math.round((Number(row.total) / max) * 100));
      return `
        <div class="bar-row" title="${escapeHtml(label)}">
          <div class="bar-label">${escapeHtml(label)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div>
          <div class="bar-value">${fmt(row.total)}</div>
        </div>
      `;
    })
    .join("");
}

function renderProcesses(data) {
  const rows = data.processes;
  $("#processTable").innerHTML = rows.length
    ? rows
        .map((row) => {
          const processLink = row.pje_url
            ? `<a href="${escapeHtml(row.pje_url)}" target="_blank" rel="noreferrer">${escapeHtml(row.formatted || row.process_number)}</a>`
            : escapeHtml(row.formatted || row.process_number);
          const fullText = row.full_text_url
            ? `<a href="${escapeHtml(row.full_text_url)}" target="_blank" rel="noreferrer">abrir</a>`
            : `<span class="badge warn">não importado</span>`;
          const judge = row.judge_name || row.reporting_judge || "não importado";
          return `
            <tr>
              <td>${processLink}<br><span class="muted">${escapeHtml(row.degree || "")}</span></td>
              <td>${escapeHtml(short(row.court_unit, 90))}</td>
              <td>${escapeHtml(short(row.case_class, 72))}</td>
              <td>${escapeHtml(short(row.claims, 95))}</td>
              <td>${escapeHtml(short(row.subjects, 130))}</td>
              <td>${formatDataJudDate(row.filing_date)}</td>
              <td>${row.outcome ? badge(row.outcome) : `<span class="muted">sem desfecho</span>`}<br><span class="muted">${escapeHtml(formatDataJudDate(row.outcome_date))}</span></td>
              <td>${fullText}</td>
              <td>${escapeHtml(judge)}</td>
            </tr>
          `;
        })
        .join("")
    : `<tr><td colspan="9" class="muted">Nenhum processo encontrado.</td></tr>`;
  const from = data.pagination.offset + 1;
  const to = data.pagination.offset + data.pagination.returned;
  $("#pageInfo").textContent = data.pagination.returned ? `${fmt(from)}-${fmt(to)}` : "0-0";
  $("#prevPage").disabled = data.pagination.offset === 0;
  $("#nextPage").disabled = data.pagination.returned < data.pagination.limit;
}

function addMessage(content, kind = "assistant", meta = "") {
  const div = document.createElement("div");
  div.className = `message ${kind}`;
  if (kind === "assistant") {
    div.innerHTML = renderMessageHtml(content);
  } else {
    div.textContent = content;
  }
  if (meta) {
    const m = document.createElement("div");
    m.className = "meta";
    m.textContent = meta;
    div.appendChild(m);
  }
  $("#messages").appendChild(div);
  $("#messages").scrollTop = $("#messages").scrollHeight;
  return div;
}

function assistantMeta(item = {}) {
  return `Fonte: DuckDB local${item.model_used ? ` + ${item.model_used}` : ""}${item.llm_error ? ` | LLM: ${item.llm_error}` : ""}${item.memory_used?.length ? ` | memória: ${item.memory_used.join(", ")}` : ""}`;
}

function fillAssistantMessage(div, item = {}) {
  const brief = renderLegalBrief(item);
  if (brief) {
    div.classList.add("with-legal-brief");
    div.appendChild(brief);
  } else {
    const answerBody = document.createElement("div");
    answerBody.className = "message-body";
    answerBody.innerHTML = renderMessageHtml(stripLegacyGraphText(item.content || item.answer || "Sem resposta."));
    div.appendChild(answerBody);
  }
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = assistantMeta(item);
  div.appendChild(meta);
}

function focusAssistantMessage(div) {
  const messages = $("#messages");
  if (div.classList.contains("with-legal-brief")) {
    requestAnimationFrame(() => {
      messages.scrollTop = Math.max(0, div.offsetTop - messages.offsetTop - 12);
    });
  } else {
    messages.scrollTop = messages.scrollHeight;
  }
}

function appendAssistantMessage(item = {}) {
  const div = document.createElement("div");
  div.className = "message assistant";
  fillAssistantMessage(div, item);
  $("#messages").appendChild(div);
  focusAssistantMessage(div);
  return div;
}

function renderConversationDetail(conversation) {
  state.conversationId = conversation.conversation_id;
  localStorage.setItem("justra_conversation_id", state.conversationId);
  renderConversations();
  $("#messages").innerHTML = "";
  const history = conversation.history || [];
  if (!history.length) {
    addMessage("Nova conversa criada. Pode começar um novo recorte.", "assistant");
  } else {
    history.forEach((item) => {
      if (item.role === "user") {
        addMessage(item.content || "", "user");
      } else {
        appendAssistantMessage(item);
      }
    });
  }
  const lastAssistant = [...history].reverse().find((item) => item.role === "assistant") || {};
  renderMemory(conversation.context || {});
  renderGraders($("#lastGraders"), lastAssistant.graders || []);
  $("#messages").scrollTop = $("#messages").scrollHeight;
}

async function loadSelectedConversation() {
  if (!state.conversationId) {
    $("#messages").innerHTML = `<div class="message assistant">Pronto. Pergunte por pedido, período, vara, desfecho ou peça uma continuação do assunto anterior.</div>`;
    renderMemory({});
    renderGraders($("#lastGraders"), []);
    return;
  }
  try {
    const data = await api(`/api/chat/conversations/${encodeURIComponent(state.conversationId)}`);
    renderConversationDetail(data.conversation);
  } catch {
    state.conversationId = "";
    localStorage.removeItem("justra_conversation_id");
    $("#messages").innerHTML = `<div class="message assistant">Não encontrei a conversa salva. Pode iniciar uma nova pergunta.</div>`;
    renderMemory({});
    renderGraders($("#lastGraders"), []);
  }
}

async function loadChatShell() {
  if (state.chatLoaded) return;
  if (!state.chatLoading) {
    state.chatLoading = (async () => {
      await loadConversations();
      await loadSelectedConversation();
      state.chatLoaded = true;
    })().finally(() => {
      state.chatLoading = null;
    });
  }
  await state.chatLoading;
}

function renderMemory(memory) {
  const items = [];
  if (memory?.period?.label) items.push(["Período", memory.period.label]);
  if (memory?.claim_type) items.push(["Pedido", memory.claim_type]);
  if (memory?.court_unit) items.push(["Unidade", memory.court_unit]);
  if (memory?.last_kind) items.push(["Análise", memory.last_kind]);
  $("#memoryPills").innerHTML = items.length
    ? items.map(([key, value]) => `<span class="badge">${escapeHtml(key)}: ${escapeHtml(value)}</span>`).join("")
    : `<span class="badge warn">sem contexto herdado</span>`;
}

function renderGraders(container, graders) {
  container.innerHTML = graders?.length
    ? graders
        .map(
          (item) => `
            <div class="check-row ${item.passed ? "pass" : "fail"}">
              <strong>${item.passed ? "OK" : "Atenção"} · ${escapeHtml(item.id)}</strong>
              <small>${escapeHtml(item.detail || "")}</small>
            </div>
          `
        )
        .join("")
    : `<div class="muted">Sem auditoria ainda.</div>`;
}

async function askChat(message) {
  addMessage(message, "user");
  const pending = addMessage("Consultando acervo...", "assistant");
  const data = await api("/api/chat", {
    method: "POST",
    body: JSON.stringify({ message, conversation_id: state.conversationId }),
  });
  state.conversationId = data.conversation_id;
  localStorage.setItem("justra_conversation_id", state.conversationId);
  pending.innerHTML = "";
  fillAssistantMessage(pending, data);
  focusAssistantMessage(pending);
  renderMemory(data.memory);
  renderGraders($("#lastGraders"), data.graders);
  if (data.billing) renderBilling(data.billing);
  await loadConversations($("#conversationSearch").value.trim());
}

async function clearChat() {
  const data = await api("/api/chat/clear", {
    method: "POST",
    body: JSON.stringify({ conversation_id: state.conversationId }),
  });
  state.conversationId = data.conversation_id || state.conversationId;
  if (state.conversationId) localStorage.setItem("justra_conversation_id", state.conversationId);
  $("#messages").innerHTML = `<div class="message assistant">Memória limpa. Pode começar um novo recorte.</div>`;
  renderMemory({});
  renderGraders($("#lastGraders"), []);
  await loadConversations();
}

async function loadBotHealth() {
  const data = await api("/api/admin/bot-health");
  renderCards($("#botHealthCards"), [
    { label: "Sessões", value: fmt(data.session_count), note: "em memória" },
    { label: "Auditorias", value: fmt(data.audit_count), note: "últimas respostas" },
    { label: "OpenAI", value: data.openai_configured ? "ativo" : "ausente", note: data.openai_model },
    { label: "Processos", value: fmt(data.counts.processes), note: "DuckDB" },
    { label: "Inteiro teor", value: fmt(data.counts.full_text_documents), note: "full_text_documents" },
    { label: "Fontes jurídicas", value: fmt(data.legal_source_count), note: "TST/TRT2" },
  ]);
  $("#graderTotals").innerHTML = Object.entries(data.grade_totals).length
    ? Object.entries(data.grade_totals)
        .map(([id, totals]) => `<div class="check-row ${totals.failed ? "fail" : "pass"}"><strong>${escapeHtml(id)}</strong><small>${fmt(totals.passed)} OK · ${fmt(totals.failed)} falhas</small></div>`)
        .join("")
    : `<div class="muted">Sem respostas auditadas nesta sessão.</div>`;
  $("#guardrailList").innerHTML = data.controls.guardrails
    .map((item) => `<div class="rule-row"><strong>${escapeHtml(item.id)} ${item.enabled ? "" : "(off)"}</strong><small>${escapeHtml(item.severity)} · ${escapeHtml(item.rule)}</small></div>`)
    .join("");
  $("#botControlsEditor").value = JSON.stringify(data.controls, null, 2);
  $("#auditTable").innerHTML = data.recent_audits.length
    ? data.recent_audits
        .map((item) => {
          const failed = item.graders.filter((grade) => !grade.passed).length;
          const passed = item.graders.length - failed;
          return `
            <tr>
              <td>${escapeHtml(item.created_at)}</td>
              <td>${escapeHtml(short(item.question, 120))}</td>
              <td>${escapeHtml(item.route?.source || item.kind || "n/d")}<br><span class="muted">${escapeHtml(item.route?.kind || "")}</span></td>
              <td>${escapeHtml(item.model_used || "determinístico")}</td>
              <td>${escapeHtml((item.memory_used || []).join(", ") || "nenhuma")}</td>
              <td>${passed} OK · ${failed} falhas</td>
            </tr>
          `;
        })
        .join("")
    : `<tr><td colspan="6" class="muted">Sem auditorias ainda.</td></tr>`;
}

async function saveBotControls() {
  const status = $("#saveStatus");
  try {
    const payload = JSON.parse($("#botControlsEditor").value);
    await api("/api/admin/bot-controls", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    status.textContent = "Configuração salva.";
    await loadBotHealth();
  } catch (err) {
    status.textContent = `Erro: ${err.message}`;
  }
}

async function loadCoverageMap() {
  const data = await api("/api/admin/coverage-map");
  renderCards($("#coverageCards"), [
    { label: "Processos TRT2", value: fmt(data.summary.processes), note: "DataJud" },
    { label: "Unidades TRT2", value: fmt(data.summary.court_units), note: "varas/órgãos" },
    { label: "Pedidos", value: fmt(data.summary.claims), note: "classificações" },
    { label: "Eventos decisórios", value: fmt(data.summary.decision_events), note: "movimentos" },
    { label: "Inteiro teor", value: fmt(data.summary.full_text), note: "documentos" },
    { label: "Atualizado", value: data.updated_at.slice(11, 16), note: data.updated_at.slice(0, 10) },
  ]);
  $("#sourceLayerTable").innerHTML = data.source_layers
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(row.court)}</td>
          <td>${escapeHtml(row.layer)}</td>
          <td>${statusBadge(row.status)}</td>
          <td>${fmt(row.count)}</td>
          <td><code>${escapeHtml(row.storage || "não informado")}</code></td>
          <td>${escapeHtml(row.quality)}</td>
          <td>${escapeHtml(row.next_step)}</td>
        </tr>
      `
    )
    .join("");
  const dictionaryGroups = (data.table_dictionary || []).reduce((groups, table) => {
    const key = table.database || "outros";
    groups[key] ||= { label: table.database_label || key, tables: [] };
    groups[key].tables.push(table);
    return groups;
  }, {});
  $("#tableDictionary").innerHTML = Object.entries(dictionaryGroups)
    .map(
      ([database, group]) => `
        <section class="dictionary-group">
          <div class="dictionary-group-title">
            <div><span class="eyebrow">${escapeHtml(database)}</span><h3>${escapeHtml(group.label)}</h3></div>
            <span class="badge">${group.tables.length} tabelas</span>
          </div>
          ${group.tables
            .map(
              (table) => `
                <details class="dictionary-item">
                  <summary>
                    <span>
                      <code>${escapeHtml(table.full_name)}</code>
                      <small>${escapeHtml(short(table.purpose, 125))}</small>
                    </span>
                    <strong>${table.rows == null ? "indisponível" : `${fmt(table.rows)} linhas`}</strong>
                  </summary>
                  <div class="dictionary-body">
                    <div class="dictionary-facts">
                      <div><span>O que guarda</span><p>${escapeHtml(table.purpose)}</p></div>
                      <div><span>Cada linha significa</span><p>${escapeHtml(table.grain)}</p></div>
                      <div><span>Origem</span><p>${escapeHtml(table.source)}</p></div>
                      <div><span>Chave lógica</span><p><code>${escapeHtml(table.logical_key)}</code></p></div>
                      <div class="wide"><span>Relacionamentos</span><p>${escapeHtml(table.relationships)}</p></div>
                    </div>
                    <h4>Principais campos</h4>
                    <div class="table-wrap dictionary-fields">
                      <table>
                        <thead><tr><th>Campo</th><th>Significado</th></tr></thead>
                        <tbody>${table.fields
                          .map(
                            (field) => `<tr><td><code>${escapeHtml(field.name)}</code></td><td>${escapeHtml(field.meaning)}</td></tr>`
                          )
                          .join("")}</tbody>
                      </table>
                    </div>
                    <h4>Esquema atual no banco</h4>
                    <div class="schema-chips">${table.columns
                      .map(
                        (column) => `<code>${escapeHtml(column.name)} <small>${escapeHtml(column.type)}</small></code>`
                      )
                      .join("")}</div>
                    <h4>Consulta para verificar o status</h4>
                    <pre class="dictionary-query"><code>${escapeHtml(table.verification_query)}</code></pre>
                  </div>
                </details>
              `
            )
            .join("")}
        </section>
      `
    )
    .join("");
  $("#courtMapTable").innerHTML = data.courts
    .map(
      (row) => `
        <tr>
          <td><strong>${escapeHtml(row.court)}</strong></td>
          <td>${statusBadge(row.metadata)}</td>
          <td>${statusBadge(row.jurisprudence)}</td>
          <td>${statusBadge(row.doctrine)}</td>
          <td>${statusBadge(row.full_text)}</td>
          <td>${fmt(row.count)}</td>
        </tr>
      `
    )
    .join("");
  $("#openGaps").innerHTML = data.open_gaps.map((gap) => `<div class="gap-row"><strong>Pendente</strong><small>${escapeHtml(gap)}</small></div>`).join("");
}

function renderRadar(data) {
  state.radar = data;
  const limit = data.access.term_limit;
  $("#radarPlanBadge").textContent = data.access.label;
  $("#radarLimitText").textContent = limit === null
    ? `${data.monitors.length} termos · sem limite para admin`
    : `${data.monitors.length} de ${limit} termo${limit === 1 ? "" : "s"} utilizado${limit === 1 ? "" : "s"}`;
  $("#radarMonitorMeta").textContent = `${data.active_count} ativo${data.active_count === 1 ? "" : "s"} · ${data.monitors.length} total`;
  $("#navRadarCount").textContent = data.events.length ? `${data.events.length} encontrados` : "Sem novidades";
  $("#radarGeneratedAt").textContent = `Atualizado ${fmtMoment(data.generated_at)}`;
  $("#radarMonitors").innerHTML = data.monitors.length
    ? data.monitors.map((monitor) => `
        <article class="radar-monitor ${monitor.active ? "" : "paused"}" data-monitor-id="${escapeHtml(monitor.id)}">
          <div>
            <div><strong>${escapeHtml(monitor.term)}</strong><small>Criado em ${fmtMoment(monitor.created_at)}</small></div>
            ${badge(`${fmt(monitor.match_count)} itens`, monitor.match_count ? "" : "warn")}
          </div>
          <div class="radar-monitor-actions">
            <button type="button" data-radar-action="toggle">${monitor.active ? "Pausar termo" : "Reativar"}</button>
            <button type="button" class="delete" data-radar-action="delete">Excluir</button>
          </div>
        </article>
      `).join("")
    : `<div class="gap-row"><strong>Seu Radar está vazio</strong><small>Adicione uma tese acima para começar.</small></div>`;
  $("#radarEvents").innerHTML = data.events.length
    ? data.events.map((event) => `
        <article class="radar-event ${event.locked ? "locked" : ""}">
          <div class="radar-event-head">
            ${badge(event.event_type)}
            <small>${escapeHtml(event.term)}</small>
          </div>
          <h3>${escapeHtml(event.title)}</h3>
          <div class="radar-event-meta">
            <span>${escapeHtml(event.source || "Fonte jurídica")}</span>
            <span>·</span><span>${escapeHtml(event.court || "Tribunal não informado")}</span>
            <span>·</span><span>${escapeHtml(event.publication_date || "sem data")}</span>
          </div>
          <div class="radar-preview">${(event.preview_lines || []).map((line) => `<p>${escapeHtml(line)}</p>`).join("")}</div>
          ${event.locked ? `
            <div class="radar-locked">
              <div class="radar-locked-lines"><span></span><span></span><span></span><span></span></div>
              <div class="radar-paywall">
                <strong>Continue a leitura no Premium</strong>
                <small>Veja o inteiro teor, a fonte oficial e monitore até 5 termos.</small>
                <button type="button" data-radar-upgrade>Ver assinatura</button>
              </div>
            </div>
          ` : `
            <div class="radar-event-meta">
              ${event.reporting_judge ? `<span>Relatoria: ${escapeHtml(event.reporting_judge)}</span>` : ""}
              ${safeUrl(event.source_url) ? `<a href="${escapeHtml(safeUrl(event.source_url))}" target="_blank" rel="noreferrer">Abrir fonte oficial</a>` : ""}
            </div>
          `}
        </article>
      `).join("")
    : `<div class="gap-row"><strong>Nenhuma correspondência ainda</strong><small>O Radar verificará novamente quando o acervo receber novos documentos.</small></div>`;
}

async function loadRadar() {
  renderRadar(await api("/api/radar"));
}

async function createRadarMonitor(term) {
  await api("/api/radar/monitors", { method: "POST", body: JSON.stringify({ term }) });
  $("#radarTerm").value = "";
  await loadRadar();
}

async function radarMonitorAction(monitorId, action) {
  await api("/api/radar/monitors/action", {
    method: "POST",
    body: JSON.stringify({ monitor_id: monitorId, action }),
  });
  await loadRadar();
}

function definitionRows(items) {
  return items.map(([label, value]) => `<div class="definition-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
}

function collectorCollectionLabel(value) {
  return {
    acordaos: "Acórdãos",
    sentencas: "Sentenças",
    decisoesmonocraticas: "Monocráticas",
    recursorevista: "Recurso de revista",
    precedentes: "Precedentes",
  }[value] || value;
}

function setCollectorTab(tab) {
  state.collectorTab = tab === "windows" ? "windows" : "d1";
  const windows = state.collectorTab === "windows";
  $("#collectorPaneD1").classList.toggle("hidden", windows);
  $("#collectorPaneWindows").classList.toggle("hidden", !windows);
  $("#collectorTabD1").classList.toggle("active", !windows);
  $("#collectorTabWindows").classList.toggle("active", windows);
  $("#collectorTabD1").setAttribute("aria-selected", String(!windows));
  $("#collectorTabWindows").setAttribute("aria-selected", String(windows));
}

function renderBackfillPlan(data) {
  const plan = data.backfill_plan || { windows: [] };
  const running = data.runtime.state === "running";
  const blocked = Boolean(data.control.blocked);
  const strategyReview = Boolean(data.control.strategy_review_required);
  $("#backfillPlanMeta").textContent = `${plan.start_date || "—"} a ${plan.end_date || "—"} · ${fmt(plan.days)} janelas`;
  renderCards($("#backfillCards"), [
    { label: "Concluídas", value: fmt(plan.complete), note: "5 coleções completas" },
    { label: "Parciais", value: fmt(plan.partial), note: "retomáveis" },
    { label: "Pendentes", value: fmt(plan.pending), note: "ainda não iniciadas" },
    { label: "Plano", value: `${fmt(plan.days)} dias`, note: "janela diária" },
  ]);
  const start = $("#backfillStartDate");
  const end = $("#backfillEndDate");
  start.min = plan.start_date || "";
  start.max = plan.end_date || "";
  end.min = plan.start_date || "";
  end.max = plan.end_date || "";
  if (!start.value) start.value = plan.start_date || "";
  if (!end.value) end.value = plan.end_date || "";
  $("#runBackfillRange").disabled = running || blocked || !data.control.enabled;
  $("#backfillWindowRows").innerHTML = (plan.windows || []).map((windowItem) => {
    const completed = (windowItem.completed_collections || []).length;
    const missing = (windowItem.missing_collections || []).map(collectorCollectionLabel).join(", ");
    const statusLabel = { complete: "Completa", partial: "Parcial", pending: "Pendente" }[windowItem.status] || windowItem.status;
    const disabled = running || blocked || !data.control.enabled || windowItem.status === "complete";
    return `<tr>
      <td><strong>${escapeHtml(windowItem.date)}</strong>${windowItem.is_d1 ? `<small class="window-d1">D-1</small>` : ""}</td>
      <td><span class="window-status ${escapeHtml(windowItem.status)}">${escapeHtml(statusLabel)}</span></td>
      <td>${completed}/5</td>
      <td>${fmt(windowItem.documents)}</td>
      <td>${escapeHtml(missing || "—")}</td>
      <td><button type="button" class="window-run-button" data-window-date="${escapeHtml(windowItem.date)}" ${disabled ? "disabled" : ""}>${windowItem.status === "partial" ? "Retomar" : windowItem.status === "complete" ? "Concluída" : "Executar"}</button></td>
    </tr>`;
  }).join("") || `<tr><td colspan="6" class="muted">Plano ainda não disponível.</td></tr>`;
}

function renderCollector(data) {
  state.collector = data;
  const blocked = Boolean(data.control.blocked);
  const strategyReview = Boolean(data.control.strategy_review_required);
  const running = data.runtime.state === "running";
  const enabled = Boolean(data.control.enabled);
  const runningLabel = data.runtime.mode === "backfill" ? "Executando backfill" : "Coletando D-1";
  const stateLabel = strategyReview ? "Revisão de estratégia exigida" : blocked ? `Bloqueado · HTTP ${data.control.block_status || "?"}` : running ? runningLabel : enabled ? "Ligado · aguardando execução" : "Pausado pelo admin";
  $("#collectorState").textContent = stateLabel;
  $("#navCollectorState").textContent = blocked ? "bloqueado" : running ? "executando" : enabled ? "ligado" : "pausado";
  $("#collectorLight").className = `collector-light ${blocked ? "blocked" : running ? "running" : enabled ? "enabled" : "stopped"}`;
  $("#collectorControlNote").textContent = blocked
    ? `Parada automática em ${fmtMoment(data.control.last_block_at)}. Retome somente após revisar as respostas recentes.`
    : `Próxima execução: ${fmtMoment(data.next_run_at)} · alvo ${(data.runtime.target_date || "D-1")} · cobertura nacional.`;
  $("#enableCollector").textContent = blocked ? "Reconhecer e retomar" : "Ligar / retomar";
  $("#enableCollector").disabled = strategyReview || (enabled && !blocked);
  $("#pauseCollector").disabled = !enabled;
  $("#runCollectorNow").disabled = running || !enabled || blocked;
  const minDelayInput = $("#collectorMinDelay");
  const maxDelayInput = $("#collectorMaxDelay");
  if (document.activeElement !== minDelayInput) minDelayInput.value = data.policy.delay_min_seconds;
  if (document.activeElement !== maxDelayInput) maxDelayInput.value = data.policy.delay_max_seconds;
  $("#saveCollectorPolicy").disabled = running;
  $("#collectorPolicyNote").textContent = `Distribuição uniforme U(${data.policy.delay_min_seconds}, ${data.policy.delay_max_seconds}) segundos · página de 10 · teto anônimo de ${fmt(data.policy.anonymous_window_limit)} documentos por partição.`;
  renderCards($("#collectorCards"), [
    { label: "Requisições", value: fmt(data.summary.requests), note: "ciclo atual" },
    { label: "Documentos", value: fmt(data.summary.documents), note: "D-1 coletado" },
    { label: "Novos", value: fmt(data.summary.new_documents), note: "nesta execução" },
    { label: "Duplicados", value: fmt(data.summary.duplicates), note: "ignorados" },
    { label: "Latência média", value: `${fmt(data.summary.average_latency_ms)} ms`, note: "resposta Falcão" },
    { label: "Bloqueios", value: fmt(data.summary.blocks), note: "403/429" },
  ]);
  $("#collectorPolicy").innerHTML = definitionRows([
    ["Janela", data.policy.mode],
    ["Horário", data.policy.schedule],
    ["Página", `${data.policy.page_size} resultados`],
    ["Intervalo", `${data.policy.delay_min_seconds}–${data.policy.delay_max_seconds}s · uniforme (média ${data.policy.delay_average_seconds}s)`],
    ["Limite", String(data.policy.request_budget)],
    ["Sinal de block", `HTTP ${data.policy.block_statuses.join(" / ")} · parada imediata`],
    ["Erros não bloqueantes", `HTTP ${(data.policy.recoverable_statuses || [400, 408, "5xx"]).join(" / ")} · ${data.policy.non_block_retries ?? 2} novas tentativas e continua`],
    ["Cooldown", `${data.policy.block_cooldown_hours} horas`],
  ]);
  const currentFilters = (data.current?.filters || []).map((item) => `${item.facet}: ${item.name}`).join(" · ") || "nenhum filtro ativo";
  $("#collectorProgress").innerHTML = definitionRows([
    ["Estado", data.runtime.state || "ainda não executado"],
    ["Data-alvo", data.runtime.target_date || "D-1"],
    ["Coleção", data.current?.collection || "—"],
    ["Filtros", currentFilters],
    ["Janelas concluídas", fmt(data.summary.completed_windows)],
    ["Dias completos", `${fmt(data.summary.completed_days)} de ${fmt(data.summary.daily_directories)}`],
    ["Última atualização", fmtMoment(data.status.updated_at || data.runtime.updated_at)],
  ]);
  const statuses = Object.entries(data.http_status_counts || {});
  $("#collectorHttpStatuses").innerHTML = statuses.length
    ? statuses.map(([status, count]) => `<div class="http-status ${["403", "429"].includes(status) ? "block" : ""}"><strong>HTTP ${escapeHtml(status)}</strong><small>${fmt(count)} respostas</small></div>`).join("")
    : `<span class="muted">Nenhuma chamada feita para o ciclo D-1.</span>`;
  $("#collectorHttpMeta").textContent = `${fmt(data.summary.requests)} respostas registradas`;
  $("#collectorRequestMeta").textContent = data.latest_output_dir || "Aguardando primeira execução";
  $("#collectorRequestTable").innerHTML = data.recent_requests.length
    ? data.recent_requests.map((row) => {
        const filters = (row.filters || []).map((item) => item.name).join(" › ");
        const detail = [filters, row.page !== null && row.page !== undefined ? `pág. ${Number(row.page) + 1}` : ""].filter(Boolean).join(" · ");
        return `<tr>
          <td>${escapeHtml(fmtMoment(row.captured_at))}</td>
          <td>${escapeHtml(row.event || "page")}</td>
          <td>${statusBadge(String(row.status || "n/d"))}</td>
          <td>${escapeHtml(row.date || "—")}</td>
          <td>${escapeHtml(row.collection || "—")}</td>
          <td>${escapeHtml(detail || "—")}</td>
          <td>${fmt(row.elapsed_ms)} ms</td>
          <td>${fmt(row.response_bytes)}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="8" class="muted">Nenhuma requisição D-1 registrada ainda.</td></tr>`;
  renderBackfillPlan(data);
  setCollectorTab(state.collectorTab);
}

async function loadCollector() {
  renderCollector(await api("/api/admin/falcao"));
}

async function setCollectorEnabled(enabled) {
  await api("/api/admin/falcao/control", {
    method: "POST",
    body: JSON.stringify({ enabled, acknowledge_block: enabled && Boolean(state.collector?.control?.blocked) }),
  });
  await loadCollector();
}

async function runCollectorNow() {
  await api("/api/admin/falcao/run", { method: "POST", body: "{}" });
  await loadCollector();
}

async function saveCollectorPolicy() {
  const minDelay = Number($("#collectorMinDelay").value);
  const maxDelay = Number($("#collectorMaxDelay").value);
  await api("/api/admin/falcao/policy", {
    method: "POST",
    body: JSON.stringify({ min_delay_seconds: minDelay, max_delay_seconds: maxDelay }),
  });
  $("#collectorPolicyNote").textContent = "Frequência salva.";
  await loadCollector();
}

async function runBackfill(startDate, endDate) {
  await api("/api/admin/falcao/backfill/run", {
    method: "POST",
    body: JSON.stringify({ start_date: startDate, end_date: endDate }),
  });
  $("#backfillRunNote").textContent = `Execução iniciada para ${startDate}${startDate === endDate ? "" : ` a ${endDate}`}.`;
  await loadCollector();
}

function pjeJobStatusLabel(status) {
  return {
    queued: "Na fila",
    operator_requested: "Na fila",
    operator_running: "Executando",
    retry_wait: "Aguardando retry",
    succeeded: "Concluído",
    manual_required: "Manual necessário",
    blocked_by_origin: "Origem bloqueada",
    failed: "Falhou",
    cancelled: "Cancelado",
  }[status] || status || "—";
}

function pjeJobReasonLabel(reason) {
  return {
    user_add: "Usuário adicionou",
    user_watch: "Acompanhamento novo",
    user_recollect: "Recoleta solicitada",
    scheduled_refresh: "Monitoramento",
    retry: "Retry",
    pje_account_login: "Conectar conta",
    pje_account_reconnect: "Reconectar conta",
    pje_account_sync: "Sincronizar conta",
    pje_account_login_before_sync: "Login antes do sync",
  }[reason] || reason || "—";
}

function pjeJobTypeLabel(type) {
  return {
    pje_collect_public_process: "PJe público",
    pje_login_session: "Login PJe",
    pje_sync_account_processes: "Sync conta",
    pje_collect_authenticated_process: "PJe autenticado",
  }[type] || type || "PJe público";
}

function pjeJobActionButtons(job = {}) {
  const status = String(job.status || "");
  const id = escapeHtml(job.id || "");
  const retry = status === "failed" || status === "manual_required" || status === "retry_wait" || status === "blocked_by_origin"
    ? `<button type="button" data-pje-job-action="retry" data-pje-job-id="${id}">Reenfileirar</button>`
    : "";
  const manual = !["succeeded", "manual_required", "cancelled", "blocked_by_origin"].includes(status)
    ? `<button type="button" data-pje-job-action="manual_required" data-pje-job-id="${id}">Marcar manual</button>`
    : "";
  const cancel = !["succeeded", "cancelled"].includes(status)
    ? `<button type="button" class="danger" data-pje-job-action="cancel" data-pje-job-id="${id}">Cancelar</button>`
    : "";
  return [retry, manual, cancel].filter(Boolean).join("");
}

function renderPjeOperator(data) {
  state.pjeOperator = data;
  const summary = data.summary || {};
  const active = Number(summary.active || 0);
  const ready = Number(summary.ready || 0) || Number(summary.queued || 0) + Number(summary.approved || 0);
  const running = Number(summary.running || 0);
  $("#navPjeState").textContent = running ? "executando" : ready ? `${fmt(ready)} fila` : active ? `${fmt(active)} pend.` : "ok";
  $("#pjeOperatorState").textContent = running
    ? "Worker executando coleta"
    : ready
      ? "Jobs aguardando worker"
      : active
        ? "Jobs ativos"
        : "Fila sem pendências";
  $("#pjeOperatorLight").className = `collector-light ${running ? "running" : active ? "enabled" : "stopped"}`;
  $("#pjeOperatorNote").textContent = data.operator?.token_configured
    ? "Token configurado. O worker consome automaticamente os jobs PJe enfileirados."
    : "Configure JUSTRA_PJE_OPERATOR_TOKEN no ambiente do worker para consumir a fila.";
  const command = data.operator?.agent_command || ".venv/bin/python scripts/pje_operator_agent.py --justra-url http://127.0.0.1:8787 --headless";
  $("#pjeAgentCommand").textContent = command;
  $("#pjeOperatorTokenHint").textContent = data.operator?.token_configured
    ? "Em produção/staging, este comando roda como serviço systemd separado do servidor web."
    : "Sem token de operador configurado; o worker aceita um token admin via --token apenas para teste.";
  renderCards($("#pjeOperatorCards"), [
    { label: "Ativos", value: fmt(summary.active), note: "fila + retry + execução" },
    { label: "Na fila", value: fmt(ready), note: "worker pode executar" },
    { label: "Retry", value: fmt(summary.retry_wait), note: "aguardando nova tentativa" },
    { label: "Executando", value: fmt(summary.running), note: "coletor headless" },
    { label: "Concluídos", value: fmt(summary.succeeded), note: "captura aplicada" },
    { label: "Bloqueados", value: fmt(summary.blocked_by_origin), note: "origem/IP rejeitado" },
    { label: "Falhas", value: fmt(Number(summary.failed || 0) + Number(summary.manual_required || 0)), note: "revisão/manual" },
  ]);
  const jobs = data.jobs || [];
  $("#pjeOperatorMeta").textContent = `${fmt(jobs.length)} jobs listados · atualizado ${fmtMoment(data.generated_at)}`;
  $("#pjeOperatorRows").innerHTML = jobs.length
    ? jobs.map((job) => {
        const waiting = job.waiting_user_until ? `<br><span class="muted">SLA usuário: ${escapeHtml(fmtMoment(job.waiting_user_until))}</span>` : "";
        const title = job.case_title ? `<br><span class="muted">${escapeHtml(short(job.case_title, 80))}</span>` : "";
        const locked = job.locked_by ? `<br><span class="muted">${escapeHtml(job.locked_by)} · ${escapeHtml(fmtMoment(job.locked_at))}</span>` : "";
        const account = job.account_id
          ? `<strong>${escapeHtml(pjeJobTypeLabel(job.job_type))}</strong><br><span class="muted">${escapeHtml(job.trt || job.tribunal || "—")} · OAB ${escapeHtml(job.oab || "—")}</span>`
          : "";
        const processSubject = account || `<strong>${escapeHtml(job.process_number || job.process_number_digits || "—")}</strong>${title}<br><span class="muted">${escapeHtml(job.tribunal || "—")} · ${fmt(job.case_count)} caso(s)</span>`;
        return `<tr>
          <td><strong>${fmt(job.priority)}</strong>${waiting}</td>
          <td>${processSubject}</td>
          <td>${escapeHtml(pjeJobReasonLabel(job.reason))}<br><span class="muted">${escapeHtml(pjeJobTypeLabel(job.job_type))}${job.page_url ? ` · ${escapeHtml(short(job.page_url || "", 64))}` : ""}</span></td>
          <td>${statusBadge(pjeJobStatusLabel(job.status))}${locked}</td>
          <td>${fmt(job.attempts)} / ${fmt(job.max_attempts)}</td>
          <td>${escapeHtml(short(job.last_error || "—", 110))}</td>
          <td class="process-center-actions">${pjeJobActionButtons(job)}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="7" class="muted">Nenhum job PJe criado ainda.</td></tr>`;
}

async function loadPjeOperator(options = {}) {
  const silent = Boolean(options.silent);
  if (!silent && $("#pjeOperatorState")) {
    $("#pjeOperatorState").textContent = "Atualizando fila";
  }
  const data = await api("/api/admin/pje");
  renderPjeOperator(data);
  return data;
}

async function runPjeJobAction(jobId, action) {
  await api("/api/admin/pje/jobs/action", {
    method: "POST",
    body: JSON.stringify({ job_id: jobId, action }),
  });
  await loadPjeOperator();
}

async function copyPjeAgentCommand() {
  const command = $("#pjeAgentCommand")?.textContent || "";
  if (!command) return;
  try {
    await navigator.clipboard.writeText(command);
    $("#pjeOperatorNote").textContent = "Comando do agente copiado.";
  } catch {
    $("#pjeOperatorNote").textContent = "Não consegui copiar automaticamente. Selecione o comando e copie manualmente.";
  }
}

function renderDjen(data) {
  state.djen = data;
  const running = data.runtime?.state === "running";
  const extracting = data.runtime?.state === "extracting_deadlines";
  const busy = running || extracting;
  const enabled = Boolean(data.control?.enabled);
  const stateLabel = extracting
    ? "Extraindo prazos"
    : running
    ? data.runtime?.dry_run
      ? "Executando dry-run"
      : data.runtime?.retry_pending
        ? "Retomando pendências"
        : "Coletando diários"
    : enabled
      ? "Ligado · aguardando execução"
      : "Pausado pelo admin";
  $("#djenState").textContent = stateLabel;
  $("#navDjenState").textContent = busy ? "executando" : enabled ? "ligado" : "pausado";
  $("#djenLight").className = `collector-light ${busy ? "running" : enabled ? "enabled" : "stopped"}`;
  $("#djenControlNote").textContent = `Próxima execução: ${fmtMoment(data.next_run_at)} · data alvo ${data.summary?.target_date || "a descobrir no Comunica"} · TST/TRTs.`;
  $("#enableDjen").disabled = enabled;
  $("#pauseDjen").disabled = !enabled;
  $("#runDjenNow").disabled = busy || !enabled;
  $("#retryDjenPending").disabled = busy || !enabled || !Number(data.summary?.pending || 0);
  $("#runDjenDryRun").disabled = busy;
  renderCards($("#djenCards"), [
    { label: "Publicações", value: fmt(data.summary?.publications), note: "normalizadas" },
    { label: "Cadernos", value: `${fmt(data.summary?.processed)} / ${fmt(data.summary?.expected)}`, note: "processados" },
    { label: "Sem comunicação", value: fmt(data.summary?.empty), note: "cadernos vazios" },
    { label: "Pendências", value: fmt(data.summary?.pending), note: "retry/revisão" },
    { label: "Erros", value: fmt(data.summary?.errors), note: "último ciclo" },
    { label: "Tribunais", value: fmt(data.summary?.courts), note: "TST + TRTs" },
  ]);
  $("#djenPolicy").innerHTML = definitionRows([
    ["Horário", `${data.policy?.schedule || "04:00"} ${data.policy?.timezone || "America/Sao_Paulo"}`],
    ["Retry até", data.policy?.retry_until || "08:00"],
    ["Tribunais", data.policy?.courts || "TST + TRT1-TRT24"],
    ["Meios", (data.policy?.mediums || ["D", "E"]).join(" / ")],
    ["Fonte da data", data.policy?.source_date || "dataUltimoEnvio"],
  ]);
  $("#djenProgress").innerHTML = definitionRows([
    ["Estado", data.runtime?.state || "ainda não executado"],
    ["Data alvo", data.summary?.target_date || data.runtime?.target_date || "—"],
    ["Manifesto", data.latest_manifest_path || "—"],
    ["Último início", fmtMoment(data.runtime?.started_at)],
    ["Último fim", fmtMoment(data.runtime?.finished_at)],
    ["Código de saída", data.runtime?.returncode ?? "—"],
    ["Parser prazos", data.runtime?.deadline_parser?.manifest_path ? `${fmt(data.runtime.deadline_parser.deadline_candidates)} prazos` : "—"],
  ]);
  const statuses = Object.entries(data.http_status_counts || {});
  $("#djenHttpStatuses").innerHTML = statuses.length
    ? statuses.map(([status, count]) => `<div class="http-status ${["403", "429"].includes(status) ? "block" : ""}"><strong>HTTP ${escapeHtml(status)}</strong><small>${fmt(count)} respostas</small></div>`).join("")
    : `<span class="muted">Nenhuma chamada registrada ainda.</span>`;
  $("#djenHttpMeta").textContent = `${fmt((data.recent_requests || []).length)} registros recentes`;
  $("#djenCadernoMeta").textContent = `${fmt((data.cadernos || []).length)} cadernos no manifesto`;
  $("#djenCadernoRows").innerHTML = (data.cadernos || []).length
    ? data.cadernos.map((item) => `<tr>
        <td><strong>${escapeHtml(item.court || "—")}</strong></td>
        <td>${escapeHtml(item.medium || "—")}</td>
        <td>${escapeHtml(item.published_date || "—")}</td>
        <td>${statusBadge(item.status || "—")}</td>
        <td>${fmt(item.total)}</td>
        <td>${fmt(item.pages)}</td>
        <td>${item.downloaded ? fmt(item.normalized_count) : "—"}</td>
      </tr>`).join("")
    : `<tr><td colspan="7" class="muted">Nenhum manifesto DJEN disponível ainda.</td></tr>`;
  $("#djenPendingMeta").textContent = `${fmt((data.pending || []).length)} pendências`;
  $("#djenPendingRows").innerHTML = (data.pending || []).length
    ? data.pending.map((item) => `<tr>
        <td><strong>${escapeHtml(item.court_acronym || item.sigla || "—")}</strong></td>
        <td>${escapeHtml(item.medium || item.meio || "—")}</td>
        <td>${escapeHtml(item.published_date || "—")}</td>
        <td>${escapeHtml(item.reason || "pendente")}</td>
      </tr>`).join("")
    : `<tr><td colspan="4" class="muted">Sem pendências no último manifesto.</td></tr>`;
  $("#djenRequestMeta").textContent = data.latest_manifest_path || "Aguardando primeira execução";
  $("#djenRequestRows").innerHTML = (data.recent_requests || []).length
    ? data.recent_requests.map((row) => `<tr>
        <td>${escapeHtml(fmtMoment(row.captured_at))}</td>
        <td>${escapeHtml(row.stage || "—")}</td>
        <td>${statusBadge(String(row.status || "n/d"))}</td>
        <td>${escapeHtml(row.court || "—")}</td>
        <td>${escapeHtml(row.medium || "—")}</td>
        <td>${fmt(row.elapsed_ms)} ms</td>
        <td>${fmt(row.response_bytes)}</td>
      </tr>`).join("")
    : `<tr><td colspan="7" class="muted">Nenhuma requisição registrada ainda.</td></tr>`;
}

function renderDjenLoadError(err) {
  if (err.status === 401) {
    state.token = "";
    localStorage.removeItem("justra_auth_token");
    setAuthVisible(true);
    setAuthMessage("Sessão expirada após reiniciar o app. Entre novamente para carregar a coleta DJEN.");
  }
  $("#djenState").textContent = "Erro ao carregar";
  $("#navDjenState").textContent = "erro";
  $("#djenLight").className = "collector-light stopped";
  $("#djenControlNote").textContent = `Erro ao consultar /api/admin/djen: ${err.message}`;
  $("#djenCards").innerHTML = "";
  $("#djenPolicy").innerHTML = "";
  $("#djenProgress").innerHTML = "";
  $("#djenHttpStatuses").innerHTML = `<span class="muted">Falha ao carregar o monitor DJEN.</span>`;
  $("#djenHttpMeta").textContent = "";
  $("#djenCadernoMeta").textContent = "";
  $("#djenCadernoRows").innerHTML = `<tr><td colspan="7" class="muted">Falha ao carregar os cadernos.</td></tr>`;
  $("#djenPendingMeta").textContent = "";
  $("#djenPendingRows").innerHTML = `<tr><td colspan="4" class="muted">Falha ao carregar as pendências.</td></tr>`;
  $("#djenRequestMeta").textContent = "";
  $("#djenRequestRows").innerHTML = `<tr><td colspan="7" class="muted">Falha ao carregar as requisições.</td></tr>`;
}

async function loadDjen(options = {}) {
  const silent = Boolean(options?.silent);
  if (!silent) {
    $("#djenState").textContent = "Atualizando";
    $("#djenControlNote").textContent = "Consultando /api/admin/djen...";
  }
  try {
    const data = await api("/api/admin/djen");
    renderDjen(data);
    return data;
  } catch (err) {
    renderDjenLoadError(err);
    throw err;
  }
}

async function setDjenEnabled(enabled) {
  await api("/api/admin/djen/control", {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });
  await loadDjen();
}

async function runDjen(options = {}) {
  await api("/api/admin/djen/run", {
    method: "POST",
    body: JSON.stringify(options),
  });
  $("#djenControlNote").textContent = options.dry_run
    ? "Dry-run iniciado."
    : options.retry_pending
      ? "Retomada de pendências iniciada."
      : "Coleta DJEN iniciada.";
  await loadDjen();
}

function updateCategoryBadge(item = {}) {
  const category = String(item.category || "").toLowerCase();
  const kind = category === "action" ? "red" : category === "schedule" || category === "decision" ? "warn" : "";
  return badge(item.category_label || "Informativa", kind);
}

function updateDateLabel(item = {}) {
  if (item.movement_date) {
    const datePart = String(item.movement_date).slice(0, 10);
    const timePart = String(item.movement_date).slice(11, 16);
    return `${formatDataJudDate(datePart) || datePart}${timePart ? ` ${timePart}` : ""}`;
  }
  const publicationDate = formatDataJudDate(item.publication_date);
  if (publicationDate) return publicationDate;
  return item.sent_date || "data não informada";
}

function updateSourceBadge(item = {}) {
  const source = String(item.source_type || "").toLowerCase();
  const label = item.source_label || (source === "datajud" ? "DataJud" : source === "pje" ? "PJe" : "DJEN");
  const kind = source === "djen" ? "warn" : "";
  return badge(label, kind);
}

function updateWatchSourceLabel(source = "") {
  if (source === "case") return "Dossiê";
  if (source === "advogado_datajud") return "Advogado/OAB";
  if (source === "manual") return "Manual";
  return source || "Manual";
}

function compactProcessNumber(value = "") {
  return String(value || "").replace(/\D/g, "");
}

function updateRowTimeValue(item = {}) {
  const raw = item.movement_date || item.publication_date || item.sent_date || "";
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function processCenterFallbackUpdate(rows = []) {
  const rank = { djen: 4, pje: 3, datajud: 2 };
  return (rows || [])
    .filter((row) => updateRowTimeValue(row))
    .sort((a, b) => {
      const sourceOrder = (rank[String(b.source_type || "").toLowerCase()] || 1) - (rank[String(a.source_type || "").toLowerCase()] || 1);
      if (sourceOrder) return sourceOrder;
      return updateRowTimeValue(b) - updateRowTimeValue(a);
    })[0] || {};
}

function datajudRecordForProcess(processNumber, data = state.updates || {}) {
  const wanted = compactProcessNumber(processNumber);
  return (data.datajud?.records || []).find((record) => compactProcessNumber(record.process_number) === wanted) || {};
}

function watchForProcess(processNumber, data = state.updates || {}) {
  const wanted = compactProcessNumber(processNumber);
  return (data.watches || []).find((watch) => compactProcessNumber(watch.process_number) === wanted) || {};
}

function datajudMovementRowsForProcess(processNumber, data = state.updates || {}) {
  const record = datajudRecordForProcess(processNumber, data);
  if (!record || !Array.isArray(record.movements) || !record.movements.length) return [];
  return (record.movements || []).map((movement) => ({
    id: `datajud:${record.process_number}:${movement.id}`,
    source_type: "datajud",
    source_label: "DataJud",
    process_number: record.process_number || processNumber,
    process_number_masked: record.process_number_masked || formatCompactProcessNumber(processNumber),
    movement_date: movement.movement_date || "",
    publication_date: String(movement.movement_date || "").slice(0, 10),
    court_acronym: record.court_acronym || "",
    court_unit: movement.court_unit || record.court_unit || "",
    document_type: movement.movement_name || "",
    class_name: record.class_name || "",
    category: movement.category || "info",
    category_label: movement.category_label || "Informativa",
    risk_level: movement.risk_level || "low",
    risk_label: movement.risk_label || "Baixo",
    title: movement.title || movement.movement_name || "Movimento processual",
    summary: movement.summary || "Movimento registrado no DataJud.",
    excerpt: movement.complements || movement.movement_name || "",
    movement_code: movement.movement_code || "",
  }));
}

function timelineRowsForProcess(processNumber, data = state.updates || {}) {
  const wanted = compactProcessNumber(processNumber);
  const datajudRows = datajudMovementRowsForProcess(wanted, data);
  const djenRows = (data.updates || []).filter((row) => (
    compactProcessNumber(row.process_number) === wanted
    && String(row.source_type || "").toLowerCase() !== "datajud"
  ));
  const seen = new Set();
  return [...datajudRows, ...djenRows]
    .filter((row) => {
      const key = row.id || `${row.source_type}:${row.process_number}:${row.movement_date || row.publication_date}:${row.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => updateRowTimeValue(b) - updateRowTimeValue(a));
}

function processTimelineStatus(watch = {}, record = {}, rows = []) {
  if ((record.status === "error" || record.status === "partial_error" || record.status === "rate_limited") && Number(record.movement_count || 0) > 0) return "DataJud parcial";
  if (record.status === "rate_limited") return "Consulta limitada pelo DataJud";
  if (record.status === "error") return "Consulta DataJud pendente";
  if (record.status === "partial_error") return "Consulta DataJud parcial";
  if (record.status === "not_found") return "Processo não localizado no DataJud";
  if (record.status === "not_configured") return "DataJud sem chave configurada";
  if (!rows.length) return "Sem atos carregados";
  const latest = rows[0] || {};
  if (latest.category === "action") return "Providência possível";
  if (latest.category === "schedule") return "Agenda em destaque";
  if (latest.category === "decision") return "Decisão recente";
  if (latest.category === "distribution") return "Tramitação/remessa";
  if (latest.category === "document") return "Documento juntado";
  return watch.datajud_status === "ok" ? "Em acompanhamento" : "Aguardando atualização";
}

function timelineMetric(label, value, note = "") {
  return `<div class="process-status-metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value || "—"))}</strong>${note ? `<small>${escapeHtml(note)}</small>` : ""}</div>`;
}

function renderProcessTimelinePanel(data = state.updates || {}) {
  const selected = compactProcessNumber(state.updateTimelineProcess);
  if (!selected) return "";
  const watch = watchForProcess(selected, data);
  if (!watch.process_number) return "";
  const record = datajudRecordForProcess(selected, data);
  const rows = timelineRowsForProcess(selected, data);
  const latest = rows[0] || {};
  const actionCount = rows.filter((row) => row.category === "action").length;
  const scheduleCount = rows.filter((row) => row.category === "schedule").length;
  const decisionCount = rows.filter((row) => row.category === "decision").length;
  const djenCount = rows.filter((row) => String(row.source_type || "").toLowerCase() === "djen").length;
  const pjeCount = rows.filter((row) => String(row.source_type || "").toLowerCase() === "pje").length;
  const datajudCount = rows.filter((row) => String(row.source_type || "").toLowerCase() === "datajud").length;
  const status = processTimelineStatus(watch, record, rows);
  const datajudNote = record.error
    ? short(record.error, 140)
    : record.fetched_at
      ? `DataJud ${fmtMoment(record.fetched_at)}`
      : "DataJud aguardando";
  return `
    <section class="process-timeline-panel">
      <header>
        <div>
          <p class="eyebrow">Timeline</p>
          <h3>${escapeHtml(watch.process_number_masked || formatCompactProcessNumber(selected))}</h3>
          <span>${escapeHtml(status)}${latest.id ? ` · último ato em ${escapeHtml(updateDateLabel(latest))}` : ""}</span>
        </div>
        <button type="button" data-close-update-timeline>Fechar</button>
      </header>
      <div class="process-status-strip">
        ${timelineMetric("Atos", fmt(rows.length), `${fmt(pjeCount)} PJe · ${fmt(datajudCount)} DataJud · ${fmt(djenCount)} DJEN`)}
        ${timelineMetric("Ação", fmt(actionCount), "prazos/providências")}
        ${timelineMetric("Agenda", fmt(scheduleCount), "audiências/pautas")}
        ${timelineMetric("Decisões", fmt(decisionCount), "sentenças/acórdãos")}
        ${timelineMetric("Status DataJud", watch.datajud_status || record.status || "pendente", datajudNote)}
      </div>
      <div class="process-timeline">
        ${rows.length ? rows.map((item) => {
          const meta = [
            updateDateLabel(item),
            item.court_acronym || "",
            item.court_unit || "",
            item.movement_code ? `cód. ${item.movement_code}` : "",
          ].filter(Boolean).join(" · ");
          return `<article class="process-timeline-item update-${escapeHtml(item.category || "info")}">
            <div class="process-timeline-marker" aria-hidden="true"></div>
            <div class="process-timeline-body">
              <div class="process-timeline-top">
                <span>${updateSourceBadge(item)}${updateCategoryBadge(item)}</span>
                <time>${escapeHtml(meta || "data não informada")}</time>
              </div>
              <h4>${escapeHtml(item.title || "Movimento processual")}</h4>
              <p>${escapeHtml(item.summary || "Movimento registrado.")}</p>
              ${item.excerpt ? `<details><summary>Trecho</summary><p>${escapeHtml(short(item.excerpt, 700))}</p></details>` : ""}
            </div>
          </article>`;
        }).join("") : `<div class="empty-state">${escapeHtml(record.error || "Nenhuma movimentação carregada para este processo.")}</div>`}
      </div>
    </section>
  `;
}

function renderUpdateList(rows = []) {
  if (!rows.length) {
    return `<div class="empty-state">Nenhuma atualização encontrada para os processos acompanhados neste filtro.</div>`;
  }
  return rows.map((item) => {
    const processNumber = item.process_number_masked || formatCompactProcessNumber(item.process_number);
    const sourceUrl = safeUrl(item.source_url);
    const meta = [
      updateDateLabel(item),
      item.court_acronym || "",
      item.court_unit || "",
      item.document_type || item.communication_type || "",
    ].filter(Boolean).join(" · ");
    return `<article class="update-item update-${escapeHtml(item.category || "info")}">
      <div class="update-item-main">
        <div class="update-item-top">
          <div>${updateSourceBadge(item)}${updateCategoryBadge(item)}<span class="update-risk">${escapeHtml(item.risk_label || "Baixo")}</span></div>
          <small>${escapeHtml(meta)}</small>
        </div>
        <h3>${escapeHtml(item.title || "Publicação no diário")}</h3>
        <p>${escapeHtml(item.summary || "Revisar publicação no PJe quando necessário.")}</p>
        <div class="update-process-line">
          <code>${escapeHtml(processNumber)}</code>
          <span>${escapeHtml(short(item.class_name || "", 90) || "Classe não informada")}</span>
        </div>
        <details>
          <summary>Ver trecho original</summary>
          <p>${escapeHtml(short(item.excerpt || "", 700) || "Trecho não disponível.")}</p>
        </details>
      </div>
      <div class="update-item-actions">
        ${sourceUrl ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer">Abrir fonte</a>` : `<span class="muted">${escapeHtml(item.source_label || "DataJud")}</span>`}
      </div>
    </article>`;
  }).join("");
}

function datajudSummaryLabel(summary = {}) {
  if (!summary.datajud_configured) return "sem chave configurada";
  if (summary.datajud_rate_limited) {
    return summary.datajud_cooldown_until
      ? `pausado até ${fmtMoment(summary.datajud_cooldown_until)}`
      : "pausado por limite";
  }
  return `cache ${fmt(summary.datajud_refresh_hours || 6)}h`;
}

function renderUpdates(data = {}) {
  state.updates = data;
  const summary = data.summary || {};
  const updates = data.updates || [];
  const navUpdateState = $("#navUpdateState");
  if (navUpdateState) {
    navUpdateState.textContent = Number(summary.total_updates || 0)
      ? `${fmt(summary.total_updates)} mov.`
      : `${fmt(summary.watched_processes || 0)} proc.`;
  }
  renderCards($("#updateCards"), [
    { label: "Processos", value: fmt(summary.watched_processes), note: "monitorados" },
    { label: "PJe", value: fmt(summary.pje_updates), note: "capturas da extensão" },
    { label: "Timeline", value: fmt(summary.datajud_updates), note: "movimentos DataJud" },
    { label: "Diário", value: fmt(summary.djen_updates), note: "publicações DJEN" },
    { label: "Exigem ação", value: fmt(summary.action_updates), note: "prioridade alta" },
    { label: "Decisões", value: fmt(summary.decision_updates), note: "sentença/acórdão/despacho" },
  ]);
  const sourceMeta = data.latest_manifest_path
    ? `PJe ${fmt(summary.pje_updates || 0)} · DJEN ${summary.active_date_range || summary.latest_target_date || "sem data"} · DataJud ${datajudSummaryLabel(summary)}${summary.datajud_refreshing ? ` · atualizando ${fmt(summary.datajud_refreshing)}` : ""}`
    : `PJe ${fmt(summary.pje_updates || 0)} · DataJud ${datajudSummaryLabel(summary)}${summary.datajud_refreshing ? ` · atualizando ${fmt(summary.datajud_refreshing)}` : ""}`;
  $("#updateSourceMeta").textContent = sourceMeta;
  const watches = data.watches || [];
  $("#updateWatchMeta").textContent = `${fmt(watches.length)} processos`;
  $("#updateWatchRows").innerHTML = watches.length
    ? watches.map((watch) => {
        const last = watch.last_update || {};
        const hasLast = Boolean(last.id);
        const processNumber = compactProcessNumber(watch.process_number);
        const selected = processNumber && processNumber === compactProcessNumber(state.updateTimelineProcess);
        const datajudStatus = watch.datajud_status === "ok"
          ? `${fmt(watch.datajud_movement_count || 0)} mov.`
          : (watch.datajud_status === "error" || watch.datajud_status === "partial_error" || watch.datajud_status === "rate_limited") && Number(watch.datajud_movement_count || 0) > 0
            ? `${fmt(watch.datajud_movement_count || 0)} mov. (parcial)`
          : watch.datajud_status === "not_found"
            ? "não encontrado"
            : watch.datajud_status === "error"
              ? `erro DataJud${watch.datajud_error ? `: ${short(watch.datajud_error, 90)}` : ""}`
              : watch.datajud_status === "rate_limited"
                ? `limite DataJud${watch.datajud_error ? `: ${short(watch.datajud_error, 90)}` : ""}`
              : watch.datajud_status === "not_configured"
                ? "sem chave"
                : watch.datajud_status === "pending"
                  ? "em fila"
                : "pendente";
        return `<tr class="${selected ? "selected-row" : ""}">
          <td><strong>${escapeHtml(watch.process_number_masked || formatCompactProcessNumber(watch.process_number))}</strong><br><span class="muted">${escapeHtml(watch.title || "")}</span></td>
          <td>${escapeHtml(updateWatchSourceLabel(watch.source))}</td>
          <td>${hasLast ? `${updateSourceBadge(last)} ${updateCategoryBadge(last)}<br><span class="muted">${escapeHtml(updateDateLabel(last))} · ${escapeHtml(short(last.title || "", 70))}</span>` : `<span class="muted">sem movimentação/publicação carregada</span>`}<br><span class="muted">${escapeHtml(datajudStatus)}</span></td>
          <td>${fmt(watch.update_count || 0)}</td>
          <td><button type="button" class="timeline-table-button ${selected ? "active" : ""}" data-update-timeline="${escapeHtml(processNumber)}">Timeline</button></td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="5" class="muted">Nenhum processo acompanhado ainda.</td></tr>`;
  $("#updateTimelinePanel").innerHTML = renderProcessTimelinePanel(data);
}

function renderUpdatesError(err) {
  const navUpdateState = $("#navUpdateState");
  if (navUpdateState) navUpdateState.textContent = "erro";
  $("#updateSourceMeta").textContent = `Erro: ${err.message}`;
  $("#updateWatchStatus").textContent = `Erro: ${err.message}`;
  $("#updateCards").innerHTML = "";
  $("#updateWatchRows").innerHTML = `<tr><td colspan="5" class="muted">Falha ao carregar processos monitorados.</td></tr>`;
  $("#updateTimelinePanel").innerHTML = "";
}

async function loadUpdates(options = {}) {
  const params = new URLSearchParams();
  try {
    const data = await api(`/api/updates${params.toString() ? `?${params}` : ""}`);
    renderUpdates(data);
    return data;
  } catch (err) {
    renderUpdatesError(err);
    throw err;
  }
}

function selectUpdateTimeline(processNumber) {
  state.updateTimelineProcess = compactProcessNumber(processNumber);
  renderUpdates(state.updates || {});
  $("#updateTimelinePanel")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function closeUpdateTimeline() {
  state.updateTimelineProcess = "";
  renderUpdates(state.updates || {});
}

async function addUpdateWatch() {
  const input = $("#updateWatchProcessNumber");
  const processNumber = input.value.trim();
  if (!processNumber) {
    $("#updateWatchStatus").textContent = "Informe o número do processo.";
    return;
  }
  $("#updateWatchStatus").textContent = "Vinculando processo...";
  const data = await api("/api/updates/watch", {
    method: "POST",
    body: JSON.stringify({ process_number: processNumber }),
  });
  input.value = "";
  renderUpdates(data.dashboard || {});
  $("#updateWatchStatus").textContent = "Processo acompanhado. Consulta DataJud enviada em segundo plano.";
  window.setTimeout(() => loadUpdates().catch(() => {}), 5000);
}

async function refreshDatajudUpdates() {
  $("#updateWatchStatus").textContent = "Consultando DataJud para os processos acompanhados...";
  const data = await api("/api/updates/datajud/refresh", {
    method: "POST",
    body: JSON.stringify({ force: true }),
  });
  renderUpdates(data || {});
  const summary = data.summary || {};
  const active = Number(summary.datajud_queued || 0) + Number(summary.datajud_refreshing || 0);
  $("#updateWatchStatus").textContent = summary.datajud_rate_limited
    ? `DataJud em pausa por limite${summary.datajud_cooldown_until ? ` até ${fmtMoment(summary.datajud_cooldown_until)}` : ""}. Cache mantido.`
    : active
      ? `Consulta DataJud enviada. ${fmt(active)} processos em fila/atualização.`
      : "Timeline DataJud atualizada pelo cache disponível.";
  if (active) window.setTimeout(() => loadUpdates().catch(() => {}), 5000);
}

async function searchMovementLawyer() {
  const lawyerName = $("#movementLawyerName").value.trim();
  const oab = $("#movementLawyerOab").value.trim();
  const uf = $("#movementLawyerUf").value.trim();
  if (!lawyerName && !oab) {
    $("#movementLawyerStatus").textContent = "Informe nome ou OAB.";
    return;
  }
  $("#movementLawyerStatus").textContent = "Buscando no DataJud e vinculando processos...";
  const data = await api("/api/updates/datajud/lawyer", {
    method: "POST",
    body: JSON.stringify({ name: lawyerName, oab, uf }),
  });
  renderUpdates(data.dashboard || {});
  if (data.cooldown_until) {
    $("#movementLawyerStatus").textContent = `DataJud em pausa por limite até ${fmtMoment(data.cooldown_until)}. Cache mantido.`;
    return;
  }
  const errors = data.errors?.length ? ` · ${fmt(data.errors.length)} tribunais sem resposta` : "";
  $("#movementLawyerStatus").textContent = `${fmt(data.found?.length || 0)} processos encontrados e acompanhados${errors}.`;
  window.setTimeout(() => loadUpdates().catch(() => {}), 5000);
}

function prettyDeadlineToken(value) {
  const raw = text(value, "").replaceAll("_", " ").trim();
  if (!raw) return "Ato processual";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function deadlineRiskBadge(item = {}) {
  const level = String(item.risk_level || "").toLowerCase();
  const kind = level === "critical" ? "red" : level === "high" ? "warn" : "";
  return badge(item.risk_label || "Revisar", kind);
}

function deadlinePeople(rows = [], fallback = "—") {
  const names = rows.map((item) => item?.name).filter(Boolean);
  if (!names.length) return fallback;
  const visible = names.slice(0, 2).join(", ");
  return names.length > 2 ? `${visible} +${names.length - 2}` : visible;
}

function deadlineAttorneyText(item = {}) {
  const attorneys = item.attorneys || [];
  if (!attorneys.length) return "—";
  return attorneys
    .slice(0, 2)
    .map((attorney) => {
      const oab = [attorney.oab, attorney.uf].filter(Boolean).join("/");
      return [attorney.name || "Advogado", oab ? `OAB ${oab}` : ""].filter(Boolean).join(" · ");
    })
    .join("; ");
}

function deadlineDateCell(item = {}) {
  const dateValue = item.kind === "calendar" ? item.event_date : item.due_date;
  const timeValue = item.kind === "calendar" && item.event_time ? ` ${item.event_time}` : "";
  return `<strong>${escapeHtml(formatDataJudDate(dateValue) || "Revisar")}${escapeHtml(timeValue)}</strong><br><span class="muted">${escapeHtml(item.due_label || "revisar no PJe")}</span>`;
}

function deadlineActionLabel(item = {}) {
  if (item.kind === "calendar") return prettyDeadlineToken(item.event_type || "Evento");
  return prettyDeadlineToken(item.deadline_kind || item.trigger_type || item.document_type || "Manifestacao");
}

function renderDeadlineRows(rows = []) {
  return rows.length
    ? rows.map((item) => `<tr>
        <td>${deadlineDateCell(item)}</td>
        <td><strong>${escapeHtml(item.process_number_masked || formatCompactProcessNumber(item.process_number))}</strong></td>
        <td>${escapeHtml(item.court_acronym || "—")}<br><span class="muted">${escapeHtml(short(item.court_unit || "", 46))}</span></td>
        <td>${escapeHtml(deadlinePeople(item.intimated_parties || []))}</td>
        <td>${escapeHtml(deadlineActionLabel(item))}</td>
        <td>${deadlineRiskBadge(item)}</td>
        <td>${escapeHtml(short(item.evidence_excerpt || "", 160) || "—")}</td>
      </tr>`).join("")
    : `<tr><td colspan="7" class="muted">Nenhum prazo ativo encontrado para os processos acompanhados.</td></tr>`;
}

function renderCalendarRows(rows = []) {
  return rows.length
    ? rows.map((item) => `<tr>
        <td>${deadlineDateCell(item)}</td>
        <td><strong>${escapeHtml(item.process_number_masked || formatCompactProcessNumber(item.process_number))}</strong></td>
        <td>${escapeHtml(item.court_acronym || "—")}<br><span class="muted">${escapeHtml(short(item.court_unit || "", 46))}</span></td>
        <td>${escapeHtml(deadlineActionLabel(item))}</td>
        <td>${escapeHtml(deadlinePeople(item.intimated_parties || []))}</td>
        <td>${deadlineRiskBadge(item)}</td>
      </tr>`).join("")
    : `<tr><td colspan="6" class="muted">Nenhuma audiência ou pauta encontrada para os processos acompanhados.</td></tr>`;
}

function renderLawyerDeadlineRows(data = {}) {
  const rows = data.lawyer_results || [];
  const search = data.lawyer_search || {};
  $("#lawyerDeadlineMeta").textContent = search.searched
    ? `${fmt(rows.length)} resultados${search.truncated ? " · exibindo os primeiros 500" : ""}`
    : "Aguardando pesquisa.";
  $("#lawyerDeadlineRows").innerHTML = search.searched
    ? rows.length
      ? rows.map((item) => `<tr>
          <td>${deadlineDateCell(item)}</td>
          <td><strong>${escapeHtml(item.process_number_masked || formatCompactProcessNumber(item.process_number))}</strong></td>
          <td>${escapeHtml(deadlineAttorneyText(item))}</td>
          <td>${escapeHtml(item.court_acronym || "—")}<br><span class="muted">${escapeHtml(short(item.court_unit || "", 46))}</span></td>
          <td>${escapeHtml(deadlineActionLabel(item))}</td>
          <td>${deadlineRiskBadge(item)}</td>
        </tr>`).join("")
      : `<tr><td colspan="6" class="muted">Nenhum prazo ativo encontrado para esse nome/OAB.</td></tr>`
    : `<tr><td colspan="6" class="muted">Pesquise por nome e, se possível, OAB/UF.</td></tr>`;
}

function renderDeadlines(data = {}) {
  state.deadlines = data;
  const summary = data.summary || {};
  const navDeadlineState = $("#navDeadlineState");
  if (navDeadlineState) {
    navDeadlineState.textContent = Number(summary.watched_deadlines || 0)
      ? `${fmt(summary.watched_deadlines)} prazos`
      : `${fmt(summary.watched_processes || 0)} proc.`;
  }
  renderCards($("#deadlineCards"), [
    { label: "Processos", value: fmt(summary.watched_processes), note: "acompanhados" },
    { label: "Prazos", value: fmt(summary.watched_deadlines), note: "nos processos" },
    { label: "Críticos", value: fmt(summary.critical_deadlines), note: "risco imediato" },
    { label: "Altos", value: fmt(summary.high_deadlines), note: "atenção" },
    { label: "Audiências/pautas", value: fmt(summary.watched_calendar_events), note: "datas do diário" },
    { label: "Janela ativa", value: `${fmt(summary.active_manifest_count || 0)} diários`, note: summary.active_date_range || summary.latest_target_date || "sem data" },
  ]);
  const summaries = data.process_deadline_summaries || {};
  const watches = data.watches || [];
  $("#deadlineWatchStatus").textContent = data.latest_manifest_path
    ? `Janela ativa: ${summary.active_date_range || summary.latest_target_date || "sem data"} · ${fmt(summary.active_manifest_count || 0)} diários · ${fmt(summary.active_window_days || 30)} dias`
    : "Nenhum índice de prazos processado ainda.";
  $("#deadlineWatchMeta").textContent = `${fmt(watches.length)} processos`;
  $("#deadlineWatchRows").innerHTML = watches.length
    ? watches.map((watch) => {
        const item = summaries[watch.process_number] || {};
        const hasTrackedDate = item.has_deadline || item.has_calendar_event;
        const nextLabel = item.has_deadline
          ? item.due_label || "revisar no PJe"
          : item.has_calendar_event
            ? item.calendar_label || "evento no diário"
            : "";
        return `<tr>
          <td><strong>${escapeHtml(watch.process_number_masked || formatCompactProcessNumber(watch.process_number))}</strong><br><span class="muted">${escapeHtml(watch.title || "")}</span></td>
          <td>${escapeHtml(watch.source === "case" ? "Dossiê" : "Manual")}</td>
          <td>${hasTrackedDate ? escapeHtml(nextLabel) : `<span class="muted">sem prazo/data ativa</span>`}</td>
          <td>${hasTrackedDate ? deadlineRiskBadge(item) : `<span class="muted">—</span>`}</td>
          <td>${fmt(item.count || 0)} / ${fmt(item.calendar_count || 0)}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="5" class="muted">Nenhum processo acompanhado ainda.</td></tr>`;
  $("#deadlineRowsMeta").textContent = `${fmt((data.watched_deadlines || []).length)} prazos`;
  $("#deadlineRows").innerHTML = renderDeadlineRows(data.watched_deadlines || []);
  $("#deadlineCalendarMeta").textContent = `${fmt((data.watched_calendar_events || []).length)} datas`;
  $("#deadlineCalendarRows").innerHTML = renderCalendarRows(data.watched_calendar_events || []);
  renderLawyerDeadlineRows(data);
}

function renderDeadlinesError(err) {
  const navDeadlineState = $("#navDeadlineState");
  if (navDeadlineState) navDeadlineState.textContent = "erro";
  $("#deadlineWatchStatus").textContent = `Erro: ${err.message}`;
  $("#deadlineCards").innerHTML = "";
  $("#deadlineWatchRows").innerHTML = `<tr><td colspan="5" class="muted">Falha ao carregar processos acompanhados.</td></tr>`;
  $("#deadlineRows").innerHTML = `<tr><td colspan="7" class="muted">Falha ao carregar prazos.</td></tr>`;
  $("#deadlineCalendarRows").innerHTML = `<tr><td colspan="6" class="muted">Falha ao carregar datas.</td></tr>`;
}

async function loadDeadlines(options = {}) {
  const params = new URLSearchParams();
  if (options.lawyerName) params.set("lawyer_name", options.lawyerName);
  if (options.oab) params.set("oab", options.oab);
  if (options.uf) params.set("uf", options.uf);
  try {
    const data = await api(`/api/deadlines${params.toString() ? `?${params}` : ""}`);
    renderDeadlines(data);
    return data;
  } catch (err) {
    renderDeadlinesError(err);
    throw err;
  }
}

async function addDeadlineWatch() {
  const input = $("#deadlineWatchProcessNumber");
  const processNumber = input.value.trim();
  if (!processNumber) {
    $("#deadlineWatchStatus").textContent = "Informe o número do processo.";
    return;
  }
  $("#deadlineWatchStatus").textContent = "Vinculando processo...";
  const data = await api("/api/deadlines/watch", {
    method: "POST",
    body: JSON.stringify({ process_number: processNumber }),
  });
  input.value = "";
  renderDeadlines(data.dashboard || {});
  $("#deadlineWatchStatus").textContent = "Processo acompanhado.";
}

function processCenterCaseByProcess(cases = state.cases || []) {
  const rows = new Map();
  cases.forEach((item) => {
    const key = compactProcessNumber(item.process_number);
    if (key && !rows.has(key)) rows.set(key, item);
  });
  return rows;
}

function processCenterCaseById(cases = state.cases || []) {
  return new Map((cases || []).filter((item) => item.id).map((item) => [item.id, item]));
}

function processCenterAllWatches(cases = [], updates = {}, deadlines = {}) {
  const rows = new Map();
  const add = (watch = {}) => {
    const key = compactProcessNumber(watch.process_number);
    if (!key) return;
    rows.set(key, { ...(rows.get(key) || {}), ...watch, process_number: key });
  };
  (deadlines.watches || []).forEach(add);
  (updates.watches || []).forEach(add);
  cases.forEach((item) => {
    const key = compactProcessNumber(item.process_number);
    if (!key) return;
    add({
      process_number: key,
      process_number_masked: item.process_number || formatCompactProcessNumber(key),
      title: item.title,
      source: "case",
      case_id: item.id,
    });
  });
  return Array.from(rows.values());
}

function processCenterTrackedItems(processNumber, deadlines = state.deadlines || {}) {
  const key = compactProcessNumber(processNumber);
  return [...(deadlines.watched_deadlines || []), ...(deadlines.watched_calendar_events || [])]
    .filter((item) => compactProcessNumber(item.process_number) === key)
    .sort((a, b) => {
      const aDate = a.kind === "calendar" ? a.event_date : a.due_date;
      const bDate = b.kind === "calendar" ? b.event_date : b.due_date;
      return String(aDate || "9999-12-31").localeCompare(String(bDate || "9999-12-31"));
    });
}

function processCenterNextTrackedItem(processNumber, deadlines = state.deadlines || {}) {
  return processCenterTrackedItems(processNumber, deadlines)[0] || null;
}

function processCenterDateCell(item = null, summary = {}, fallbackUpdate = {}) {
  if (item) return deadlineDateCell(item);
  const dateValue = summary.next_due_date || summary.next_calendar_date || "";
  const label = summary.due_label || summary.calendar_label || "";
  if (!dateValue) {
    const updateLabel = updateDateLabel(fallbackUpdate);
    if (fallbackUpdate?.id && updateLabel && updateLabel !== "data não informada") {
      const source = fallbackUpdate.source_label || (fallbackUpdate.source_type === "pje" ? "PJe" : fallbackUpdate.source_type === "datajud" ? "DataJud" : "DJEN");
      const detail = fallbackUpdate.category_label || fallbackUpdate.document_type || fallbackUpdate.communication_type || "movimentação";
      return `<strong>${escapeHtml(updateLabel)}</strong><br><span class="muted">${escapeHtml(`${source} · ${detail}`)}</span>`;
    }
    return `<span class="muted">sem prazo/data ativa</span>`;
  }
  return `<strong>${escapeHtml(formatDataJudDate(dateValue))}</strong><br><span class="muted">${escapeHtml(label || "revisar no PJe")}</span>`;
}

function processCenterRiskCell(item = null, summary = {}, latest = {}) {
  if (item) return deadlineRiskBadge(item);
  if (summary.risk_label) return badge(summary.risk_label, summary.risk_level === "critical" ? "red" : summary.risk_level === "high" ? "warn" : "");
  if (latest.risk_label) return badge(latest.risk_label, latest.risk_level === "high" || latest.risk_level === "medium" ? "warn" : "");
  return `<span class="muted">—</span>`;
}

function pjeCollectionUrl(caseItem = {}) {
  return officialProcessUrl(caseItem.process_source_url || caseItem.pje_import?.source_url || "")
    || officialPjeUrlForProcessNumber(caseItem.process_number || "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPjeAssistedJob(caseItem = {}, statusSelector = "#processCenterStatus") {
  const jobId = caseItem.pje_import?.job_id || "";
  const statusEl = $(statusSelector);
  if (!jobId) return false;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await sleep(3000);
    const data = await api(`/api/pje/jobs/${encodeURIComponent(jobId)}`);
    const job = data.job || {};
    const status = String(job.status || "");
    if (statusEl) {
      statusEl.textContent = status === "operator_running"
        ? "Worker PJe coletando agora. Aguarde mais um instante..."
        : status === "retry_wait"
          ? "Coleta PJe falhou e ficou agendada para retry automático."
          : status === "blocked_by_origin"
            ? "O PJe bloqueou a origem do worker automático. Use a coleta manual/extensão por enquanto."
          : "Coleta PJe na fila automática. Você pode acompanhar em PJe operador.";
    }
    if (status === "succeeded") return true;
    if (["manual_required", "failed", "cancelled", "blocked_by_origin"].includes(status)) return false;
  }
  return false;
}

function casePjeCollectionPending(caseItem = {}) {
  const importState = caseItem.pje_import || {};
  const hasPjeLink = Boolean(pjeCollectionUrl(caseItem));
  const captured = Number(importState.captured_document_count || importState.document_count || 0);
  const status = String(importState.status || "").toLowerCase();
  return hasPjeLink && !captured && !["imported_by_extension", "imported_from_user_page_text"].includes(status);
}

function processCenterLatestCell(latest = {}, watch = {}, caseItem = {}) {
  const pjePending = casePjeCollectionPending(caseItem);
  if (latest.id) {
    const pendingNote = pjePending ? `<br><span class="muted">PJe pendente: envie pela extensão.</span>` : "";
    return `${updateSourceBadge(latest)} ${updateCategoryBadge(latest)}<br><span class="muted">${escapeHtml(updateDateLabel(latest))} · ${escapeHtml(short(latest.title || latest.summary || "", 86))}</span>${pendingNote}`;
  }
  if (pjePending) {
    const label = caseItem.pje_import?.status_label || "Coleta PJe pendente";
    return `<span class="pje-collection-reminder">${escapeHtml(label)}</span><br><span class="muted">Abra o PJe, resolva o CAPTCHA e envie pela extensão.</span>`;
  }
  const datajudStatus = watch.datajud_status || "";
  if (datajudStatus === "pending") return `<span class="muted">DataJud em fila</span>`;
  if (datajudStatus === "not_found") return `<span class="muted">não localizado no DataJud</span>`;
  if (datajudStatus === "not_configured") return `<span class="muted">DataJud sem chave configurada</span>`;
  return `<span class="muted">sem novidade carregada</span>`;
}

function calendarDateRangeForGoogle(item = null, fallbackDate = "") {
  const dateValue = item?.kind === "calendar" ? item.event_date : item?.due_date || fallbackDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateValue || ""))) return "";
  const compact = String(dateValue).replaceAll("-", "");
  if (item?.kind === "calendar" && /^\d{2}:\d{2}$/.test(String(item.event_time || ""))) {
    const start = new Date(`${dateValue}T${item.event_time}:00`);
    const endDate = new Date(start.getTime() + 60 * 60 * 1000);
    const encodeLocal = (date) => (
      `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}00`
    );
    return `${encodeLocal(start)}/${encodeLocal(endDate)}`;
  }
  const next = new Date(`${dateValue}T00:00:00`);
  next.setDate(next.getDate() + 1);
  const end = `${next.getFullYear()}${String(next.getMonth() + 1).padStart(2, "0")}${String(next.getDate()).padStart(2, "0")}`;
  return `${compact}/${end}`;
}

function googleCalendarUrlForProcess({ processNumber, item = null, summary = {}, caseItem = {} }) {
  const fallbackDate = summary.next_due_date || summary.next_calendar_date || "";
  const dates = calendarDateRangeForGoogle(item, fallbackDate);
  if (!dates) return "";
  const processLabel = formatCompactProcessNumber(processNumber) || processNumber;
  const action = item ? deadlineActionLabel(item) : summary.calendar_type || "Prazo processual";
  const title = `${processLabel} · ${action}`;
  const details = [
    caseItem.title || "",
    `Processo: ${processLabel}`,
    `Tipo: ${action}`,
    `Data limite: ${formatDataJudDate(item?.due_date || item?.event_date || fallbackDate)}`,
    item?.court_acronym ? `Tribunal: ${item.court_acronym}${item.court_unit ? ` · ${item.court_unit}` : ""}` : "",
    item?.intimated_parties?.length ? `Parte intimada: ${deadlinePeople(item.intimated_parties)}` : "",
  ].filter(Boolean).join("\n");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: title,
    dates,
    details,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function processCenterRowSortValue(row = {}) {
  const item = row.nextTrackedItem;
  const summary = row.summary || {};
  return item?.due_date || item?.event_date || summary.next_due_date || summary.next_calendar_date || "9999-12-31";
}

function renderProcessCenter(data = state.processCenter || {}) {
  const cases = data.cases || state.cases || [];
  const updates = data.updates || state.updates || {};
  const deadlines = data.deadlines || state.deadlines || {};
  const byProcess = processCenterCaseByProcess(cases);
  const byId = processCenterCaseById(cases);
  const summaries = deadlines.process_deadline_summaries || {};
  const rows = processCenterAllWatches(cases, updates, deadlines)
    .map((watch) => {
      const processNumber = compactProcessNumber(watch.process_number);
      const caseItem = byProcess.get(processNumber) || byId.get(watch.case_id) || {};
      const timelineRows = timelineRowsForProcess(processNumber, updates);
      const latest = watch.last_update || timelineRows[0] || {};
      const fallbackUpdate = processCenterFallbackUpdate(timelineRows) || latest;
      return {
        watch,
        processNumber,
        caseItem,
        latest,
        fallbackUpdate,
        summary: summaries[processNumber] || {},
        nextTrackedItem: processCenterNextTrackedItem(processNumber, deadlines),
      };
    })
    .sort((a, b) => {
      const dateOrder = processCenterRowSortValue(a).localeCompare(processCenterRowSortValue(b));
      if (dateOrder) return dateOrder;
      return updateRowTimeValue(b.latest) - updateRowTimeValue(a.latest);
    });
  const newCases = cases.filter((item) => !compactProcessNumber(item.process_number));
  const activeDate = deadlines.summary?.active_date_range || updates.summary?.active_date_range || "";
  $("#processCenterMeta").textContent = `${fmt(rows.length)} processos${activeDate ? ` · janela ${activeDate}` : ""}`;
  $("#processCenterRows").innerHTML = rows.length
    ? rows.map(({ watch, processNumber, caseItem, latest, fallbackUpdate, summary, nextTrackedItem }) => {
        const selected = processNumber === compactProcessNumber(state.updateTimelineProcess);
        const processLabel = watch.process_number_masked || caseItem.process_number || formatCompactProcessNumber(processNumber);
        const title = caseItem.title || watch.title || `Processo ${processLabel}`;
        const parties = [caseItem.claimant_name, caseItem.defendant_name].filter(Boolean).join(" × ");
        const court = [
          nextTrackedItem?.court_acronym || latest.court_acronym || "",
          short(nextTrackedItem?.court_unit || latest.court_unit || "", 36),
        ].filter(Boolean).map(escapeHtml).join("<br>");
        const type = nextTrackedItem ? deadlineActionLabel(nextTrackedItem) : latest.category_label || latest.document_type || "Acompanhamento";
        const people = nextTrackedItem ? deadlinePeople(nextTrackedItem.intimated_parties || [], "—") : parties || "—";
        const calendarUrl = googleCalendarUrlForProcess({ processNumber, item: nextTrackedItem, summary, caseItem });
        const openAction = caseItem.id
          ? `<button type="button" data-center-open-case="${escapeHtml(caseItem.id)}">Abrir</button>`
          : `<button type="button" data-center-create-case="${escapeHtml(processNumber)}">Criar dossiê</button>`;
        const removeAction = caseItem.id
          ? `<button type="button" class="danger" data-center-delete-case="${escapeHtml(caseItem.id)}">Remover</button>`
          : `<button type="button" class="danger" data-center-remove-watch="${escapeHtml(processNumber)}">Remover</button>`;
        const pjeUrl = pjeCollectionUrl(caseItem);
        const pjeAction = caseItem.id && pjeUrl
          ? `<button type="button" data-center-recollect-pje="${escapeHtml(caseItem.id)}">${casePjeCollectionPending(caseItem) ? "Coletar PJe" : "Recoletar PJe"}</button>`
          : "";
        return `<tr class="${selected ? "selected-row" : ""}">
          <td><strong>${escapeHtml(processLabel)}</strong><br><span class="muted">${escapeHtml(short(title, 70))}</span></td>
          <td>${processCenterDateCell(nextTrackedItem, summary, fallbackUpdate || latest)}</td>
          <td>${court || `<span class="muted">—</span>`}</td>
          <td>${escapeHtml(short(type, 54))}</td>
          <td>${escapeHtml(short(people, 90))}</td>
          <td>${processCenterLatestCell(latest, watch, caseItem)}</td>
          <td>${processCenterRiskCell(nextTrackedItem, summary, latest)}</td>
          <td class="process-center-actions">
            ${openAction}
            <button type="button" class="${selected ? "active" : ""}" data-process-center-timeline="${escapeHtml(processNumber)}">Timeline</button>
            ${pjeAction}
            <button type="button" ${calendarUrl ? `data-google-calendar="${escapeHtml(calendarUrl)}"` : "disabled"}>Google</button>
            ${removeAction}
          </td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="8" class="muted">Nenhum processo acompanhado ainda.</td></tr>`;
  $("#processCenterTimelinePanel").innerHTML = renderProcessTimelinePanel(updates);
  $("#processCenterNewCaseRows").innerHTML = newCases.length
    ? newCases.map((item) => `<tr>
        <td><strong>${escapeHtml(item.title)}</strong><br><span class="muted">${escapeHtml(item.case_type_label || "Dossiê")}</span></td>
        <td>${escapeHtml(item.stage || item.status || "Organização inicial")}</td>
        <td>${escapeHtml(fmtMoment(item.updated_at))}</td>
        <td>${fmt(item.document_count)} docs · ${fmt(item.claim_count)} pedidos · ${fmt(item.piece_count)} peças</td>
        <td class="process-center-actions"><button type="button" data-center-open-case="${escapeHtml(item.id)}">Abrir</button><button type="button" class="danger" data-center-delete-case="${escapeHtml(item.id)}">Remover</button></td>
      </tr>`).join("")
    : `<tr><td colspan="5" class="muted">Nenhum caso pré-processual em andamento.</td></tr>`;
}

function renderProcessCenterError(err) {
  if ($("#processCenterMeta")) $("#processCenterMeta").textContent = `Erro: ${err.message}`;
  if ($("#processCenterStatus")) $("#processCenterStatus").textContent = `Erro ao carregar: ${err.message}`;
  if ($("#processCenterRows")) $("#processCenterRows").innerHTML = `<tr><td colspan="8" class="muted">Falha ao carregar processos acompanhados.</td></tr>`;
  if ($("#processCenterNewCaseRows")) $("#processCenterNewCaseRows").innerHTML = `<tr><td colspan="5" class="muted">Falha ao carregar novos casos.</td></tr>`;
}

function pjeAccountStatusLabel(status) {
  return {
    login_required: "Reconectar PJe",
    login_queued: "Login na fila",
    sync_queued: "Sync na fila",
    ready: "Sessão ativa",
    manual_bridge_required: "Ponte interativa pendente",
    error: "Erro",
  }[status] || status || "Sem sessão";
}

function renderPjeAccounts(data = state.pjeAccounts || {}) {
  state.pjeAccounts = data;
  const accounts = data.accounts || [];
  if ($("#pjeAccountMeta")) {
    $("#pjeAccountMeta").textContent = `${fmt(accounts.length)} conexão(ões) · atualizado ${fmtMoment(data.generated_at)}`;
  }
  if (!$("#pjeAccountRows")) return;
  $("#pjeAccountRows").innerHTML = accounts.length
    ? accounts.map((account) => {
        const id = escapeHtml(account.id || "");
        const lastLogin = account.last_login_at ? `Login ${fmtMoment(account.last_login_at)}` : "Sem login";
        const lastSync = account.last_sync_at ? `Sync ${fmtMoment(account.last_sync_at)}` : "Sem sync";
        const error = account.last_error ? `<br><span class="muted">${escapeHtml(short(account.last_error, 120))}</span>` : "";
        return `<article class="pje-account-item">
          <div>
            <strong>${escapeHtml(account.trt || "TRT")} · OAB ${escapeHtml(account.oab || "—")}${account.uf ? `/${escapeHtml(account.uf)}` : ""}</strong>
            <span>${escapeHtml(lastLogin)} · ${escapeHtml(lastSync)}${error}</span>
          </div>
          <div>
            ${statusBadge(pjeAccountStatusLabel(account.session_status))}
            <button type="button" data-pje-account-login="${id}">Reconectar</button>
            <button type="button" data-pje-account-sync="${id}">Sincronizar</button>
          </div>
        </article>`;
      }).join("")
    : `<div class="empty-state">Nenhuma conexão PJe cadastrada.</div>`;
}

async function loadPjeAccounts() {
  const data = await api("/api/pje/accounts");
  renderPjeAccounts(data);
  return data;
}

async function createPjeAccount() {
  const trt = $("#pjeAccountTrt")?.value || "TRT2";
  const oab = ($("#pjeAccountOab")?.value || "").trim();
  const uf = ($("#pjeAccountUf")?.value || "").trim().toUpperCase();
  if (!oab) {
    $("#pjeAccountStatus").textContent = "Informe a OAB.";
    return;
  }
  $("#pjeAccountStatus").textContent = "Criando conexão PJe e enfileirando login assistido...";
  const data = await api("/api/pje/accounts", {
    method: "POST",
    body: JSON.stringify({ trt, oab, uf }),
  });
  renderPjeAccounts(data);
  $("#pjeAccountStatus").textContent = "Conexão PJe criada. A fila do operador recebeu o job de login.";
}

async function runPjeAccountAction(accountId, action) {
  const path = action === "sync" ? "/api/pje/accounts/sync" : "/api/pje/accounts/login";
  $("#pjeAccountStatus").textContent = action === "sync" ? "Sincronização PJe enfileirada..." : "Reconexão PJe enfileirada...";
  const data = await api(path, {
    method: "POST",
    body: JSON.stringify({ account_id: accountId }),
  });
  renderPjeAccounts(data);
  $("#pjeAccountStatus").textContent = action === "sync" ? "Job de sincronização enviado para a fila." : "Job de login enviado para a fila.";
}

function renderPjeExtensionInstall(config = state.pjeExtension || {}) {
  const button = $("#installPjeExtension");
  if (!button) return;
  const available = Boolean(config.available && config.install_url);
  button.disabled = !available;
  button.textContent = available ? "Instalar extensão PJe" : "Extensão PJe pendente";
  button.title = available
    ? "Abrir a página oficial da extensão na Chrome Web Store"
    : "Para instalar sem modo dev, publique a extensão na Chrome Web Store e configure JUSTRA_PJE_EXTENSION_URL.";
}

async function loadPjeExtensionInstall() {
  try {
    state.pjeExtension = await api("/api/extension/pje");
  } catch {
    state.pjeExtension = { available: false, status_label: "Extensão indisponível" };
  }
  renderPjeExtensionInstall(state.pjeExtension);
  return state.pjeExtension;
}

async function loadProcessCenter(options = {}) {
  if ($("#processCenterStatus")) $("#processCenterStatus").textContent = options.refreshDatajud ? "Atualizando DataJud e montando a central..." : "Carregando processos...";
  loadPjeExtensionInstall().catch(() => {});
  loadPjeAccounts().catch((err) => {
    if ($("#pjeAccountMeta")) $("#pjeAccountMeta").textContent = `Erro: ${err.message}`;
  });
  const casesData = await api("/api/cases?q=");
  state.cases = casesData.cases || [];
  state.deadlines = {};
  state.updates = {};
  state.processCenter = { cases: state.cases, deadlines: state.deadlines, updates: state.updates };
  renderProcessCenter(state.processCenter);
  if ($("#processCenterStatus")) {
    $("#processCenterStatus").textContent = options.refreshDatajud
      ? "Processos carregados. Atualizando prazos e DataJud..."
      : "Processos carregados. Buscando prazos e movimentações...";
  }
  const updatesPromise = options.refreshDatajud
    ? api("/api/updates/datajud/refresh", { method: "POST", body: JSON.stringify({ force: true }) })
    : api("/api/updates");
  let deadlinesData = {};
  let updatesData = {};
  try {
    [deadlinesData, updatesData] = await Promise.all([
      api("/api/deadlines"),
      updatesPromise,
    ]);
  } catch (err) {
    if ($("#processCenterStatus")) $("#processCenterStatus").textContent = `Processos carregados; falha ao atualizar prazos/movimentações: ${err.message}`;
    return state.processCenter;
  }
  state.deadlines = deadlinesData || {};
  state.updates = updatesData || {};
  state.processCenter = { cases: state.cases, deadlines: state.deadlines, updates: state.updates };
  renderProcessCenter(state.processCenter);
  const summary = state.updates.summary || {};
  const queued = Number(state.updates.summary?.datajud_queued || 0) + Number(state.updates.summary?.datajud_refreshing || 0);
  if ($("#processCenterStatus")) {
    $("#processCenterStatus").textContent = summary.datajud_rate_limited
      ? `Acompanhamento carregado. DataJud em pausa por limite${summary.datajud_cooldown_until ? ` até ${fmtMoment(summary.datajud_cooldown_until)}` : ""}.`
      : queued
        ? `Acompanhamento ativo. ${fmt(queued)} consulta(s) DataJud em fila/atualização.`
        : "Acompanhamento carregado.";
  }
  return state.processCenter;
}

async function ensureProcessCenterCase(processNumber, options = {}) {
  const key = compactProcessNumber(processNumber);
  if (key.length !== 20) throw new Error("informe um número CNJ válido");
  const existing = (state.cases || []).find((item) => compactProcessNumber(item.process_number) === key);
  const formatted = formatCompactProcessNumber(key);
  const pjeUrl = options.process_source_url || officialPjeUrlForProcessNumber(key);
  if (existing) {
    if (pjeUrl && (!pjeCollectionUrl(existing) || casePjeCollectionPending(existing))) {
      const data = await api("/api/cases/action", {
        method: "POST",
        body: JSON.stringify({
          case_id: existing.id,
          action: "prepare_pje_collection",
          process_source_url: pjeUrl,
        }),
      });
      return data.case || existing;
    }
    return existing;
  }
  const data = await api("/api/cases", {
    method: "POST",
    body: JSON.stringify({
      case_type: "existing_claimant",
      process_number: formatted,
      title: options.title || `Processo ${formatted}`,
      process_source_url: pjeUrl,
    }),
  });
  return data.case;
}

async function addProcessCenterProcess() {
  const input = $("#processCenterNumber");
  const raw = input.value.trim();
  const processNumber = extractProcessNumber(raw) || formatCompactProcessNumber(compactProcessNumber(raw));
  if (!processNumber || compactProcessNumber(processNumber).length !== 20) {
    $("#processCenterStatus").textContent = "Informe um número CNJ válido.";
    return;
  }
  const pjeUrl = officialPjeUrlForProcessNumber(processNumber);
  $("#processCenterStatus").textContent = "Cadastrando processo e colocando PJe na fila automática...";
  const caseItem = await ensureProcessCenterCase(processNumber, { process_source_url: pjeUrl });
  await api("/api/updates/watch", {
    method: "POST",
    body: JSON.stringify({ process_number: processNumber }),
  }).catch(() => {});
  input.value = "";
  $("#processCenterStatus").textContent = "Processo cadastrado. O worker PJe tentará coletar em segundo plano; DJEN/DataJud seguem em paralelo.";
  await loadProcessCenter({ refreshDatajud: true });
  const collected = await waitForPjeAssistedJob(caseItem);
  if (collected) {
    $("#processCenterStatus").textContent = "PJe coletado pelo worker. Atualizando o processo...";
    await loadProcessCenter().catch(() => {});
    return;
  }
  $("#processCenterStatus").textContent = "PJe segue na fila automática. Acompanhe tentativas e erros em PJe operador.";
  window.setTimeout(() => loadProcessCenter().catch(() => {}), 5000);
}

async function openPjeCollectionForCase(caseId) {
  const caseItem = (state.cases || []).find((item) => item.id === caseId) || state.selectedCase || {};
  const pjeUrl = pjeCollectionUrl(caseItem);
  if (!caseItem.id || !pjeUrl) throw new Error("não encontrei link PJe para este processo");
  const data = await api("/api/cases/action", {
    method: "POST",
    body: JSON.stringify({
      case_id: caseItem.id,
      action: "prepare_pje_collection",
      process_source_url: pjeUrl,
    }),
  });
  if (state.selectedCase?.id === caseItem.id) {
    state.selectedCase = data.case;
    renderCaseWorkspace();
  }
  await loadProcessCenter().catch(() => {});
  $("#processCenterStatus").textContent = "Recoleta PJe enviada para a fila automática. Aguardando uma tentativa rápida do worker.";
  const collected = await waitForPjeAssistedJob(data.case || caseItem);
  if (collected) {
    $("#processCenterStatus").textContent = "Recoleta PJe concluída pelo worker.";
    await loadProcessCenter().catch(() => {});
    if (state.selectedCase?.id === caseItem.id) await refreshSelectedCase(caseItem.id);
    return;
  }
  $("#processCenterStatus").textContent = "Recoleta PJe continua na fila automática. Acompanhe o job em PJe operador.";
}

async function openCaseFromCenter(caseId, preferredTab = "overview") {
  setView("processos");
  await openCase(caseId, preferredTab);
}

async function createAndOpenCaseFromCenter(processNumber) {
  $("#processCenterStatus").textContent = "Criando dossiê para o processo acompanhado...";
  const caseItem = await ensureProcessCenterCase(processNumber);
  await loadProcessCenter().catch(() => {});
  await openCaseFromCenter(caseItem.id, "overview");
}

async function removeProcessWatchFromCenter(processNumber) {
  const label = formatCompactProcessNumber(compactProcessNumber(processNumber)) || processNumber;
  const confirmed = window.confirm(`Remover o acompanhamento do processo ${label}?\n\nIsso tira o processo da central. Dossiês existentes devem ser removidos pelo botão Remover do próprio dossiê.`);
  if (!confirmed) return;
  await api("/api/updates/watch/remove", {
    method: "POST",
    body: JSON.stringify({ process_number: processNumber }),
  });
  state.updateTimelineProcess = "";
  await loadProcessCenter();
  $("#processCenterStatus").textContent = `${label} foi removido da central.`;
}

function selectProcessCenterTimeline(processNumber) {
  state.updateTimelineProcess = compactProcessNumber(processNumber);
  renderProcessCenter(state.processCenter || {});
  $("#processCenterTimelinePanel")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function closeProcessCenterTimeline() {
  state.updateTimelineProcess = "";
  renderProcessCenter(state.processCenter || {});
}

async function searchLawyerDeadlines() {
  const lawyerName = $("#lawyerDeadlineName").value.trim();
  const oab = $("#lawyerDeadlineOab").value.trim();
  const uf = $("#lawyerDeadlineUf").value.trim();
  if (!lawyerName && !oab) {
    $("#lawyerDeadlineStatus").textContent = "Informe nome ou OAB.";
    return;
  }
  $("#lawyerDeadlineStatus").textContent = "Pesquisando...";
  await loadDeadlines({ lawyerName, oab, uf });
  $("#lawyerDeadlineStatus").textContent = "Pesquisa concluída.";
}

function selectedDuckdb() {
  const key = $("#duckdbDatabase")?.value || "acervo";
  return state.duckdbInfo?.databases?.find((item) => item.key === key) || null;
}

function renderDuckdbSchema() {
  const db = selectedDuckdb();
  const schema = $("#duckdbSchema");
  if (!schema) return;
  if (!db) {
    schema.innerHTML = `<div class="muted schema-empty">Nenhuma base selecionada.</div>`;
    return;
  }
  schema.innerHTML = db.tables.length
    ? db.tables
        .map(
          (table) => `
            <details class="schema-table">
              <summary><strong>${escapeHtml(table.name)}</strong><span>${fmt(table.rows)} linhas</span></summary>
              <div class="schema-columns">
                ${table.columns
                  .map((column) => `<button type="button" class="schema-column" data-table="${escapeHtml(table.name)}" data-column="${escapeHtml(column.name)}"><span>${escapeHtml(column.name)}</span><small>${escapeHtml(column.type)}</small></button>`)
                  .join("")}
              </div>
            </details>
          `
        )
        .join("")
    : `<div class="muted schema-empty">Sem tabelas disponíveis.</div>`;
  $$(".schema-column").forEach((item) => {
    item.addEventListener("click", () => {
      const table = item.dataset.table;
      const column = item.dataset.column;
      $("#duckdbSql").value = `SELECT "${column}"\nFROM "${table}"\nLIMIT 50;`;
    });
  });
}

function renderDuckdbExamples() {
  const list = $("#duckdbExamples");
  if (!list || !state.duckdbInfo) return;
  list.innerHTML = state.duckdbInfo.examples
    .map((example) => `<button type="button" data-db="${escapeHtml(example.database)}" data-sql="${escapeHtml(example.sql)}">${escapeHtml(example.label)}</button>`)
    .join("");
  $$("#duckdbExamples button").forEach((button) => {
    button.addEventListener("click", () => {
      $("#duckdbDatabase").value = button.dataset.db;
      $("#duckdbSql").value = button.dataset.sql;
      renderDuckdbSchema();
    });
  });
}

function renderDuckdbInfo(data) {
  state.duckdbInfo = data;
  const conn = data.connection;
  renderCards($("#duckdbConnectionCards"), [
    { label: "Engine", value: conn.engine, note: conn.mode },
    { label: "Host", value: conn.host, note: `porta ${conn.port}` },
    { label: "Usuário", value: conn.user, note: conn.password_hint },
    { label: "Driver direto", value: "arquivo", note: conn.direct_driver },
    { label: "Bases", value: fmt(data.databases.length), note: "DuckDB locais" },
    { label: "Limite", value: fmt(data.max_rows), note: "linhas por query" },
  ]);
  const current = $("#duckdbDatabase").value || "acervo";
  $("#duckdbDatabase").innerHTML = data.databases
    .map((db) => `<option value="${escapeHtml(db.key)}">${escapeHtml(db.label)} - ${escapeHtml(db.key)}</option>`)
    .join("");
  $("#duckdbDatabase").value = data.databases.some((db) => db.key === current) ? current : data.databases[0]?.key || "";
  renderDuckdbExamples();
  renderDuckdbSchema();
  if (!$("#duckdbSql").value.trim()) {
    const starter = data.examples.find((item) => item.database === $("#duckdbDatabase").value) || data.examples[0];
    if (starter) {
      $("#duckdbDatabase").value = starter.database;
      $("#duckdbSql").value = starter.sql;
      renderDuckdbSchema();
    }
  }
}

async function loadDuckdbWorkbench() {
  const data = await api("/api/admin/duckdb");
  renderDuckdbInfo(data);
}

function renderDuckdbResult(data) {
  const table = $("#duckdbResultTable");
  const meta = $("#duckdbResultMeta");
  meta.textContent = `${fmt(data.row_count)} linhas · ${fmt(data.elapsed_ms)} ms${data.truncated ? ` · truncado em ${fmt(data.max_rows)}` : ""}`;
  if (!data.columns.length) {
    table.querySelector("thead").innerHTML = "";
    table.querySelector("tbody").innerHTML = `<tr><td class="muted">Query executada sem colunas retornadas.</td></tr>`;
    return;
  }
  table.querySelector("thead").innerHTML = `<tr>${data.columns.map((column) => `<th>${escapeHtml(column.name)}<br><small>${escapeHtml(column.type)}</small></th>`).join("")}</tr>`;
  table.querySelector("tbody").innerHTML = data.rows.length
    ? data.rows
        .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell === null ? "NULL" : String(cell))}</td>`).join("")}</tr>`)
        .join("")
    : `<tr><td colspan="${data.columns.length}" class="muted">Sem linhas para essa query.</td></tr>`;
}

function caseCompletion(item = {}) {
  const total = Number(item.checklist_total || item.checklist?.length || 0);
  const done = Number(item.checklist_done ?? (item.checklist || []).filter((row) => row.checked).length);
  return total ? Math.round((done / total) * 100) : 0;
}

function caseRiskSlug(value) {
  return statusSlug(value || "não classificado");
}

function caseDeadlineBadge(item = {}) {
  const summary = item.deadline_summary || {};
  const hasDeadline = Boolean(summary.has_deadline);
  const hasCalendarEvent = Boolean(summary.has_calendar_event);
  if (!hasDeadline && !hasCalendarEvent) return "";
  const level = String(summary.risk_level || "").toLowerCase();
  const riskClass = level === "critical" ? "critical" : level === "high" ? "high" : "medium";
  const count = Number(hasDeadline ? summary.count || 0 : summary.calendar_count || 0);
  const label = hasDeadline
    ? summary.due_label || "prazo para revisar"
    : summary.calendar_label || "evento no diário";
  const suffix = count > 1 ? ` · ${fmt(count)} ${hasDeadline ? "prazos" : "datas"}` : "";
  const kindClass = hasDeadline ? "deadline" : "calendar";
  return `<span class="case-deadline-badge ${riskClass} ${kindClass}">${escapeHtml(label)}${escapeHtml(suffix)}</span>`;
}

function renderCaseList() {
  const rows = state.cases || [];
  $("#caseSummaryCards").innerHTML = "";
  $("#caseListMeta").textContent = `${fmt(rows.length)} ${rows.length === 1 ? "sessão" : "sessões"}`;
  $("#caseCards").innerHTML = rows.length
    ? rows.map((item) => {
        const completion = caseCompletion(item);
        const parties = [item.claimant_name, item.defendant_name].filter(Boolean).join(" × ") || item.title;
        return `<article class="case-card" data-case-id="${escapeHtml(item.id)}">
          <div class="case-card-top"><span>${escapeHtml(item.case_type_label)}</span><small>${escapeHtml(fmtMoment(item.updated_at))}</small></div>
          <h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(parties)}</p>
          ${item.process_number ? `<code>${escapeHtml(item.process_number)}</code>` : `<code>pré-processual</code>`}
          ${caseDeadlineBadge(item)}
          <div class="case-card-progress"><span><i style="width:${completion}%"></i></span><small>${completion}% do checklist</small></div>
          <div class="case-card-foot"><span>${fmt(item.document_count)} docs</span><span>${fmt(item.claim_count)} pedidos</span><span>${fmt(item.piece_count)} peças</span></div>
          <div class="case-card-actions">
            <button class="case-card-open" type="button" data-open-case="${escapeHtml(item.id)}">Abrir →</button>
            <button class="case-card-delete" type="button" data-delete-case="${escapeHtml(item.id)}" title="Excluir este processo">Excluir</button>
          </div>
        </article>`;
      }).join("")
    : `<div class="case-empty"><span>＋</span><h3>Nenhum dossiê ainda.</h3><p>Escolha uma das três opções acima para começar com documento, processo existente ou caso novo.</p></div>`;
}

async function loadCases(query = "") {
  const data = await api(`/api/cases?q=${encodeURIComponent(query)}`);
  state.cases = data.cases || [];
  renderCaseList();
}

function renderDocumentAnalysisHub() {
  const rows = (state.cases || []).filter((item) => ["document_analysis", "piece_review"].includes(item.case_type));
  $("#documentAnalysisMeta").textContent = `${fmt(rows.length)} análises`;
  $("#documentAnalysisRows").innerHTML = rows.length
    ? rows.map((item) => `<tr>
        <td><strong>${escapeHtml(item.title)}</strong><br><span class="muted">${escapeHtml(item.status || item.stage || "")}</span></td>
        <td>${escapeHtml(item.case_type_label || "Análise documental")}</td>
        <td>${escapeHtml(fmtMoment(item.updated_at))}</td>
        <td>${fmt(item.document_count)} docs · ${fmt(item.piece_count)} versões</td>
        <td class="process-center-actions"><button type="button" data-document-analysis-open="${escapeHtml(item.id)}">Abrir</button><button type="button" class="danger" data-document-analysis-delete="${escapeHtml(item.id)}">Remover</button></td>
      </tr>`).join("")
    : `<tr><td colspan="5" class="muted">Nenhuma análise documental em andamento.</td></tr>`;
}

function renderDocumentAnalysisError(err) {
  $("#documentAnalysisMeta").textContent = `Erro: ${err.message}`;
  $("#documentAnalysisRows").innerHTML = `<tr><td colspan="5" class="muted">Falha ao carregar análises.</td></tr>`;
}

async function loadDocumentAnalysisHub() {
  const data = await api("/api/cases?q=");
  state.cases = data.cases || [];
  renderDocumentAnalysisHub();
}

async function deleteCaseFromList(caseId, options = {}) {
  const caseItem = (state.cases || []).find((item) => item.id === caseId) || (state.selectedCase?.id === caseId ? state.selectedCase : null);
  const title = caseItem?.title || "este processo";
  const confirmed = window.confirm(
    `Excluir "${title}"?\n\nIsso remove o processo dos seus processos e apaga os arquivos vinculados a ele, incluindo documentos, entrevistas e transcrições. Essa ação não pode ser desfeita.`
  );
  if (!confirmed) return;
  const data = await api("/api/cases/delete", {
    method: "POST",
    body: JSON.stringify({ case_id: caseId, confirm: true }),
  });
  if (state.selectedCase?.id === caseId) {
    state.selectedCase = null;
    state.caseChatPolling = false;
    $("#caseWorkspace").classList.add("hidden");
    $("#caseListView").classList.remove("hidden");
  }
  if (options.context === "processCenter") {
    state.updateTimelineProcess = "";
    await loadProcessCenter();
    $("#processCenterStatus").textContent = `${data.title || title} foi removido.`;
  } else if (options.context === "documentAnalysis") {
    await loadDocumentAnalysisHub();
    $("#documentAnalysisMeta").textContent = `${data.title || title} foi removido.`;
  } else {
    await loadCases($("#caseSearch")?.value.trim() || "");
    $("#caseListMeta").textContent = `${data.title || title} foi excluído.`;
  }
}

function resetExistingCaseImportPanel() {
  $("#existingCaseForm")?.reset();
  if ($("#existingZipSelection")) $("#existingZipSelection").textContent = "Nenhum arquivo selecionado";
  if ($("#processLinkHint")) $("#processLinkHint").textContent = "Cole um link oficial em domínio jus.br. Se houver número CNJ, nós detectamos automaticamente.";
  if ($("#newCaseStatus")) $("#newCaseStatus").textContent = "";
}

function setCaseStartHeroVisible(visible) {
  $(".case-start-hero")?.classList.toggle("hidden", !visible);
}

function closeNewCasePanel() {
  $("#newCasePanel").classList.add("hidden");
  setCaseStartHeroVisible(true);
}

function returnToProcessCenter() {
  state.selectedCase = null;
  state.caseChatPolling = false;
  $("#caseWorkspace")?.classList.add("hidden");
  $("#caseListView")?.classList.remove("hidden");
  $("#newCasePanel")?.classList.add("hidden");
  setCaseStartHeroVisible(true);
  setView("processos-v2");
}

function openCaseStartPanel(mode = "new") {
  state.selectedCase = null;
  state.caseChatPolling = false;
  $("#caseWorkspace").classList.add("hidden");
  $("#caseListView").classList.remove("hidden");
  $("#newCasePanel").classList.remove("hidden");
  setCaseStartHeroVisible(false);
  $$(".case-start-pane").forEach((pane) => pane.classList.add("hidden"));
  const copy = {
    document: [
      "Documento ou peça",
      "Analisar documento ou revisar peça pronta",
      "Você começa pelo upload. Depois conversa com a Justra sobre o arquivo e pode gerar novas versões.",
    ],
    existing: [
      "Processo existente",
      "Vincular consulta oficial e anexar autos",
      "Cole o link do PJe/consulta pública, resolva o CAPTCHA manualmente e anexe o ZIP/PDF exportado.",
    ],
    new: [
      "Novo processo",
      "Começar por chat guiado",
      "A Justra pergunta o essencial para estruturar fatos, documentos, pedidos e próximos passos.",
    ],
  }[mode] || [];
  $("#caseStartPanelKicker").textContent = copy[0] || "Próximo passo";
  $("#caseStartPanelTitle").textContent = copy[1] || "Começar";
  $("#caseStartPanelLead").textContent = copy[2] || "";
  if (mode === "document") {
    $("#documentStartPanel").classList.remove("hidden");
    $("#documentStartStatus").textContent = "";
  } else if (mode === "existing") {
    $("#existingCaseForm").classList.remove("hidden");
    resetExistingCaseImportPanel();
    $("#newCaseProcessUrl").focus();
  } else {
    $("#newProcessStartPanel").classList.remove("hidden");
    $("#newProcessStartStatus").textContent = "";
  }
  $("#newCasePanel").scrollIntoView({ behavior: "smooth", block: "start" });
}

function openNewCasePanel() {
  openCaseStartPanel("new");
}

async function runCaseStartCard(button, action, loadingText) {
  const cards = $$(".case-start-card");
  cards.forEach((item) => { item.disabled = true; });
  if ($("#caseListMeta")) $("#caseListMeta").textContent = loadingText;
  try {
    await action();
  } catch (err) {
    if ($("#caseListMeta")) $("#caseListMeta").textContent = `Erro: ${err.message}`;
  } finally {
    cards.forEach((item) => { item.disabled = false; });
  }
}

function syncProcessLinkImportState() {
  const rawUrl = $("#newCaseProcessUrl").value.trim();
  const officialUrl = officialProcessUrl(rawUrl);
  const extractedNumber = extractProcessNumber(rawUrl);
  const openButton = $("#openProcessCaptcha");
  if (!rawUrl) {
    openButton.disabled = false;
    $("#processLinkHint").textContent = "Cole o link da consulta oficial. Se tiver número CNJ, nós detectamos automaticamente.";
    return;
  }
  if (!officialUrl) {
    openButton.disabled = true;
    $("#processLinkHint").textContent = "Use um link completo e oficial do Judiciário em domínio jus.br.";
    return;
  }
  openButton.disabled = false;
  $("#processLinkHint").textContent = extractedNumber
    ? `Número detectado: ${extractedNumber}. Abra a consulta, resolva o CAPTCHA e depois crie a sessão.`
    : "Link oficial detectado. Abra a consulta, resolva o CAPTCHA e depois crie a sessão.";
}

function openProcessCaptchaTab() {
  const officialUrl = officialProcessUrl($("#newCaseProcessUrl").value.trim());
  if (!officialUrl) {
    $("#newCaseStatus").textContent = "Cole um link oficial do Judiciário em domínio jus.br antes de abrir a consulta.";
    return;
  }
  const opened = window.open(officialUrl, "_blank", "noopener,noreferrer");
  if (!opened) {
    $("#newCaseStatus").textContent = "O navegador bloqueou a nova aba. Libere popups para a Justra ou abra o link manualmente.";
    return;
  }
  $("#newCaseStatus").textContent = "A consulta oficial foi aberta. Resolva o CAPTCHA no site do Judiciário e volte para criar a sessão vinculada.";
}

function setCaseTab(tab) {
  state.caseTab = tab;
  $$('[data-case-tab]').forEach((button) => button.classList.toggle("active", button.dataset.caseTab === tab));
  $$(".case-tab-pane").forEach((pane) => pane.classList.toggle("active", pane.id === `case-tab-${tab}`));
}

function caseNextStep(caseData) {
  if ((caseData.process_source_url || caseData.pje_import?.source_url) && !caseRepresentationSide(caseData)) {
    return { label: "Definir se você atua pelo reclamante ou reclamado", tab: "overview" };
  }
  if (!(caseData.documents || []).length) return { label: "Enviar o primeiro documento", tab: "documents" };
  if (caseData.case_type === "document_analysis") {
    const waiting = (caseData.documents || []).filter((item) => item.analysis_status !== "Analisado").length;
    if (waiting) return { label: `Analisar ${waiting === 1 ? "o documento enviado" : `${waiting} documentos`}`, tab: "copilot" };
    return { label: "Continuar a análise ou enviar nova versão", tab: "copilot" };
  }
  if (caseData.case_type === "piece_review" && !(caseData.pieces || []).length) return { label: "Adicionar a peça que será revisada", tab: "pieces" };
  const missing = (caseData.checklist || []).find((item) => !item.checked);
  if (missing) return { label: `Providenciar: ${missing.label}`, tab: "overview" };
  if (!(caseData.claims || []).length) return { label: "Estruturar o primeiro pedido ou tese defensiva", tab: "matrix" };
  if (!(caseData.pieces || []).length) return { label: "Criar a primeira versão da peça", tab: "pieces" };
  return { label: "Revisar riscos e preparar a próxima versão", tab: "pieces" };
}

function caseRepresentationSide(caseData = state.selectedCase) {
  const explicit = String(caseData?.representation_side || "").toLowerCase();
  if (explicit === "claimant" || explicit === "defendant") return explicit;
  if (caseData?.case_type === "existing_defendant") return "defendant";
  if (caseData?.case_type === "new_claimant" || caseData?.case_type === "existing_claimant") return "claimant";
  return "";
}

function caseRepresentationLabel(caseData = state.selectedCase) {
  const side = caseRepresentationSide(caseData);
  if (side === "defendant") return "advogado do reclamado";
  if (side === "claimant") return "advogado do reclamante";
  return "lado ainda não definido";
}

function fmtFileSize(value) {
  const bytes = Number(value || 0);
  if (!bytes) return "tamanho não informado";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

function suggestedDocumentType(filename) {
  const name = text(filename, "").toLowerCase();
  if (name.includes("inicial")) return "Petição inicial";
  if (name.includes("contest")) return "Contestação";
  if (name.includes("ponto") || name.includes("jornada")) return "Cartão de ponto";
  if (name.includes("holerite") || name.includes("contracheque")) return "Holerite";
  if (name.includes("trct") || name.includes("rescis")) return "TRCT";
  if (name.includes("fgts")) return "FGTS";
  if (name.includes("whatsapp") || name.includes("conversa")) return "WhatsApp";
  if (name.includes("contrato")) return "Contrato";
  if (name.endsWith(".zip")) return "ZIP dos autos";
  return "Outro";
}

function selectCaseFiles(filesLike) {
  const status = $("#documentUploadStatus");
  const files = Array.from(filesLike || []).filter(Boolean);
  if (!files.length) {
    state.pendingCaseFile = null;
    state.pendingCaseFiles = [];
    $("#documentName").value = "";
    $("#caseFileSelection").textContent = "Nenhum arquivo selecionado";
    status.textContent = "";
    return;
  }
  const oversized = files.find((file) => file.size > 40 * 1024 * 1024);
  if (oversized) {
    state.pendingCaseFile = null;
    state.pendingCaseFiles = [];
    $("#documentName").value = "";
    $("#caseFileSelection").textContent = "Arquivo acima de 40 MB";
    status.textContent = `${oversized.name} excede 40 MB. Remova esse arquivo e tente novamente.`;
    status.className = "upload-status full error";
    return;
  }
  state.pendingCaseFiles = files;
  state.pendingCaseFile = files[0];
  $("#documentName").value = files.length === 1 ? files[0].name : `${files.length} documentos dos autos`;
  $("#documentType").value = suggestedDocumentType(files[0].name);
  $("#caseFileSelection").textContent = files.length === 1
    ? `${files[0].name} · ${fmtFileSize(files[0].size)}`
    : `${files.length} arquivos selecionados · ${files.map((file) => file.name).slice(0, 3).join(", ")}${files.length > 3 ? "…" : ""}`;
  status.textContent = files.length === 1
    ? "Arquivo pronto para envio. Complete a classificação abaixo."
    : "Autos prontos para envio. A classificação abaixo será usada como padrão; tentaremos inferir o tipo pelo nome de cada arquivo.";
  status.className = "upload-status full ready";
}

function selectCaseFile(file) {
  selectCaseFiles(file ? [file] : []);
}

function fileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").split(",", 2)[1] || "");
    reader.onerror = () => reject(new Error("não foi possível ler o arquivo"));
    reader.readAsDataURL(file);
  });
}

function formatRecordingTime(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function preferredAudioMimeType() {
  if (!window.MediaRecorder?.isTypeSupported) return "";
  return [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
  ].find((mime) => MediaRecorder.isTypeSupported(mime)) || "";
}

function setInterviewStatus(message = "", kind = "") {
  const status = $("#interviewStatus");
  if (!status) return;
  status.textContent = message;
  status.className = `save-status${kind ? ` ${kind}` : ""}`;
}

function updateInterviewTimer() {
  const timer = $("#recordingTimer");
  if (!timer) return;
  timer.textContent = formatRecordingTime(Date.now() - state.interviewStartedAt);
}

function setInterviewRecordingUi(mode = "idle") {
  const isRecording = mode === "recording";
  const isReady = mode === "ready";
  const isUploading = mode === "uploading";
  const startButton = $("#startInterviewRecording");
  const stopButton = $("#stopInterviewRecording");
  const discardButton = $("#discardInterviewRecording");
  const uploadButton = $("#uploadInterviewRecording");
  const badge = $("#interviewRecordingBadge");
  const orb = $("#recordingOrb");
  const hint = $("#recordingHint");
  if (!startButton || !stopButton || !discardButton || !uploadButton || !badge || !orb || !hint) return;

  startButton.disabled = isRecording || isUploading;
  stopButton.disabled = !isRecording || isUploading;
  discardButton.disabled = !isReady || isUploading;
  uploadButton.disabled = !isReady || isUploading;
  startButton.textContent = isReady ? "Gravar novamente" : "Permitir microfone e gravar";
  uploadButton.textContent = isUploading ? "Enviando e transcrevendo..." : "Transcrever e abrir chat";

  badge.className = `recording-badge ${isRecording ? "recording" : isReady ? "ready" : isUploading ? "uploading" : "idle"}`;
  badge.textContent = isRecording ? "Gravando" : isReady ? "Pronto para envio" : isUploading ? "Processando" : "Parado";
  orb.classList.toggle("recording", isRecording);
  orb.classList.toggle("ready", isReady);
  hint.textContent = isRecording
    ? "Gravando pelo microfone deste computador."
    : isReady
      ? `Gravação pronta · ${fmtFileSize(state.interviewBlob?.size || 0)}`
      : isUploading
        ? "Aguarde. Vamos salvar a entrevista, transcrever e abrir o Copilot."
        : "Clique em permitir microfone para começar o teste.";
}

function stopInterviewStream() {
  if (state.interviewStream) {
    state.interviewStream.getTracks().forEach((track) => track.stop());
  }
  state.interviewStream = null;
}

function resetInterviewRecording({ keepStatus = false } = {}) {
  if (state.interviewTimer) clearInterval(state.interviewTimer);
  state.interviewTimer = null;
  if (state.interviewRecorder && state.interviewRecorder.state !== "inactive") {
    try { state.interviewRecorder.stop(); } catch (_) {}
  }
  stopInterviewStream();
  state.interviewRecorder = null;
  state.interviewChunks = [];
  state.interviewBlob = null;
  state.interviewStartedAt = 0;
  const timer = $("#recordingTimer");
  if (timer) timer.textContent = "00:00";
  setInterviewRecordingUi("idle");
  if (!keepStatus) setInterviewStatus("");
}

function syncInterviewCaseSelection() {
  const selectedCaseId = $("#interviewCaseSelect")?.value || "";
  const titleInput = $("#interviewNewCaseTitle");
  if (!titleInput) return;
  titleInput.disabled = Boolean(selectedCaseId);
  if (selectedCaseId) {
    titleInput.value = "";
    titleInput.placeholder = "Será anexado ao dossiê escolhido";
  } else {
    titleInput.placeholder = "Ex.: Entrevista Maria Silva";
  }
}

async function loadInterviewCases(query = "") {
  const select = $("#interviewCaseSelect");
  if (!select) return;
  const current = select.value;
  const data = await api(`/api/cases?q=${encodeURIComponent(query)}`);
  state.cases = data.cases || [];
  const options = [
    `<option value="">Criar novo dossiê a partir da entrevista</option>`,
    ...state.cases.map((item) => {
      const parts = [
        item.title || "Dossiê sem título",
        item.process_number || "pré-processual",
        item.case_type_label || "",
      ].filter(Boolean);
      return `<option value="${escapeHtml(item.id)}">${escapeHtml(parts.join(" · "))}</option>`;
    }),
  ];
  select.innerHTML = options.join("");
  if (current && state.cases.some((item) => item.id === current)) select.value = current;
  syncInterviewCaseSelection();
}

async function startInterviewRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    setInterviewStatus("Este navegador não permite gravação de áudio via MediaRecorder. Use Chrome, Edge ou Safari atualizado.", "error");
    return;
  }
  if (!window.isSecureContext && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
    setInterviewStatus("O navegador só libera microfone em HTTPS. Abra pela URL segura do ngrok/app.", "error");
    return;
  }
  resetInterviewRecording({ keepStatus: true });
  setInterviewStatus("Solicitando permissão do microfone...", "loading");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    const mimeType = preferredAudioMimeType();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    state.interviewStream = stream;
    state.interviewRecorder = recorder;
    state.interviewChunks = [];
    state.interviewBlob = null;
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data?.size) state.interviewChunks.push(event.data);
    });
    recorder.addEventListener("stop", () => {
      if (state.interviewTimer) clearInterval(state.interviewTimer);
      state.interviewTimer = null;
      stopInterviewStream();
      const finalType = recorder.mimeType || mimeType || "audio/webm";
      const blob = new Blob(state.interviewChunks, { type: finalType });
      state.interviewRecorder = null;
      if (!blob.size) {
        state.interviewBlob = null;
        setInterviewRecordingUi("idle");
        setInterviewStatus("A gravação ficou vazia. Tente novamente e fale próximo ao microfone.", "error");
        return;
      }
      if (blob.size > 25 * 1024 * 1024) {
        state.interviewBlob = null;
        setInterviewRecordingUi("idle");
        setInterviewStatus("A gravação passou de 25 MB. Grave por blocos menores para este MVP.", "error");
        return;
      }
      state.interviewBlob = blob;
      setInterviewRecordingUi("ready");
      setInterviewStatus("Gravação pronta. Clique em “Transcrever e abrir chat”.", "success");
    });
    state.interviewStartedAt = Date.now();
    updateInterviewTimer();
    state.interviewTimer = setInterval(updateInterviewTimer, 500);
    recorder.start(1000);
    setInterviewRecordingUi("recording");
    setInterviewStatus("Gravando. Confirme consentimento e conduza a entrevista normalmente.", "recording");
  } catch (err) {
    stopInterviewStream();
    const denied = err?.name === "NotAllowedError" || err?.name === "SecurityError";
    setInterviewRecordingUi("idle");
    setInterviewStatus(
      denied
        ? "Microfone não autorizado. Libere a permissão do navegador para a Justra e tente de novo."
        : `Não consegui iniciar o microfone: ${err.message || err}`,
      "error",
    );
  }
}

function stopInterviewRecording() {
  if (!state.interviewRecorder || state.interviewRecorder.state === "inactive") {
    stopInterviewStream();
    setInterviewRecordingUi(state.interviewBlob ? "ready" : "idle");
    return;
  }
  setInterviewStatus("Finalizando gravação...", "loading");
  state.interviewRecorder.stop();
}

function discardInterviewRecording() {
  resetInterviewRecording();
  setInterviewStatus("Gravação descartada. Você pode gravar novamente.", "ready");
}

function interviewAudioFilename(blob) {
  const extensionByMime = {
    "audio/webm": "webm",
    "video/webm": "webm",
    "audio/mp4": "mp4",
    "audio/m4a": "m4a",
    "audio/x-m4a": "m4a",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
  };
  const mime = String(blob?.type || "audio/webm").split(";", 1)[0];
  const extension = extensionByMime[mime] || "webm";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `entrevista-${stamp}.${extension}`;
}

async function ensureInterviewCase() {
  const selectedCaseId = $("#interviewCaseSelect")?.value || "";
  if (selectedCaseId) return selectedCaseId;
  const side = $("#interviewSide")?.value || "";
  const fallbackTitle = `Entrevista ${new Date().toLocaleDateString("pt-BR")} ${new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
  const data = await api("/api/cases", {
    method: "POST",
    body: JSON.stringify({
      case_type: side === "defendant" ? "existing_defendant" : "new_claimant",
      title: $("#interviewNewCaseTitle")?.value.trim() || fallbackTitle,
      representation_side: side,
    }),
  });
  await loadInterviewCases();
  if ($("#interviewCaseSelect")) $("#interviewCaseSelect").value = data.case.id;
  syncInterviewCaseSelection();
  return data.case.id;
}

async function uploadInterviewRecording() {
  if (!state.interviewBlob) {
    setInterviewStatus("Grave uma entrevista antes de enviar.", "error");
    return;
  }
  if (state.interviewBlob.size > 25 * 1024 * 1024) {
    setInterviewStatus("A gravação passou de 25 MB. Grave por blocos menores.", "error");
    return;
  }
  setInterviewRecordingUi("uploading");
  setInterviewStatus("Salvando áudio e preparando transcrição...", "loading");
  try {
    const caseId = await ensureInterviewCase();
    const audioBase64 = await fileAsBase64(state.interviewBlob);
    const data = await api("/api/cases/action", {
      method: "POST",
      body: JSON.stringify({
        case_id: caseId,
        action: "add_interview_audio",
        name: interviewAudioFilename(state.interviewBlob),
        mime_type: state.interviewBlob.type || "audio/webm",
        audio_base64: audioBase64,
        representation_side: $("#interviewSide")?.value || "",
      }),
    });
    state.selectedCase = data.case;
    resetInterviewRecording({ keepStatus: true });
    setInterviewStatus("Entrevista salva. Abrindo Copilot do processo...", "success");
    setView("processos");
    await loadCases($("#caseSearch")?.value.trim() || "");
    await openCase(caseId, "copilot");
  } catch (err) {
    setInterviewRecordingUi(state.interviewBlob ? "ready" : "idle");
    setInterviewStatus(`Não consegui processar a entrevista: ${err.message}`, "error");
  }
}

function activeCaseDocument() {
  const documents = state.selectedCase?.documents || [];
  return documents.find((item) => item.id === state.activeCaseDocumentId) || documents[documents.length - 1] || null;
}

function caseAnalysisPending(caseData = state.selectedCase) {
  return Boolean((caseData?.chat_messages || []).some((message) => message.pending));
}

async function pollPendingCaseAnalysis(caseId) {
  if (state.caseChatPolling) return;
  state.caseChatPolling = true;
  try {
    while (state.selectedCase?.id === caseId && caseAnalysisPending()) {
      await new Promise((resolve) => setTimeout(resolve, 1800));
      const data = await api(`/api/cases/${encodeURIComponent(caseId)}`);
      if (state.selectedCase?.id !== caseId) break;
      state.selectedCase = data.case;
      renderCaseWorkspace();
    }
  } catch (err) {
    const notice = $("#caseAnalysisNotice");
    notice.className = "analysis-notice error";
    notice.textContent = `Não consegui atualizar o andamento: ${err.message}. Reabra o processo para tentar novamente.`;
  } finally {
    state.caseChatPolling = false;
  }
}

async function downloadCaseDocument(documentId, version = "") {
  if (!state.selectedCase) return;
  const caseDocument = (state.selectedCase.documents || []).find((item) => item.id === documentId);
  const selectedVersion = version ? (caseDocument?.versions || []).find((item) => item.version === version) : null;
  const params = new URLSearchParams();
  if (version) params.set("version", version);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const response = await fetch(`/api/cases/${encodeURIComponent(state.selectedCase.id)}/documents/${encodeURIComponent(documentId)}/download${suffix}`, {
    headers: state.token ? { Authorization: `Bearer ${state.token}` } : {},
  });
  if (!response.ok) {
    let error = {};
    try { error = await response.json(); } catch { /* resposta não JSON */ }
    throw new Error(error.error || "não foi possível baixar o arquivo");
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = selectedVersion?.name || caseDocument?.name || "documento";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function deleteSelectedCaseDocument(documentId) {
  if (!state.selectedCase) return;
  const documentItem = (state.selectedCase.documents || []).find((item) => item.id === documentId);
  const name = documentItem?.name || "este documento";
  const confirmed = window.confirm(`Remover "${name}"?\n\nIsso apaga o arquivo e as versões vinculadas deste dossiê. Essa ação não pode ser desfeita.`);
  if (!confirmed) return;
  if (state.activeCaseDocumentId === documentId) state.activeCaseDocumentId = "";
  await updateSelectedCase("delete_document", { document_id: documentId });
  $("#documentAreaStatus").className = "document-area-status";
  $("#documentAreaStatus").textContent = `${name} foi removido.`;
}

function openCaseDocumentPreview(documentId, version = "") {
  if (!state.selectedCase) return;
  const params = new URLSearchParams({
    case_id: state.selectedCase.id,
    document_id: documentId,
  });
  if (version) params.set("version", version);
  const previewWindow = window.open(
    `/document-preview?${params.toString()}`,
    `justra-preview-${documentId}-${version || "current"}`,
    "width=1180,height=860,menubar=no,toolbar=no"
  );
  if (!previewWindow) {
    const notice = $("#caseAnalysisNotice");
    notice.className = "analysis-notice error";
    notice.textContent = "O navegador bloqueou o popup de preview. Libere popups para a Justra ou use Baixar versão.";
    return;
  }
  previewWindow.focus();
  const sendPreviewAuth = () => {
    try {
      previewWindow.postMessage({ type: "justra-preview-auth", token: state.token || "" }, window.location.origin);
    } catch {
      /* janela ainda não está pronta */
    }
  };
  window.setTimeout(sendPreviewAuth, 250);
  window.setTimeout(sendPreviewAuth, 900);
  window.setTimeout(sendPreviewAuth, 1800);
  window.setTimeout(sendPreviewAuth, 3500);
  window.setTimeout(sendPreviewAuth, 5200);
}

function contentDispositionFilename(header, fallback) {
  const match = String(header || "").match(/filename=\"?([^\";]+)\"?/i);
  return match ? decodeURIComponent(match[1]) : fallback;
}

function interviewSideLabel(value) {
  if (value === "claimant") return "Reclamante";
  if (value === "defendant") return "Reclamado";
  return "Lado não definido";
}

function caseInterviewById(interviewId) {
  return (state.selectedCase?.interviews || []).find((item) => item.id === interviewId) || null;
}

function hasInterviewTranscript(interview = {}) {
  return Boolean(interview.transcript_path || interview.transcript || normalizeText(interview.transcript_status || "").includes("transcrito"));
}

async function downloadCaseInterviewArtifact(interviewId, kind = "audio") {
  if (!state.selectedCase) return;
  const interview = caseInterviewById(interviewId);
  const response = await fetch(`/api/cases/${encodeURIComponent(state.selectedCase.id)}/interviews/${encodeURIComponent(interviewId)}/${kind}/download`, {
    headers: state.token ? { Authorization: `Bearer ${state.token}` } : {},
  });
  if (!response.ok) {
    let error = {};
    try { error = await response.json(); } catch { /* resposta não JSON */ }
    throw new Error(error.error || "não foi possível baixar o arquivo da entrevista");
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const fallback = kind === "audio"
    ? (interview?.name || "entrevista.webm")
    : `transcricao-${(interview?.name || "entrevista").replace(/\.[^.]+$/, "")}.txt`;
  const link = document.createElement("a");
  link.href = url;
  link.download = contentDispositionFilename(response.headers.get("Content-Disposition"), fallback);
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function ensureCaseInterviewAudioUrl(interviewId) {
  if (state.interviewAudioUrls[interviewId]) return state.interviewAudioUrls[interviewId];
  if (!state.selectedCase) throw new Error("processo não selecionado");
  const data = await api(`/api/cases/${encodeURIComponent(state.selectedCase.id)}/interviews/${encodeURIComponent(interviewId)}/playback-url`);
  if (!data.url) throw new Error("não foi possível preparar o link de áudio");
  state.interviewAudioUrls[interviewId] = data.url;
  return data.url;
}

async function toggleCaseInterviewAudio(interviewId) {
  if (state.openInterviewAudioId === interviewId) {
    state.openInterviewAudioId = "";
    renderCaseWorkspace();
    return;
  }
  state.openInterviewAudioId = interviewId;
  state.interviewAudioLoadingId = interviewId;
  renderCaseWorkspace();
  try {
    await ensureCaseInterviewAudioUrl(interviewId);
  } finally {
    state.interviewAudioLoadingId = "";
    renderCaseWorkspace();
  }
}

function openInterviewTranscriptPreview(interviewId) {
  if (!state.selectedCase) return;
  const interview = caseInterviewById(interviewId);
  if (!hasInterviewTranscript(interview || {})) {
    const notice = $("#caseAnalysisNotice");
    notice.className = "analysis-notice error";
    notice.textContent = "Esta entrevista ainda não tem transcrição disponível para preview.";
    return;
  }
  const params = new URLSearchParams({
    case_id: state.selectedCase.id,
    interview_id: interviewId,
  });
  const previewWindow = window.open(
    `/interview-preview?${params.toString()}`,
    `justra-interview-${interviewId}`,
    "width=1180,height=860,menubar=no,toolbar=no"
  );
  if (!previewWindow) {
    const notice = $("#caseAnalysisNotice");
    notice.className = "analysis-notice error";
    notice.textContent = "O navegador bloqueou o popup da transcrição. Libere popups para a Justra ou use Baixar transcrição.";
    return;
  }
  previewWindow.focus();
  const sendPreviewAuth = () => {
    try {
      previewWindow.postMessage({ type: "justra-preview-auth", token: state.token || "" }, window.location.origin);
    } catch {
      /* janela ainda não está pronta */
    }
  };
  window.setTimeout(sendPreviewAuth, 250);
  window.setTimeout(sendPreviewAuth, 900);
  window.setTimeout(sendPreviewAuth, 1800);
  window.setTimeout(sendPreviewAuth, 3500);
  window.setTimeout(sendPreviewAuth, 5200);
}

function renderCaseInterviewCards(interviews = [], compact = false) {
  const visible = [...interviews].reverse().slice(0, compact ? 1 : interviews.length);
  if (!visible.length) return "";
  return visible.map((interview) => {
    const transcriptReady = hasInterviewTranscript(interview);
    const status = interview.transcript_status || (transcriptReady ? "Transcrito" : "Transcrição pendente");
    const error = interview.transcript_error || "";
    const side = interview.representation_side || state.selectedCase?.representation_side || "";
    return `
      <article class="case-interview-card ${compact ? "compact" : ""}">
        <div class="interview-card-icon">🎙</div>
        <div class="interview-card-main">
          <div class="interview-card-title">
            <div><span>Entrevista</span><h3>${escapeHtml(interview.name || "Áudio da entrevista")}</h3></div>
            <strong>${escapeHtml(status)}</strong>
          </div>
          <p>${escapeHtml([fmtMoment(interview.created_at), fmtFileSize(interview.size_bytes), interviewSideLabel(side)].filter(Boolean).join(" · "))}</p>
          ${error ? `<small class="interview-card-error">${escapeHtml(error)}</small>` : `<small>Áudio original e transcrição ficam preservados no histórico do dossiê.</small>`}
          <div class="interview-card-actions">
            <button type="button" data-listen-interview-audio="${escapeHtml(interview.id)}">${state.openInterviewAudioId === interview.id ? "Ocultar áudio" : "Ouvir áudio"}</button>
            <button type="button" data-preview-interview="${escapeHtml(interview.id)}" ${transcriptReady ? "" : "disabled"}>Ver transcrição</button>
            <button type="button" data-download-interview-transcript="${escapeHtml(interview.id)}" ${transcriptReady ? "" : "disabled"}>Baixar transcrição</button>
            <button type="button" data-download-interview-audio="${escapeHtml(interview.id)}">Baixar áudio original</button>
          </div>
          ${state.openInterviewAudioId === interview.id ? `
            <div class="interview-audio-player">
              ${state.interviewAudioLoadingId === interview.id
                ? `<span>Carregando áudio original...</span>`
                : `<audio controls preload="metadata" src="${escapeHtml(state.interviewAudioUrls[interview.id] || "")}"></audio>`}
            </div>
          ` : ""}
        </div>
      </article>
    `;
  }).join("");
}

async function uploadCaseDocumentVersion(file, documentId) {
  if (!file || !documentId) return;
  if (file.size > 40 * 1024 * 1024) throw new Error("escolha um arquivo de até 40 MB");
  const notice = $("#caseAnalysisNotice");
  notice.classList.remove("hidden");
  notice.className = "analysis-notice loading";
  notice.textContent = `Enviando ${file.name} como nova versão...`;
  const fileBase64 = await fileAsBase64(file);
  await updateSelectedCase("add_document_version", {
    document_id: documentId,
    name: file.name,
    mime_type: file.type,
    file_base64: fileBase64,
  });
  state.activeCaseDocumentId = documentId;
  renderCaseWorkspace();
  setCaseTab("copilot");
  notice.className = "analysis-notice success";
  notice.textContent = `${file.name} foi anexado como nova versão. Você já pode analisar ou comparar.`;
}

function caseMessageHasLegalContent(message = {}) {
  if (message.role !== "assistant" || message.pending || message.failed) return false;
  const content = normalizeText(message.content || "");
  return Boolean(
    message.rewrite_offer?.status === "generated"
    || content.includes("jurisprud")
    || content.includes("precedente")
    || content.includes("sumula")
    || content.includes("orientacao jurisprudencial")
    || content.includes("acordao")
    || content.includes("fontes juridicas")
    || content.includes("falcao")
  );
}

function renderDocumentVersionTrail(documentItem = {}) {
  const versions = documentItem.versions || [];
  if (!versions.length) return "";
  const currentVersion = documentItem.version || versions.find((item) => item.is_current)?.version || versions.at(-1)?.version || "";
  return `
    <div class="document-version-trail" aria-label="Versões do documento">
      ${versions.map((version) => {
        const label = version.version || "v?";
        const isCurrent = label === currentVersion || version.is_current;
        const generated = version.generated_by_ai ? "IA" : "upload";
        return `<span class="${isCurrent ? "current" : ""}">
          <strong>${escapeHtml(label)}</strong>
          <small>${escapeHtml(generated)}</small>
          <button type="button" data-preview-document="${escapeHtml(documentItem.id)}" data-preview-version="${escapeHtml(label)}">Preview</button>
          <button type="button" data-download-document="${escapeHtml(documentItem.id)}" data-download-version="${escapeHtml(label)}">Baixar</button>
          ${isCurrent ? `<em>principal</em>` : `<button type="button" data-promote-document-version="${escapeHtml(label)}" data-promote-document="${escapeHtml(documentItem.id)}">Usar como principal</button>`}
        </span>`;
      }).join("")}
    </div>
  `;
}

function renderCaseDocumentAppendices(value) {
  const content = text(value, "");
  const legal = content.match(/Fontes jurídicas relacionadas do acervo:[\s\S]*?(?=\n\nAcórdãos com inteiro teor relacionados no Falcão|$)/i)?.[0] || "";
  const fullText = content.match(/Acórdãos com inteiro teor relacionados no Falcão \(amostra textual, não estatística\):[\s\S]*$/i)?.[0] || "";
  const body = [legal, fullText].filter(Boolean).join("\n\n");
  if (!body) return "";
  return `
    <details class="case-source-details">
      <summary><span>Fontes usadas nesta resposta</span><small>jurisprudência, acórdãos e links originais</small></summary>
      <div>${renderMessageHtml(body)}</div>
    </details>
  `;
}

function caseDocumentAnswerHtml(message = {}) {
  const content = message.content || "";
  const shouldStructure = message.role === "assistant"
    && !message.pending
    && (content.length > 900 || /^#{1,3}\s+/m.test(content) || caseMessageHasLegalContent(message));
  if (!shouldStructure) return `<div class="message-body">${renderMessageHtml(content)}</div>`;
  const prefix = `case-answer-${message.id || Math.random().toString(16).slice(2)}`;
  const parsed = renderAnswerSections(content, prefix);
  const wordCount = stripRenderedAppendices(content).trim().split(/\s+/).filter(Boolean).length;
  const readTime = Math.max(1, Math.ceil(wordCount / 180));
  return `
    <article class="case-document-answer">
      <header>
        <p>Análise documental</p>
        <h3>${caseMessageHasLegalContent(message) ? "Resposta jurídica aplicada ao documento" : "Leitura do documento"}</h3>
        <small>${fmt(parsed.sections.length)} seções · ${readTime} min de leitura</small>
      </header>
      <div class="case-document-answer-body">
        ${parsed.sections.map((section) => section.html).join("")}
        ${renderCaseDocumentAppendices(content)}
      </div>
    </article>
  `;
}

function renderCaseRewriteActions(message = {}, caseData = state.selectedCase) {
  if (message.role !== "assistant" || message.pending || message.failed) return "";
  const offer = message.rewrite_offer || {};
  const documentId = offer.document_id || activeCaseDocument()?.id || "";
  const documentItem = (caseData?.documents || []).find((item) => item.id === documentId) || activeCaseDocument();
  if (!documentItem) return "";
  if (offer.status === "generated") {
    const isCurrent = documentItem.version === offer.version;
    return `
      <div class="case-rewrite-cta generated">
        <div><strong>Nova versão criada: ${escapeHtml(offer.version || "")}</strong><p>Revise antes de protocolar. A versão anterior continua preservada no histórico.</p></div>
        <div>
          <button type="button" data-preview-document="${escapeHtml(documentId)}" data-preview-version="${escapeHtml(offer.version || "")}">Preview ${escapeHtml(offer.version || "versão")}</button>
          <button type="button" data-download-document="${escapeHtml(documentId)}" data-download-version="${escapeHtml(offer.version || "")}">Baixar ${escapeHtml(offer.version || "versão")}</button>
          <button class="primary" type="button" data-promote-document="${escapeHtml(documentId)}" data-promote-document-version="${escapeHtml(offer.version || "")}" ${isCurrent ? "disabled" : ""}>${isCurrent ? "Já é principal" : "Usar como principal"}</button>
        </div>
      </div>
    `;
  }
  if (offer.status === "promoted") {
    return `
      <div class="case-rewrite-cta promoted">
        <div><strong>${escapeHtml(offer.version || "Versão")} está como principal</strong><p>As demais versões continuam disponíveis no histórico do documento.</p></div>
        <div><button type="button" data-preview-document="${escapeHtml(documentId)}">Preview principal</button><button type="button" data-download-document="${escapeHtml(documentId)}">Baixar principal atual</button></div>
      </div>
    `;
  }
  if (!caseMessageHasLegalContent(message)) return "";
  return `
    <div class="case-rewrite-cta">
      <div><strong>Quer aplicar essas jurisprudências ao documento?</strong><p>Eu gero uma nova versão editável, mantenho a atual preservada e deixo você baixar ou promover a nova como principal.</p></div>
      <div>
        <button class="primary" type="button" data-rewrite-document="${escapeHtml(documentItem.id)}" data-source-message="${escapeHtml(message.id || "")}">Gerar nova versão</button>
        <button type="button" data-preview-document="${escapeHtml(documentItem.id)}">Preview principal atual</button>
        <button type="button" data-download-document="${escapeHtml(documentItem.id)}">Baixar versão principal</button>
      </div>
    </div>
  `;
}

function renderCaseChatMessage(message = {}, caseData = state.selectedCase) {
  const classes = ["case-chat-message", message.role, message.pending ? "pending" : "", message.failed ? "failed" : ""].filter(Boolean).join(" ");
  const content = message.pending
    ? `<span class="analysis-spinner" aria-hidden="true"></span><div>${renderMessageHtml(message.content)}</div>`
    : `${caseDocumentAnswerHtml(message)}${renderCaseRewriteActions(message, caseData)}`;
  return `<div class="${classes}">${content}${message.sources?.length ? `<small>Arquivo usado: ${message.sources.map(escapeHtml).join(" · ")}</small>` : ""}</div>`;
}

function renderCaseWorkspace() {
  const item = state.selectedCase;
  if (!item) return;
  $("#caseTypeBadge").textContent = item.case_type_label;
  $("#caseStatusBadge").textContent = item.status || "Em estruturação";
  $("#caseWorkspaceTitle").textContent = item.title;
  $("#caseWorkspaceMeta").textContent = [item.process_number || "Caso pré-processual", item.claimant_name, item.defendant_name].filter(Boolean).join(" · ");
  const nextStep = caseNextStep(item);
  $("#caseNextAction").textContent = nextStep.label;
  $("#caseNextActionButton").dataset.caseTabJump = nextStep.tab;

  const documents = item.documents || [];
  const interviews = item.interviews || [];
  const isDocumentAnalysis = item.case_type === "document_analysis";
  $('[data-case-tab="overview"]').classList.toggle("hidden", isDocumentAnalysis);
  $$('[data-case-advanced]').forEach((button) => button.classList.toggle("hidden", isDocumentAnalysis));
  const tutorial = $("#caseTutorial");
  tutorial.classList.toggle("hidden", !isDocumentAnalysis);
  tutorial.querySelector('[data-tutorial-step="upload"]')?.classList.toggle("done", documents.length > 0);
  tutorial.querySelector('[data-tutorial-step="analyze"]')?.classList.toggle("done", documents.some((doc) => doc.analysis_status === "Analisado"));
  tutorial.querySelector('[data-tutorial-step="version"]')?.classList.toggle("done", documents.some((doc) => (doc.versions || []).length > 1));
  if (documents.length && !documents.some((doc) => doc.id === state.activeCaseDocumentId)) {
    state.activeCaseDocumentId = documents[documents.length - 1].id;
  }
  const guidance = $("#caseGuidance");
  const processSourceUrl = pjeCollectionUrl(item);
  if (processSourceUrl) {
    const importStatus = item.pje_import?.status_label || "Aguardando consulta oficial";
    const pjePending = casePjeCollectionPending(item);
    const side = caseRepresentationSide(item);
    guidance.classList.remove("hidden");
    guidance.innerHTML = `
      <div>
        <span>Importação assistida</span>
        <h2>${side ? `Atuando como ${caseRepresentationLabel(item)}` : "Primeiro: de que lado você atua?"}</h2>
        <p>${pjePending
          ? "A coleta PJe ainda não foi concluída. Abra o PJe, resolva o CAPTCHA no site do Judiciário e use a extensão Justra PJe para enviar documentos e movimentações."
          : "Os autos capturados pelo PJe ficam junto dos documentos e da timeline processual. Você pode recoletar quando quiser atualizar movimentos e documentos visíveis."}</p>
        <div class="case-side-picker" aria-label="Lado de atuação">
          <button type="button" data-case-side="claimant" class="${side === "claimant" ? "active" : ""}">Sou do reclamante</button>
          <button type="button" data-case-side="defendant" class="${side === "defendant" ? "active" : ""}">Sou do reclamado</button>
        </div>
        <small class="case-import-status ${pjePending ? "pending" : ""}">${escapeHtml(importStatus)}${item.pje_import?.source_label ? ` · ${escapeHtml(item.pje_import.source_label)}` : ""}</small>
        <details class="process-text-import">
          <summary>Já resolvi o CAPTCHA. Quero importar o texto da página.</summary>
          <p>Na consulta oficial liberada, selecione o conteúdo principal da página, copie e cole aqui. Nós extraímos número, partes, classe e órgão quando esses campos aparecerem no texto.</p>
          <textarea id="processPageText" placeholder="Cole aqui o texto da consulta oficial depois do CAPTCHA"></textarea>
          <button type="button" data-import-process-text>Importar texto colado</button>
        </details>
      </div>
      <div class="guidance-actions">
        <button type="button" data-case-recollect-pje="${escapeHtml(item.id)}">${pjePending ? "Coletar PJe" : "Recoletar PJe"}</button>
        <button type="button" data-case-tab-jump="documents">Anexar documento do processo →</button>
      </div>`;
  } else if (!documents.length) {
    guidance.classList.remove("hidden");
    guidance.innerHTML = `<div><span>Comece por aqui</span><h2>Envie o primeiro documento do caso</h2><p>Você pode enviar PDF, DOCX ou imagem. Depois informe o tipo e o período para organizar a análise.</p></div><button type="button" data-case-tab-jump="documents">Enviar documento →</button>`;
  } else if (item.case_type === "document_analysis") {
    const waiting = documents.filter((doc) => doc.analysis_status !== "Analisado").length;
    guidance.classList.remove("hidden");
    guidance.innerHTML = `<div><span>Próxima etapa</span><h2>${waiting ? "Seu arquivo está pronto para revisão" : "Análise iniciada"}</h2><p>${waiting ? "Escolha o tipo de análise. Você pode baixar o original ou anexar uma nova versão a qualquer momento." : "Continue a conversa, baixe o documento ou envie a próxima versão."}</p></div><button type="button" data-case-tab-jump="copilot">Abrir análise →</button>`;
  } else {
    guidance.classList.add("hidden");
    guidance.innerHTML = "";
  }

  const checklist = item.checklist || [];
  const checklistDone = checklist.filter((row) => row.checked).length;
  const completion = checklist.length ? Math.round((checklistDone / checklist.length) * 100) : 0;
  $("#caseHealthLabel").textContent = `${completion}% estruturado`;
  $("#caseHealth").innerHTML = `
    <div class="case-health-score"><strong>${completion}%</strong><span><i style="width:${completion}%"></i></span></div>
    <div class="case-health-stats"><article><strong>${fmt((item.documents || []).length)}</strong><span>documentos</span></article><article><strong>${fmt((item.claims || []).length)}</strong><span>pedidos</span></article><article><strong>${fmt((item.pieces || []).length)}</strong><span>peças</span></article><article><strong>${fmt((item.timeline || []).length)}</strong><span>fatos</span></article></div>`;

  $("#caseTasks").innerHTML = (item.tasks || []).length
    ? item.tasks.map((task) => `<div class="case-task ${task.done ? "done" : ""}"><span>${task.done ? "✓" : "○"}</span><p>${escapeHtml(task.label)}</p></div>`).join("")
    : `<p class="muted">Nenhuma tarefa registrada.</p>`;
  $("#caseTimeline").innerHTML = (item.timeline || []).length
    ? item.timeline.map((event) => `<article><time>${escapeHtml(event.date ? formatDataJudDate(event.date) : "Sem data")}</time><p>${escapeHtml(event.label)}</p></article>`).join("")
    : `<div class="case-inline-empty">Adicione o primeiro fato relevante do vínculo ou do processo.</div>`;
  $("#caseChecklistMeta").textContent = `${checklistDone}/${checklist.length} concluídos`;
  $("#caseChecklist").innerHTML = checklist.map((row) => `<label><input type="checkbox" data-checklist-id="${escapeHtml(row.id)}" ${row.checked ? "checked" : ""}><span>${escapeHtml(row.label)}</span></label>`).join("");

  const documentForm = $("#documentForm");
  const documentToggle = $("#toggleDocumentForm");
  $("#documentAreaStatus").classList.add("hidden");
  $("#documentAreaStatus").textContent = "";
  if (!documents.length) {
    documentForm.classList.remove("hidden");
    documentToggle.classList.add("hidden");
  } else {
    documentForm.classList.add("hidden");
    documentToggle.classList.remove("hidden");
  }
  $("#caseDocuments").innerHTML = documents.length
    ? documents.map((doc) => `<article class="case-document"><div class="document-icon">${escapeHtml((doc.document_type || "D").slice(0, 2).toUpperCase())}</div><div><div class="document-title"><h3>${escapeHtml(doc.name)}</h3><span>${escapeHtml(doc.version || "v1")}</span></div><p>${escapeHtml([doc.document_type, doc.period, doc.related_party, fmtFileSize(doc.size_bytes)].filter(Boolean).join(" · "))}</p>${doc.note ? `<small>${escapeHtml(doc.note)}</small>` : ""}<div class="document-state"><span class="saved">✓ ${escapeHtml(doc.status || "Registrado")}</span><span class="analysis">${escapeHtml(doc.analysis_status || "Conteúdo ainda não analisado")}</span></div>${doc.analysis_note ? `<small class="document-analysis-note">${escapeHtml(doc.analysis_note)}</small>` : ""}${renderDocumentVersionTrail(doc)}</div><div class="document-actions"><button type="button" data-download-document="${escapeHtml(doc.id)}">Baixar principal</button><button type="button" data-version-document="${escapeHtml(doc.id)}">Nova versão</button><button class="primary" type="button" data-analyze-document="${escapeHtml(doc.id)}">Analisar</button><button class="danger" type="button" data-delete-document="${escapeHtml(doc.id)}">Remover</button></div></article>`).join("")
    : `<div class="case-inline-empty document-empty-note"><strong>O documento aparecerá aqui depois do envio.</strong><span>O status deixará claro quando o arquivo estiver salvo e quando o conteúdo tiver sido analisado.</span></div>`;
  $("#caseInterviewPanel").classList.toggle("hidden", !interviews.length);
  $("#caseInterviews").innerHTML = interviews.length ? renderCaseInterviewCards(interviews) : "";

  $("#caseClaims").innerHTML = (item.claims || []).length
    ? item.claims.map((claim) => `<article class="case-claim risk-${caseRiskSlug(claim.risk)}"><div class="claim-head"><div><span>Pedido</span><h3>${escapeHtml(claim.title)}</h3></div><strong>Risco ${escapeHtml((claim.risk || "não classificado").toLowerCase())}</strong></div><div class="claim-grid"><p><span>Base fática</span>${escapeHtml(claim.factual_basis || "Pendente")}</p><p><span>Tese jurídica</span>${escapeHtml(claim.legal_theory || "Pendente")}</p><p><span>Ponto de atenção</span>${escapeHtml(claim.risk_reason || "Ainda não informado")}</p></div></article>`).join("")
    : `<div class="case-inline-empty">A matriz ainda está vazia. Cadastre cada pedido ou tese defensiva com sua base fática e risco.</div>`;

  $("#casePieces").innerHTML = (item.pieces || []).length
    ? item.pieces.map((piece) => {
        const versions = piece.versions || [];
        const latest = versions[versions.length - 1] || {};
        return `<article class="case-piece"><div><span>${escapeHtml(piece.piece_type)}</span><h3>${escapeHtml(piece.title)}</h3><p>${fmt(versions.length)} ${versions.length === 1 ? "versão" : "versões"} · última ${escapeHtml(latest.version || "—")}</p></div><strong>${escapeHtml(latest.status || "Em elaboração")}</strong><small>${escapeHtml(latest.change_note || "")}</small></article>`;
      }).join("")
    : `<div class="case-inline-empty">Nenhuma peça salva. Use o editor para criar a v1.</div>`;

  const activeDocument = activeCaseDocument();
  const analysisDocument = $("#caseAnalysisDocument");
  const interviewQuick = $("#caseInterviewQuick");
  const side = caseRepresentationSide(item);
  $("#caseCopilotTitle").textContent = isDocumentAnalysis ? "Análise do documento" : "Copilot do processo";
  $("#caseCopilotSubtitle").textContent = activeDocument
    ? `Trabalhando como ${caseRepresentationLabel(item)} sobre o documento selecionado.`
    : "Escolha seu lado, suba os documentos dos autos e eu sugiro a próxima peça.";
  $("#caseChatInput").placeholder = activeDocument ? "Peça a análise, estratégia ou minuta para este documento..." : "Pergunte sobre este processo...";
  if (activeDocument) {
    const selector = documents.length > 1
      ? `<label class="analysis-document-select"><span>Documento em foco</span><select data-active-document-select>${documents.map((doc) => `<option value="${escapeHtml(doc.id)}" ${doc.id === activeDocument.id ? "selected" : ""}>${escapeHtml(doc.document_type || "Documento")} · ${escapeHtml(doc.name)}</option>`).join("")}</select></label>`
      : "";
    analysisDocument.classList.remove("hidden");
    analysisDocument.innerHTML = `<div class="analysis-file-icon">${escapeHtml((activeDocument.document_type || "DOC").slice(0, 3).toUpperCase())}</div><div><span>Documento em foco</span><h3>${escapeHtml(activeDocument.name)}</h3><p>${escapeHtml([activeDocument.document_type, activeDocument.version || "v1", fmtFileSize(activeDocument.size_bytes), activeDocument.analysis_status].filter(Boolean).join(" · "))}</p>${selector}${renderDocumentVersionTrail(activeDocument)}</div><div class="analysis-file-actions"><button type="button" data-download-document="${escapeHtml(activeDocument.id)}">↓ Baixar principal</button><button type="button" data-version-document="${escapeHtml(activeDocument.id)}">＋ Enviar nova versão</button></div>`;
  } else {
    analysisDocument.classList.add("hidden");
    analysisDocument.innerHTML = "";
  }
  interviewQuick.classList.toggle("hidden", !interviews.length);
  interviewQuick.innerHTML = interviews.length
    ? `<div class="interview-quick-head"><span>Entrevista mais recente</span><button type="button" data-case-tab-jump="documents">Ver todas</button></div>${renderCaseInterviewCards(interviews, true)}`
    : "";
  const analysisNotice = $("#caseAnalysisNotice");
  if (activeDocument) {
    analysisNotice.className = "analysis-notice privacy";
    analysisNotice.textContent = "Privacidade: ao iniciar, o texto do documento em foco é processado pela IA da Justra. O resultado é minuta de trabalho e deve ser revisado pelo advogado.";
  } else {
    analysisNotice.className = "analysis-notice hidden";
    analysisNotice.textContent = "";
  }
  const isPetition = Boolean(activeDocument && (normalizeText(activeDocument.document_type || "").includes("peticao") || normalizeText(activeDocument.name || "").includes("peticao")));
  const isAnswer = Boolean(activeDocument && normalizeText(`${activeDocument.document_type} ${activeDocument.name}`).includes("contest"));
  let promptRows = [];
  if (!side) {
    promptRows = [
      ["Definir estratégia", "Antes de analisar, pergunte de que lado eu atuo e quais documentos dos autos são prioritários."],
      ["Resumir processo", "Resuma este processo e diga quais informações faltam para definir a próxima peça."],
    ];
  } else if (side === "defendant" && (isPetition || !activeDocument)) {
    promptRows = [
      ["Preparar contestação", "Você é advogado do reclamado. Leia o documento em foco, identifique pedidos e fatos da inicial, liste documentos de defesa necessários, riscos e proponha uma estrutura de contestação."],
      ["Mapear pedidos da inicial", "Extraia os pedidos da petição inicial, fatos alegados, valores, provas mencionadas e pontos que precisam de impugnação específica."],
      ["Checklist da defesa", "A partir deste documento, diga quais documentos e informações preciso pedir ao cliente para preparar a defesa trabalhista."],
      ["Riscos e acordo", "Avalie riscos iniciais para o reclamado e destaque pontos que podem justificar acordo, preliminares ou impugnação forte."],
    ];
  } else if (side === "claimant" && isAnswer) {
    promptRows = [
      ["Preparar réplica", "Você é advogado do reclamante. Leia a contestação selecionada, identifique preliminares, impugnações e documentos, e proponha uma estrutura de réplica."],
      ["Rebater defesa", "Liste os pontos da contestação que precisam de impugnação específica e quais provas reforçam a tese do reclamante."],
      ["Provas pendentes", "A partir da contestação, diga quais documentos ou esclarecimentos devo buscar com o reclamante."],
      ["Riscos da réplica", "Aponte fragilidades da tese do reclamante reveladas pela defesa e como mitigar na réplica."],
    ];
  } else if (activeDocument) {
    promptRows = [
      isPetition
        ? ["Revisar e robustecer a petição", "Melhore esta petição, deixe a redação mais robusta e acrescente jurisprudência recente e pertinente do acervo, sem inventar fatos ou precedentes."]
        : ["Resumir documento", "Resuma o documento em foco, destacando objeto, partes, obrigações, pedidos, prazos e conclusões."],
      ["Próxima peça", "Considerando meu lado no processo e o documento em foco, diga qual é a próxima peça provável e proponha uma estrutura objetiva."],
      ["Riscos e inconsistências", "Revise o documento em foco e liste riscos, inconsistências, lacunas e pontos que exigem validação humana."],
      ["Extrair pontos importantes", "Extraia do documento em foco pedidos, obrigações, valores, datas, prazos e provas. Não invente o que não estiver expresso."],
    ];
  } else {
    promptRows = [
      ["Resumir processo", "Resuma este processo e indique a prioridade."],
      ["Documentos faltantes", "Quais documentos faltam neste caso?"],
      ["Maiores riscos", "Quais são os maiores riscos e fragilidades?"],
      ["Pedidos e provas", "Organize os pedidos, teses e provas do caso."],
    ];
  }
  const analysisPending = caseAnalysisPending(item);
  $(".copilot-prompts").innerHTML = promptRows.map(([label, prompt]) => `<button type="button" data-case-prompt="${escapeHtml(prompt)}" ${analysisPending ? "disabled" : ""}><strong>${escapeHtml(label)}</strong><span>${escapeHtml(prompt.split(".")[0])}</span></button>`).join("");
  $("#caseAnalysisActions").classList.toggle("hidden", isDocumentAnalysis && !activeDocument);
  $("#caseChatMessages").innerHTML = (item.chat_messages || []).map((message) => renderCaseChatMessage(message, item)).join("");
  $("#caseChatMessages").scrollTop = $("#caseChatMessages").scrollHeight;
  $("#caseChatInput").disabled = analysisPending;
  $("#caseChatForm button").disabled = analysisPending;
  $("#caseChatForm button").textContent = analysisPending ? "Analisando..." : "Enviar";
  $("#caseActivity").innerHTML = (item.activity || []).length
    ? item.activity.map((event) => `<article><time>${escapeHtml(fmtMoment(event.created_at))}</time><div><strong>${escapeHtml(event.event)}</strong><p>${escapeHtml(event.detail || "")}</p></div></article>`).join("")
    : `<div class="case-inline-empty">Nenhuma alteração registrada.</div>`;
}

async function openCase(caseId, preferredTab = "") {
  const data = await api(`/api/cases/${encodeURIComponent(caseId)}`);
  state.selectedCase = data.case;
  $("#caseListView").classList.add("hidden");
  $("#caseWorkspace").classList.remove("hidden");
  renderCaseWorkspace();
  const destination = preferredTab
    || (data.case.case_type === "document_analysis" ? ((data.case.documents || []).length ? "copilot" : "documents") : "")
    || (data.case.case_type === "piece_review" && !(data.case.pieces || []).length ? "pieces" : "")
    || "overview";
  setCaseTab(destination);
  if (caseAnalysisPending(data.case)) pollPendingCaseAnalysis(data.case.id);
}

function closeCaseWorkspace() {
  returnToProcessCenter();
}

async function uploadFileToCase(caseId, file, options = {}) {
  if (file.size > 40 * 1024 * 1024) throw new Error(`${file.name} excede 40 MB. Exporte um pacote menor ou anexe os documentos principais separadamente.`);
  const fileBase64 = await fileAsBase64(file);
  const data = await api("/api/cases/action", {
    method: "POST",
    body: JSON.stringify({
      case_id: caseId,
      action: "add_document",
      name: file.name,
      mime_type: file.type,
      file_base64: fileBase64,
      document_type: options.document_type || suggestedDocumentType(file.name),
      period: options.period || "",
      related_party: options.related_party || "Caso",
      note: options.note || "",
    }),
  });
  return data.case;
}

async function createDocumentAnalysisCase() {
  $("#documentStartStatus").textContent = "Abrindo área de upload...";
  const data = await api("/api/cases", {
    method: "POST",
    body: JSON.stringify({
      case_type: "document_analysis",
      title: `Análise documental ${new Date().toLocaleDateString("pt-BR")}`,
    }),
  });
  if (document.querySelector(".view.active")?.id !== "view-processos") setView("processos");
  $("#newCasePanel").classList.add("hidden");
  await loadCases();
  await openCase(data.case.id, "documents");
  $("#documentAreaStatus").className = "document-area-status";
  $("#documentAreaStatus").textContent = "Arraste ou escolha o arquivo principal para abrir o chat de análise.";
}

async function createExistingCaseFromForm() {
  const processUrl = $("#newCaseProcessUrl").value.trim();
  const officialUrl = officialProcessUrl(processUrl);
  const zipFile = $("#existingCaseZip")?.files?.[0] || null;
  if (processUrl && !officialUrl) {
    throw new Error("use um link completo e oficial do Judiciário em domínio jus.br, ou deixe o campo vazio e anexe o ZIP/PDF");
  }
  if (!officialUrl && !zipFile) {
    throw new Error("cole o link oficial ou anexe o ZIP/PDF exportado dos autos");
  }
  $("#newCaseStatus").textContent = zipFile ? "Criando dossiê e anexando arquivo..." : "Criando dossiê vinculado...";
  const extractedNumber = extractProcessNumber(processUrl);
  const data = await api("/api/cases", {
    method: "POST",
    body: JSON.stringify({
      case_type: "existing_claimant",
      title: $("#newCaseTitle").value || (extractedNumber ? `Processo ${extractedNumber}` : "Processo existente"),
      process_number: extractedNumber,
      process_source_url: officialUrl || "",
    }),
  });
  let createdCase = data.case;
  if (zipFile) {
    createdCase = await uploadFileToCase(data.case.id, zipFile, {
      document_type: zipFile.name.toLowerCase().endsWith(".zip") ? "ZIP dos autos" : suggestedDocumentType(zipFile.name),
      note: zipFile.name.toLowerCase().endsWith(".zip")
        ? "Pacote exportado pelo usuário. A leitura automática do ZIP ainda não está ativa; anexe também os PDFs/DOCX principais para análise."
        : "Arquivo exportado/anexado na criação do dossiê existente.",
    });
  }
  $("#existingCaseForm").reset();
  $("#existingZipSelection").textContent = "Nenhum arquivo selecionado";
  $("#newCasePanel").classList.add("hidden");
  state.selectedCase = createdCase;
  await loadCases();
  await openCase(data.case.id, zipFile ? "documents" : "overview");
}

async function createGuidedNewProcessCase() {
  $("#newProcessStartStatus").textContent = "Abrindo chat guiado...";
  const data = await api("/api/cases", {
    method: "POST",
    body: JSON.stringify({
      case_type: "new_claimant",
      title: `Novo processo ${new Date().toLocaleDateString("pt-BR")}`,
      start_mode: "guided_new_process",
    }),
  });
  $("#newCasePanel").classList.add("hidden");
  await loadCases();
  await openCase(data.case.id, "copilot");
}

async function updateSelectedCase(action, extra = {}) {
  if (!state.selectedCase) return;
  const data = await api("/api/cases/action", {
    method: "POST",
    body: JSON.stringify({ case_id: state.selectedCase.id, action, ...extra }),
  });
  state.selectedCase = data.case;
  renderCaseWorkspace();
  if ((action === "chat" || action === "rewrite_document_version") && caseAnalysisPending(data.case)) pollPendingCaseAnalysis(data.case.id);
}

async function refreshSelectedCase(caseId = state.selectedCase?.id || "") {
  if (!caseId || state.selectedCase?.id !== caseId) return;
  const data = await api(`/api/cases/${encodeURIComponent(caseId)}`);
  state.selectedCase = data.case;
  renderCaseWorkspace();
  await loadCases($("#caseSearch").value.trim());
}

async function runDuckdbQuery() {
  const status = $("#duckdbStatus");
  status.textContent = "Executando...";
  try {
    const data = await api("/api/admin/duckdb/query", {
      method: "POST",
      body: JSON.stringify({
        database: $("#duckdbDatabase").value,
        sql: $("#duckdbSql").value,
      }),
    });
    renderDuckdbResult(data);
    status.textContent = `OK · ${data.database} · ${data.db_path}`;
  } catch (err) {
    status.textContent = `Erro: ${err.message}`;
  }
}

function bindEvents() {
  $$(".nav-item").forEach((item) => item.addEventListener("click", () => setView(item.dataset.view)));
  $("#installPjeExtension")?.addEventListener("click", () => {
    const url = safeUrl(state.pjeExtension?.install_url || "");
    if (!url) {
      $("#processCenterStatus").textContent = "A extensão ainda precisa ser publicada na Chrome Web Store para instalar sem modo dev.";
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  });
  $("#refreshProcessCenter")?.addEventListener("click", () => loadProcessCenter({ refreshDatajud: true }).catch(renderProcessCenterError));
  $("#processCenterAddForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    addProcessCenterProcess().catch((err) => { $("#processCenterStatus").textContent = `Erro: ${err.message}`; });
  });
  $("#pjeAccountForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    createPjeAccount().catch((err) => { $("#pjeAccountStatus").textContent = `Erro: ${err.message}`; });
  });
  $("#pjeAccountRows")?.addEventListener("click", (event) => {
    const loginButton = event.target.closest("[data-pje-account-login]");
    if (loginButton) {
      loginButton.disabled = true;
      runPjeAccountAction(loginButton.dataset.pjeAccountLogin, "login")
        .catch((err) => { $("#pjeAccountStatus").textContent = `Erro: ${err.message}`; })
        .finally(() => { loginButton.disabled = false; });
      return;
    }
    const syncButton = event.target.closest("[data-pje-account-sync]");
    if (syncButton) {
      syncButton.disabled = true;
      runPjeAccountAction(syncButton.dataset.pjeAccountSync, "sync")
        .catch((err) => { $("#pjeAccountStatus").textContent = `Erro: ${err.message}`; })
        .finally(() => { syncButton.disabled = false; });
    }
  });
  $("#processCenterRows")?.addEventListener("click", (event) => {
    const deleteButton = event.target.closest("[data-center-delete-case]");
    if (deleteButton) {
      deleteButton.disabled = true;
      deleteCaseFromList(deleteButton.dataset.centerDeleteCase, { context: "processCenter" })
        .catch((err) => { $("#processCenterStatus").textContent = `Erro ao remover: ${err.message}`; })
        .finally(() => { deleteButton.disabled = false; });
      return;
    }
    const removeWatchButton = event.target.closest("[data-center-remove-watch]");
    if (removeWatchButton) {
      removeWatchButton.disabled = true;
      removeProcessWatchFromCenter(removeWatchButton.dataset.centerRemoveWatch)
        .catch((err) => { $("#processCenterStatus").textContent = `Erro ao remover: ${err.message}`; })
        .finally(() => { removeWatchButton.disabled = false; });
      return;
    }
    const openButton = event.target.closest("[data-center-open-case]");
    if (openButton) {
      openCaseFromCenter(openButton.dataset.centerOpenCase).catch((err) => { $("#processCenterStatus").textContent = `Erro ao abrir: ${err.message}`; });
      return;
    }
    const recollectButton = event.target.closest("[data-center-recollect-pje]");
    if (recollectButton) {
      recollectButton.disabled = true;
      openPjeCollectionForCase(recollectButton.dataset.centerRecollectPje)
        .catch((err) => { $("#processCenterStatus").textContent = `Erro ao abrir PJe: ${err.message}`; })
        .finally(() => { recollectButton.disabled = false; });
      return;
    }
    const createButton = event.target.closest("[data-center-create-case]");
    if (createButton) {
      createButton.disabled = true;
      createAndOpenCaseFromCenter(createButton.dataset.centerCreateCase)
        .catch((err) => { $("#processCenterStatus").textContent = `Erro ao criar dossiê: ${err.message}`; })
        .finally(() => { createButton.disabled = false; });
      return;
    }
    const timelineButton = event.target.closest("[data-process-center-timeline]");
    if (timelineButton) {
      selectProcessCenterTimeline(timelineButton.dataset.processCenterTimeline);
      return;
    }
    const calendarButton = event.target.closest("[data-google-calendar]");
    if (calendarButton?.dataset.googleCalendar) {
      window.open(calendarButton.dataset.googleCalendar, "_blank", "noopener,noreferrer");
    }
  });
  $("#processCenterTimelinePanel")?.addEventListener("click", (event) => {
    if (event.target.closest("[data-close-update-timeline]")) closeProcessCenterTimeline();
  });
  $("#processCenterNewCaseRows")?.addEventListener("click", (event) => {
    const deleteButton = event.target.closest("[data-center-delete-case]");
    if (deleteButton) {
      deleteButton.disabled = true;
      deleteCaseFromList(deleteButton.dataset.centerDeleteCase, { context: "processCenter" })
        .catch((err) => { $("#processCenterStatus").textContent = `Erro ao remover: ${err.message}`; })
        .finally(() => { deleteButton.disabled = false; });
      return;
    }
    const openButton = event.target.closest("[data-center-open-case]");
    if (openButton) openCaseFromCenter(openButton.dataset.centerOpenCase).catch((err) => { $("#processCenterStatus").textContent = `Erro ao abrir: ${err.message}`; });
  });
  $("#processCenterNewCase")?.addEventListener("click", () => {
    setView("processos");
    openNewCasePanel();
  });
  $("#refreshDocumentAnalysis")?.addEventListener("click", () => loadDocumentAnalysisHub().catch(renderDocumentAnalysisError));
  $("#startDocumentAnalysisHub")?.addEventListener("click", () => {
    createDocumentAnalysisCase().catch((err) => { $("#documentAnalysisMeta").textContent = `Erro: ${err.message}`; });
  });
  $("#documentAnalysisRows")?.addEventListener("click", (event) => {
    const deleteButton = event.target.closest("[data-document-analysis-delete]");
    if (deleteButton) {
      deleteButton.disabled = true;
      deleteCaseFromList(deleteButton.dataset.documentAnalysisDelete, { context: "documentAnalysis" })
        .catch((err) => { $("#documentAnalysisMeta").textContent = `Erro ao remover: ${err.message}`; })
        .finally(() => { deleteButton.disabled = false; });
      return;
    }
    const openButton = event.target.closest("[data-document-analysis-open]");
    if (openButton) openCaseFromCenter(openButton.dataset.documentAnalysisOpen, "documents").catch((err) => { $("#documentAnalysisMeta").textContent = `Erro ao abrir: ${err.message}`; });
  });
  $("#refreshInterviewCases").addEventListener("click", () => loadInterviewCases().catch((err) => setInterviewStatus(`Erro ao atualizar processos: ${err.message}`, "error")));
  $("#interviewCaseSelect").addEventListener("change", syncInterviewCaseSelection);
  $("#startInterviewRecording").addEventListener("click", startInterviewRecording);
  $("#stopInterviewRecording").addEventListener("click", stopInterviewRecording);
  $("#discardInterviewRecording").addEventListener("click", discardInterviewRecording);
  $("#uploadInterviewRecording").addEventListener("click", uploadInterviewRecording);
  $("#openNewCase")?.addEventListener("click", openNewCasePanel);
  $("#closeNewCase").addEventListener("click", closeNewCasePanel);
  $("#backToProcessCenterFromNewCase")?.addEventListener("click", returnToProcessCenter);
  $$(".case-start-card").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.caseStart === "new") {
        runCaseStartCard(button, createGuidedNewProcessCase, "Abrindo chat guiado...").catch(() => {});
      } else if (button.dataset.caseStart === "existing") {
        openCaseStartPanel("existing");
      } else {
        runCaseStartCard(button, createDocumentAnalysisCase, "Abrindo upload do documento...").catch(() => {});
      }
    });
  });
  $("#startDocumentAnalysis").addEventListener("click", () => {
    createDocumentAnalysisCase().catch((err) => { $("#documentStartStatus").textContent = `Erro: ${err.message}`; });
  });
  $("#startGuidedNewCase").addEventListener("click", () => {
    createGuidedNewProcessCase().catch((err) => { $("#newProcessStartStatus").textContent = `Erro: ${err.message}`; });
  });
  $("#existingCaseZip").addEventListener("change", (event) => {
    const file = event.target.files?.[0] || null;
    $("#existingZipSelection").textContent = file ? `${file.name} · ${fmtFileSize(file.size)}` : "Nenhum arquivo selecionado";
  });
  $("#newCaseProcessUrl").addEventListener("input", syncProcessLinkImportState);
  $("#openProcessCaptcha").addEventListener("click", openProcessCaptchaTab);
  $("#existingCaseForm").addEventListener("submit", (event) => {
    event.preventDefault();
    createExistingCaseFromForm().catch((err) => { $("#newCaseStatus").textContent = `Erro: ${err.message}`; });
  });
  let caseSearchTimer = null;
  $("#caseSearch").addEventListener("input", () => {
    clearTimeout(caseSearchTimer);
    caseSearchTimer = setTimeout(() => loadCases($("#caseSearch").value.trim()).catch(() => {}), 250);
  });
  $("#caseCards").addEventListener("click", (event) => {
    const deleteButton = event.target.closest("[data-delete-case]");
    if (deleteButton) {
      deleteButton.disabled = true;
      deleteCaseFromList(deleteButton.dataset.deleteCase)
        .catch((err) => { $("#caseListMeta").textContent = `Erro ao excluir: ${err.message}`; })
        .finally(() => { deleteButton.disabled = false; });
      return;
    }
    const openButton = event.target.closest("[data-open-case]");
    if (openButton) {
      openCase(openButton.dataset.openCase).catch((err) => { $("#caseListMeta").textContent = `Erro: ${err.message}`; });
      return;
    }
    const card = event.target.closest("[data-case-id]");
    if (card) openCase(card.dataset.caseId).catch((err) => { $("#caseListMeta").textContent = `Erro: ${err.message}`; });
  });
  $("#backToCases").addEventListener("click", closeCaseWorkspace);
  $(".case-tabs").addEventListener("click", (event) => {
    const button = event.target.closest("[data-case-tab]");
    if (button) setCaseTab(button.dataset.caseTab);
  });
  $("#caseWorkspace").addEventListener("click", (event) => {
    const button = event.target.closest("[data-case-tab-jump]");
    if (button) setCaseTab(button.dataset.caseTabJump);
    const sideButton = event.target.closest("[data-case-side]");
    if (sideButton) {
      sideButton.disabled = true;
      updateSelectedCase("set_representation_side", { representation_side: sideButton.dataset.caseSide })
        .catch((err) => { $("#caseNextAction").textContent = `Erro ao definir lado: ${err.message}`; })
        .finally(() => { sideButton.disabled = false; });
      return;
    }
    const recollectPje = event.target.closest("[data-case-recollect-pje]");
    if (recollectPje) {
      recollectPje.disabled = true;
      openPjeCollectionForCase(recollectPje.dataset.caseRecollectPje)
        .catch((err) => { $("#caseNextAction").textContent = `Erro ao abrir PJe: ${err.message}`; })
        .finally(() => { recollectPje.disabled = false; });
      return;
    }
    const importText = event.target.closest("[data-import-process-text]");
    if (importText) {
      const field = $("#processPageText");
      const pageText = field?.value.trim() || "";
      importText.disabled = true;
      importText.textContent = "Importando...";
      updateSelectedCase("import_process_page_text", { page_text: pageText })
        .catch((err) => {
          $("#caseNextAction").textContent = `Erro na importação: ${err.message}`;
        })
        .finally(() => {
          importText.disabled = false;
          importText.textContent = "Importar texto colado";
        });
      return;
    }
    const analyze = event.target.closest("[data-analyze-document]");
    if (analyze) {
      state.activeCaseDocumentId = analyze.dataset.analyzeDocument;
      renderCaseWorkspace();
      setCaseTab("copilot");
    }
    const deleteDocument = event.target.closest("[data-delete-document]");
    if (deleteDocument) {
      deleteDocument.disabled = true;
      deleteSelectedCaseDocument(deleteDocument.dataset.deleteDocument)
        .catch((err) => { $("#documentAreaStatus").textContent = `Erro ao remover: ${err.message}`; })
        .finally(() => { deleteDocument.disabled = false; });
      return;
    }
    const preview = event.target.closest("[data-preview-document]");
    if (preview) {
      openCaseDocumentPreview(preview.dataset.previewDocument, preview.dataset.previewVersion || "");
    }
    const download = event.target.closest("[data-download-document]");
    if (download) {
      download.disabled = true;
      downloadCaseDocument(download.dataset.downloadDocument, download.dataset.downloadVersion || "")
        .catch((err) => {
          const notice = $("#caseAnalysisNotice");
          notice.className = "analysis-notice error";
          notice.textContent = `Não foi possível baixar: ${err.message}`;
        })
        .finally(() => { download.disabled = false; });
    }
    const previewInterview = event.target.closest("[data-preview-interview]");
    if (previewInterview) {
      openInterviewTranscriptPreview(previewInterview.dataset.previewInterview);
    }
    const listenInterviewAudio = event.target.closest("[data-listen-interview-audio]");
    if (listenInterviewAudio) {
      listenInterviewAudio.disabled = true;
      toggleCaseInterviewAudio(listenInterviewAudio.dataset.listenInterviewAudio)
        .catch((err) => {
          const notice = $("#caseAnalysisNotice");
          notice.className = "analysis-notice error";
          notice.textContent = `Não foi possível carregar o áudio: ${err.message}`;
        })
        .finally(() => { listenInterviewAudio.disabled = false; });
    }
    const downloadInterviewTranscript = event.target.closest("[data-download-interview-transcript]");
    if (downloadInterviewTranscript) {
      downloadInterviewTranscript.disabled = true;
      downloadCaseInterviewArtifact(downloadInterviewTranscript.dataset.downloadInterviewTranscript, "transcript")
        .catch((err) => {
          const notice = $("#caseAnalysisNotice");
          notice.className = "analysis-notice error";
          notice.textContent = `Não foi possível baixar a transcrição: ${err.message}`;
        })
        .finally(() => { downloadInterviewTranscript.disabled = false; });
    }
    const downloadInterviewAudio = event.target.closest("[data-download-interview-audio]");
    if (downloadInterviewAudio) {
      downloadInterviewAudio.disabled = true;
      downloadCaseInterviewArtifact(downloadInterviewAudio.dataset.downloadInterviewAudio, "audio")
        .catch((err) => {
          const notice = $("#caseAnalysisNotice");
          notice.className = "analysis-notice error";
          notice.textContent = `Não foi possível baixar o áudio: ${err.message}`;
        })
        .finally(() => { downloadInterviewAudio.disabled = false; });
    }
    const rewrite = event.target.closest("[data-rewrite-document]");
    if (rewrite) {
      rewrite.disabled = true;
      rewrite.textContent = "Gerando versão...";
      updateSelectedCase("rewrite_document_version", {
        document_id: rewrite.dataset.rewriteDocument,
        source_message_id: rewrite.dataset.sourceMessage || "",
      })
        .catch((err) => {
          const notice = $("#caseAnalysisNotice");
          notice.className = "analysis-notice error";
          notice.textContent = `Não foi possível iniciar a reescrita: ${err.message}`;
        })
        .finally(() => {
          rewrite.disabled = false;
          rewrite.textContent = "Gerar nova versão";
        });
    }
    const promote = event.target.closest("[data-promote-document-version]");
    if (promote) {
      promote.disabled = true;
      promote.textContent = "Atualizando...";
      updateSelectedCase("promote_document_version", {
        document_id: promote.dataset.promoteDocument,
        version: promote.dataset.promoteDocumentVersion,
      })
        .then(() => {
          const notice = $("#caseAnalysisNotice");
          notice.className = "analysis-notice success";
          notice.textContent = `${promote.dataset.promoteDocumentVersion} agora é a versão principal.`;
        })
        .catch((err) => {
          const notice = $("#caseAnalysisNotice");
          notice.className = "analysis-notice error";
          notice.textContent = `Não foi possível promover a versão: ${err.message}`;
        })
        .finally(() => {
          promote.disabled = false;
          promote.textContent = "Usar como principal";
        });
    }
    const version = event.target.closest("[data-version-document]");
    if (version) {
      state.pendingDocumentVersionId = version.dataset.versionDocument;
      $("#caseVersionFile").value = "";
      $("#caseVersionFile").click();
    }
  });
  $("#caseWorkspace").addEventListener("change", (event) => {
    const activeSelect = event.target.closest("[data-active-document-select]");
    if (activeSelect) {
      state.activeCaseDocumentId = activeSelect.value;
      renderCaseWorkspace();
      setCaseTab("copilot");
    }
  });
  $("#caseTaskForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const label = $("#caseTaskInput").value.trim();
    if (!label) return;
    updateSelectedCase("add_task", { label }).then(() => { $("#caseTaskInput").value = ""; }).catch((err) => { $("#caseNextAction").textContent = `Erro: ${err.message}`; });
  });
  $("#timelineForm").addEventListener("submit", (event) => {
    event.preventDefault();
    updateSelectedCase("add_timeline", { date: $("#timelineDate").value, label: $("#timelineLabel").value }).then(() => { $("#timelineForm").reset(); }).catch((err) => { $("#caseNextAction").textContent = `Erro: ${err.message}`; });
  });
  $("#caseChecklist").addEventListener("change", (event) => {
    const input = event.target.closest("[data-checklist-id]");
    if (input) updateSelectedCase("toggle_checklist", { item_id: input.dataset.checklistId, checked: input.checked }).catch((err) => { $("#caseNextAction").textContent = `Erro: ${err.message}`; });
  });
  $("#toggleDocumentForm").addEventListener("click", () => {
    $("#documentForm").classList.toggle("hidden");
    if (!$("#documentForm").classList.contains("hidden")) $("#caseDocumentFile").focus();
  });
  $("#caseDocumentFile").addEventListener("change", (event) => selectCaseFiles(event.target.files || []));
  $("#caseVersionFile").addEventListener("change", (event) => {
    const file = event.target.files?.[0] || null;
    uploadCaseDocumentVersion(file, state.pendingDocumentVersionId)
      .catch((err) => {
        const notice = $("#caseAnalysisNotice");
        notice.className = "analysis-notice error";
        notice.textContent = `Não foi possível anexar a versão: ${err.message}`;
      })
      .finally(() => { state.pendingDocumentVersionId = ""; });
  });
  $("#caseUploadZone").addEventListener("dragover", (event) => {
    event.preventDefault();
    $("#caseUploadZone").classList.add("dragging");
  });
  $("#caseUploadZone").addEventListener("dragleave", () => $("#caseUploadZone").classList.remove("dragging"));
  $("#caseUploadZone").addEventListener("drop", (event) => {
    event.preventDefault();
    $("#caseUploadZone").classList.remove("dragging");
    selectCaseFiles(event.dataTransfer?.files || []);
  });
  $("#documentForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = $("#documentUploadStatus");
    const submit = $("#documentSubmit");
    const files = state.pendingCaseFiles.length ? state.pendingCaseFiles : (state.pendingCaseFile ? [state.pendingCaseFile] : []);
    if (!files.length) {
      status.textContent = "Selecione os PDFs/documentos dos autos antes de continuar.";
      status.className = "upload-status full error";
      return;
    }
    try {
      submit.disabled = true;
      submit.textContent = files.length === 1 ? "Enviando arquivo..." : `Enviando ${files.length} arquivos...`;
      status.className = "upload-status full loading";
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        status.textContent = `Lendo ${index + 1}/${files.length}: ${file.name}...`;
        const fileBase64 = await fileAsBase64(file);
        await updateSelectedCase("add_document", {
          name: file.name,
          mime_type: file.type,
          file_base64: fileBase64,
          document_type: files.length === 1 ? $("#documentType").value : suggestedDocumentType(file.name),
          period: $("#documentPeriod").value,
          related_party: $("#documentParty").value,
          note: $("#documentNote").value,
        });
      }
      state.activeCaseDocumentId = (state.selectedCase.documents || []).at(-1)?.id || "";
      $("#documentForm").reset();
      state.pendingCaseFile = null;
      state.pendingCaseFiles = [];
      $("#caseFileSelection").textContent = "Nenhum arquivo selecionado";
      status.textContent = files.length === 1
        ? `${files[0].name} foi salvo. Abrindo as opções de análise...`
        : `${files.length} documentos foram salvos. Abrindo o chat do processo...`;
      status.className = "upload-status full success";
      $("#documentForm").classList.add("hidden");
      setCaseTab("copilot");
    } catch (err) {
      status.textContent = `Não foi possível enviar: ${err.message}`;
      status.className = "upload-status full error";
    } finally {
      submit.disabled = false;
      submit.textContent = "Enviar e abrir análise";
    }
  });
  $("#toggleClaimForm").addEventListener("click", () => $("#claimForm").classList.toggle("hidden"));
  $("#claimForm").addEventListener("submit", (event) => {
    event.preventDefault();
    updateSelectedCase("add_claim", { title: $("#claimTitle").value, risk: $("#claimRisk").value, factual_basis: $("#claimFactualBasis").value, legal_theory: $("#claimTheory").value, risk_reason: $("#claimRiskReason").value }).then(() => { $("#claimForm").reset(); $("#claimForm").classList.add("hidden"); }).catch((err) => { $("#caseNextAction").textContent = `Erro: ${err.message}`; });
  });
  $("#pieceForm").addEventListener("submit", (event) => {
    event.preventDefault();
    updateSelectedCase("save_piece", { piece_type: $("#pieceType").value, change_note: $("#pieceChangeNote").value, content: $("#pieceContent").value, ai_assisted: $("#pieceAiAssisted").checked }).then(() => { $("#pieceChangeNote").value = ""; }).catch((err) => { $("#caseNextAction").textContent = `Erro: ${err.message}`; });
  });
  $(".copilot-prompts").addEventListener("click", (event) => {
    const button = event.target.closest("[data-case-prompt]");
    if (!button) return;
    button.disabled = true;
    const original = button.querySelector("strong")?.textContent || button.textContent;
    if (button.querySelector("strong")) button.querySelector("strong").textContent = "Analisando...";
    updateSelectedCase("chat", { message: button.dataset.casePrompt, document_id: activeCaseDocument()?.id || "" })
      .catch((err) => { $("#caseNextAction").textContent = `Erro: ${err.message}`; })
      .finally(() => {
        button.disabled = false;
        if (button.querySelector("strong")) button.querySelector("strong").textContent = original;
      });
  });
  $("#caseChatForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const message = $("#caseChatInput").value.trim();
    if (!message) return;
    $("#caseChatInput").value = "";
    updateSelectedCase("chat", { message, document_id: activeCaseDocument()?.id || "" }).catch((err) => { $("#caseNextAction").textContent = `Erro: ${err.message}`; });
  });
  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) return;
    const payload = event.data || {};
    if (payload.type === "justra-preview-ready") {
      try {
        event.source?.postMessage({ type: "justra-preview-auth", token: state.token || "" }, window.location.origin);
      } catch {
        /* janela de preview fechada ou indisponível */
      }
      return;
    }
    if (payload.type === "justra-case-updated" && payload.caseId) {
      refreshSelectedCase(payload.caseId).catch((err) => { $("#caseNextAction").textContent = `Erro ao atualizar: ${err.message}`; });
    }
  });
  $("#refreshJurimetrics").addEventListener("click", loadJurimetrics);
  ["periodFilter", "claimFilter", "courtFilter", "judgeFilter", "outcomeFilter"].forEach((id) => {
    $(`#${id}`).addEventListener("change", () => {
      state.offset = 0;
      loadJurimetrics();
    });
  });
  let queryTimer = null;
  $("#queryFilter").addEventListener("input", () => {
    clearTimeout(queryTimer);
    queryTimer = setTimeout(() => {
      state.offset = 0;
      loadJurimetrics();
    }, 300);
  });
  $("#prevPage").addEventListener("click", () => {
    state.offset = Math.max(0, state.offset - state.limit);
    loadJurimetrics();
  });
  $("#nextPage").addEventListener("click", () => {
    state.offset += state.limit;
    loadJurimetrics();
  });
  $("#chatForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("#chatInput");
    const message = input.value.trim();
    if (!message) return;
    input.value = "";
    askChat(message).catch((err) => {
      if (!handleQuotaError(err)) addMessage(err.message || String(err), "assistant");
    });
  });
  $("#clearChat").addEventListener("click", () => clearChat().catch((err) => addMessage(String(err), "assistant")));
  $("#toggleAudit").addEventListener("click", () => setAuditOpen($("#auditPanel").classList.contains("hidden")));
  $("#closeAudit").addEventListener("click", () => setAuditOpen(false));
  $("#newConversation").addEventListener("click", () => newConversation().catch((err) => {
    if (!handleQuotaError(err)) addMessage(err.message || String(err), "assistant");
  }));
  $("#chatQuota").addEventListener("click", () => setView("billing"));
  $("#planShortcut").addEventListener("click", () => setView("billing"));
  $("#upgradeButton").addEventListener("click", startCheckout);
  $("#manageBillingButton").addEventListener("click", () => openBillingPortal().catch((err) => setBillingNotice(err.message)));
  let conversationTimer = null;
  $("#conversationSearch").addEventListener("input", () => {
    clearTimeout(conversationTimer);
    conversationTimer = setTimeout(() => loadConversations($("#conversationSearch").value.trim()), 250);
  });
  $("#refreshBotHealth").addEventListener("click", loadBotHealth);
  $("#saveBotControls").addEventListener("click", saveBotControls);
  $("#refreshCoverage").addEventListener("click", loadCoverageMap);
  $("#refreshRadar").addEventListener("click", loadRadar);
  $("#radarForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const term = $("#radarTerm").value.trim();
    if (!term) return;
    createRadarMonitor(term).catch((err) => {
      if (!handleQuotaError(err)) $("#radarLimitText").textContent = `Erro: ${err.message}`;
    });
  });
  $("#radarMonitors").addEventListener("click", (event) => {
    const button = event.target.closest("[data-radar-action]");
    if (!button) return;
    const monitor = button.closest("[data-monitor-id]");
    radarMonitorAction(monitor?.dataset.monitorId || "", button.dataset.radarAction).catch((err) => {
      $("#radarLimitText").textContent = `Erro: ${err.message}`;
    });
  });
  $("#radarEvents").addEventListener("click", (event) => {
    if (event.target.closest("[data-radar-upgrade]")) setView("billing");
  });
  $("#refreshCollector").addEventListener("click", loadCollector);
  $("#enableCollector").addEventListener("click", () => setCollectorEnabled(true).catch((err) => {
    $("#collectorControlNote").textContent = `Erro: ${err.message}`;
  }));
  $("#pauseCollector").addEventListener("click", () => setCollectorEnabled(false).catch((err) => {
    $("#collectorControlNote").textContent = `Erro: ${err.message}`;
  }));
  $("#runCollectorNow").addEventListener("click", () => runCollectorNow().catch((err) => {
    $("#collectorControlNote").textContent = `Erro: ${err.message}`;
  }));
  $("#collectorTabD1").addEventListener("click", () => setCollectorTab("d1"));
  $("#collectorTabWindows").addEventListener("click", () => setCollectorTab("windows"));
  $("#saveCollectorPolicy").addEventListener("click", () => saveCollectorPolicy().catch((err) => {
    $("#collectorPolicyNote").textContent = `Erro: ${err.message}`;
  }));
  $("#runBackfillRange").addEventListener("click", () => {
    const startDate = $("#backfillStartDate").value;
    const endDate = $("#backfillEndDate").value;
    runBackfill(startDate, endDate).catch((err) => {
      $("#backfillRunNote").textContent = `Erro: ${err.message}`;
    });
  });
  $("#backfillWindowRows").addEventListener("click", (event) => {
    const button = event.target.closest("[data-window-date]");
    if (!button) return;
    const day = button.dataset.windowDate;
    runBackfill(day, day).catch((err) => {
      $("#backfillRunNote").textContent = `Erro: ${err.message}`;
    });
  });
  $("#refreshPjeOperator")?.addEventListener("click", () => loadPjeOperator().catch((err) => {
    $("#pjeOperatorNote").textContent = `Erro: ${err.message}`;
  }));
  $("#copyPjeAgentCommand")?.addEventListener("click", () => copyPjeAgentCommand());
  $("#pjeOperatorRows")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-pje-job-action]");
    if (!button) return;
    button.disabled = true;
    runPjeJobAction(button.dataset.pjeJobId, button.dataset.pjeJobAction)
      .catch((err) => {
        $("#pjeOperatorNote").textContent = `Erro: ${err.message}`;
      })
      .finally(() => {
        button.disabled = false;
      });
  });
  $("#refreshDjen").addEventListener("click", () => loadDjen().catch(() => {}));
  $("#enableDjen").addEventListener("click", () => setDjenEnabled(true).catch((err) => {
    $("#djenControlNote").textContent = `Erro: ${err.message}`;
  }));
  $("#pauseDjen").addEventListener("click", () => setDjenEnabled(false).catch((err) => {
    $("#djenControlNote").textContent = `Erro: ${err.message}`;
  }));
  $("#runDjenNow").addEventListener("click", () => runDjen({}).catch((err) => {
    $("#djenControlNote").textContent = `Erro: ${err.message}`;
  }));
  $("#runDjenDryRun").addEventListener("click", () => runDjen({ dry_run: true }).catch((err) => {
    $("#djenControlNote").textContent = `Erro: ${err.message}`;
  }));
  $("#retryDjenPending").addEventListener("click", () => runDjen({ retry_pending: true }).catch((err) => {
    $("#djenControlNote").textContent = `Erro: ${err.message}`;
  }));
  $("#refreshUpdates").addEventListener("click", () => loadUpdates().catch(() => {}));
  $("#refreshDatajud").addEventListener("click", () => refreshDatajudUpdates().catch((err) => {
    $("#updateWatchStatus").textContent = `Erro: ${err.message}`;
  }));
  $("#updateWatchForm").addEventListener("submit", (event) => {
    event.preventDefault();
    addUpdateWatch().catch((err) => {
      $("#updateWatchStatus").textContent = `Erro: ${err.message}`;
    });
  });
  $("#movementLawyerForm").addEventListener("submit", (event) => {
    event.preventDefault();
    searchMovementLawyer().catch((err) => {
      $("#movementLawyerStatus").textContent = `Erro: ${err.message}`;
    });
  });
  $("#updateWatchRows").addEventListener("click", (event) => {
    const button = event.target.closest("[data-update-timeline]");
    if (!button) return;
    selectUpdateTimeline(button.dataset.updateTimeline || "");
  });
  $("#updateTimelinePanel").addEventListener("click", (event) => {
    if (!event.target.closest("[data-close-update-timeline]")) return;
    closeUpdateTimeline();
  });
  $("#refreshDeadlines").addEventListener("click", () => loadDeadlines().catch(() => {}));
  $("#deadlineWatchForm").addEventListener("submit", (event) => {
    event.preventDefault();
    addDeadlineWatch().catch((err) => {
      $("#deadlineWatchStatus").textContent = `Erro: ${err.message}`;
    });
  });
  $("#lawyerDeadlineForm").addEventListener("submit", (event) => {
    event.preventDefault();
    searchLawyerDeadlines().catch((err) => {
      $("#lawyerDeadlineStatus").textContent = `Erro: ${err.message}`;
    });
  });
  $("#refreshDuckdb").addEventListener("click", loadDuckdbWorkbench);
  $("#runDuckdbQuery").addEventListener("click", runDuckdbQuery);
  $("#runDuckdbQueryBottom").addEventListener("click", runDuckdbQuery);
  $("#duckdbDatabase").addEventListener("change", renderDuckdbSchema);
  window.addEventListener("popstate", () => setView(initialView()));
  $("#logoutButton").addEventListener("click", () => {
    state.token = "";
    state.user = null;
    state.conversationId = "";
    localStorage.removeItem("justra_auth_token");
    localStorage.removeItem("justra_conversation_id");
    setAuthVisible(true);
  });
  $("#googleButton").addEventListener("click", startGoogleLogin);
}

async function loadAppData() {
  const view = initialView();
  renderMemory({});
  if (view === "billing") {
    await loadBilling();
    return;
  }
  ensureBilling().catch((err) => console.warn("billing preload failed", err));
  if (view === "chat") await loadChatShell();
  if (view === "jurimetria" && state.user?.role === "admin") await loadJurimetrics();
  if (view === "processos-v2") await loadProcessCenter().catch(renderProcessCenterError);
  if (view === "processos") await loadCases();
  if (view === "document-analysis") await loadDocumentAnalysisHub().catch(renderDocumentAnalysisError);
  if (view === "updates") await loadUpdates().catch(() => {});
  if (view === "deadlines") await loadDeadlines().catch(() => {});
  if (view === "entrevista") await loadInterviewCases();
  if (view === "bot") await loadBotHealth();
  if (view === "mapa") await loadCoverageMap();
  if (view === "radar") await loadRadar();
  if (view === "coleta") await loadCollector();
  if (view === "djen") await loadDjen().catch(() => {});
  if (view === "pje-operator") await loadPjeOperator().catch(() => {});
  if (view === "sql") await loadDuckdbWorkbench();
  if (state.user?.role === "admin" && view !== "pje-operator") {
    loadPjeOperator({ silent: true }).catch(() => {});
  }
}

async function init() {
  bindEvents();
  if (await completeGoogleLoginFromUrl()) return;
  setView(initialView());
  const googleConfigPromise = loadGoogleConfig();
  if (await checkAuth()) {
    await loadAppData();
  } else {
    await googleConfigPromise;
  }
}

init().catch((err) => {
  $("#dbStatus").textContent = "Erro";
  if (state.token) addMessage?.(String(err), "assistant");
  else setAuthMessage(String(err));
  console.error(err);
});

setInterval(() => {
  if (state.user?.role === "admin" && initialView() === "coleta") {
    loadCollector().catch(() => {});
  }
  if (state.user?.role === "admin" && initialView() === "djen") {
    loadDjen({ silent: true }).catch(() => {});
  }
}, 15_000);
