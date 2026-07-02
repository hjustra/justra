const params = new URLSearchParams(window.location.search);

function readStoredToken() {
  try {
    return localStorage.getItem("justra_auth_token") || "";
  } catch {
    return "";
  }
}

const state = {
  caseId: params.get("case_id") || "",
  documentId: params.get("document_id") || "",
  version: params.get("version") || "",
  token: readStoredToken(),
  preview: null,
  loadStarted: false,
  authTimeout: null,
};

const $ = (selector) => document.querySelector(selector);

const titleEl = $("#previewTitle");
const subtitleEl = $("#previewSubtitle");
const badgesEl = $("#previewBadges");
const noticeEl = $("#previewNotice");
const contentEl = $("#documentContent");
const statusEl = $("#versionStatus");
const hintEl = $("#versionHint");
const kindEl = $("#documentKind");
const sizeEl = $("#documentSize");
const closeButton = $("#closePreview");
const downloadButton = $("#downloadVersion");
const promoteButton = $("#promoteVersion");

function authHeaders(extra = {}) {
  return state.token ? { Authorization: `Bearer ${state.token}`, ...extra } : extra;
}

function versionedUrl(kind) {
  const query = new URLSearchParams();
  if (state.version) query.set("version", state.version);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return `/api/cases/${encodeURIComponent(state.caseId)}/documents/${encodeURIComponent(state.documentId)}/${kind}${suffix}`;
}

function setNotice(message, kind = "info") {
  noticeEl.textContent = message;
  noticeEl.className = `notice ${kind}`;
}

function setBadges(items) {
  badgesEl.replaceChildren();
  for (const item of items) {
    const badge = document.createElement("span");
    badge.className = `badge ${item.kind || ""}`.trim();
    badge.textContent = item.label;
    badgesEl.appendChild(badge);
  }
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (!bytes) return "Tamanho indisponível";
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(".0", "")} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".0", "")} MB`;
}

function fileKind(mimeType, name) {
  const lowerName = String(name || "").toLowerCase();
  const lowerMime = String(mimeType || "").toLowerCase();
  if (lowerName.endsWith(".docx") || lowerMime.includes("wordprocessingml")) return "DOCX";
  if (lowerName.endsWith(".doc") || lowerMime.includes("msword")) return "DOC";
  if (lowerName.endsWith(".pdf") || lowerMime.includes("pdf")) return "PDF";
  if (lowerName.endsWith(".txt") || lowerMime.includes("text/plain")) return "TXT";
  return "Documento";
}

function normalizeDocumentText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function headingScore(line) {
  const clean = String(line || "").trim();
  if (!clean || clean.length > 120) return 0;
  const letters = clean.replace(/[^A-Za-zÀ-ÖØ-öø-ÿ]/g, "");
  if (!letters) return 0;
  const uppercase = letters.replace(/[^A-ZÀ-ÖØ-Þ]/g, "").length;
  const ratio = uppercase / letters.length;
  if (/^(dos?|das?|pedido|pedidos|fatos|fundamentos|mérito|requerimentos|conclusão|provas|valor da causa)\b/i.test(clean)) return 2;
  if (/^\d+[\). -]+[A-ZÀ-ÖØ-Þ]/.test(clean) && clean.length <= 90) return 2;
  if (ratio > 0.74 && clean.length <= 95) return 2;
  return 0;
}

function appendParagraph(parent, text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return;
  const paragraph = document.createElement("p");
  paragraph.textContent = clean;
  parent.appendChild(paragraph);
}

function appendClause(parent, label, text) {
  const clause = document.createElement("div");
  clause.className = "clause";
  const clauseLabel = document.createElement("span");
  clauseLabel.className = "clause-label";
  clauseLabel.textContent = label;
  const clauseText = document.createElement("span");
  clauseText.textContent = text;
  clause.append(clauseLabel, clauseText);
  parent.appendChild(clause);
}

function renderDocumentText(rawText) {
  const text = normalizeDocumentText(rawText);
  contentEl.replaceChildren();
  contentEl.className = "document-content";
  if (!text) {
    const empty = document.createElement("div");
    empty.className = "empty-document";
    empty.textContent = "Não encontrei texto pesquisável para mostrar nesta versão.";
    contentEl.appendChild(empty);
    return;
  }

  const blocks = text.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const fragment = document.createDocumentFragment();

  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.length) continue;

    if (lines.length === 1 && headingScore(lines[0])) {
      const heading = document.createElement("h2");
      heading.textContent = lines[0].replace(/[:.]+$/, "");
      fragment.appendChild(heading);
      continue;
    }

    if (lines.length > 1 && headingScore(lines[0])) {
      const heading = document.createElement("h2");
      heading.textContent = lines[0].replace(/[:.]+$/, "");
      fragment.appendChild(heading);
      appendParagraph(fragment, lines.slice(1).join(" "));
      continue;
    }

    const clauseLines = lines
      .map((line) => line.match(/^((?:\d+|[a-zA-Z])[\).])\s+(.{8,})$/))
      .filter(Boolean);
    if (lines.length > 1 && clauseLines.length === lines.length) {
      for (const match of clauseLines) appendClause(fragment, match[1], match[2]);
      continue;
    }

    appendParagraph(fragment, lines.join(" "));
  }

  contentEl.appendChild(fragment);
}

function updateButtonsForPreview(preview) {
  downloadButton.disabled = false;
  if (!state.version || preview.is_current) {
    promoteButton.disabled = true;
    promoteButton.textContent = preview.is_current ? "Já é principal" : "Versão principal";
    return;
  }
  promoteButton.disabled = false;
  promoteButton.textContent = "Usar como principal";
}

function renderPreview(preview) {
  state.preview = preview;
  const versionLabel = preview.version || state.version || "principal";
  const displayName = preview.name || "Documento";
  document.title = `Preview ${versionLabel} · Justra`;
  titleEl.textContent = displayName;
  subtitleEl.textContent = `Versão ${versionLabel} para conferência rápida antes de baixar ou promover.`;
  statusEl.textContent = preview.is_current ? "Versão principal" : "Versão sugerida";
  hintEl.textContent = preview.generated_by_ai
    ? "Gerada pela IA e preservada no histórico até você decidir promovê-la."
    : "Arquivo enviado ou versão preservada no histórico do processo.";
  kindEl.textContent = fileKind(preview.mime_type, preview.name);
  sizeEl.textContent = formatBytes(preview.size_bytes);
  setBadges([
    { label: `Versão ${versionLabel}` },
    { label: preview.is_current ? "Principal atual" : "Ainda não é principal", kind: preview.is_current ? "" : "warn" },
    ...(preview.generated_by_ai ? [{ label: "Gerada por IA" }] : []),
  ]);
  setNotice("Preview carregado. Baixe o DOCX para revisar a formatação final antes de protocolar.", "info");
  renderDocumentText(preview.content);
  updateButtonsForPreview(preview);
}

async function loadPreview() {
  if (!state.caseId || !state.documentId) {
    throw new Error("Link de preview incompleto. Reabra o preview pela tela do processo.");
  }
  if (!state.token) {
    throw new Error("Sua sessão não está ativa nesta janela. Volte para a Justra, faça login e abra o preview novamente.");
  }
  const response = await fetch(versionedUrl("preview"), { headers: authHeaders() });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Não foi possível abrir o preview.");
  renderPreview(data.preview || {});
}

function showFatalError(error) {
  titleEl.textContent = "Preview indisponível";
  subtitleEl.textContent = "Não consegui carregar o conteúdo desta versão.";
  statusEl.textContent = "Erro no preview";
  hintEl.textContent = error.message;
  setBadges([{ label: "Falha ao carregar", kind: "warn" }]);
  setNotice(error.message, "error");
  contentEl.className = "empty-document";
  contentEl.textContent = "Tente reabrir o preview pela tela do processo. Se o arquivo for digitalizado, talvez precise de OCR.";
  downloadButton.disabled = true;
  promoteButton.disabled = true;
}

function startPreviewLoad() {
  if (state.loadStarted) return;
  state.loadStarted = true;
  if (state.authTimeout) window.clearTimeout(state.authTimeout);
  loadPreview().catch(showFatalError);
}

async function downloadVersion() {
  downloadButton.disabled = true;
  downloadButton.textContent = "Baixando...";
  try {
    const response = await fetch(versionedUrl("download"), { headers: authHeaders() });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "Não foi possível baixar esta versão.");
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = state.preview?.name || "documento.docx";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setNotice("Download iniciado. Revise o arquivo antes de protocolar.", "success");
  } catch (error) {
    setNotice(`Não consegui baixar: ${error.message}`, "error");
  } finally {
    downloadButton.disabled = false;
    downloadButton.textContent = "Baixar versão";
  }
}

async function promoteVersion() {
  if (!state.version || !state.preview) return;
  promoteButton.disabled = true;
  promoteButton.textContent = "Atualizando...";
  try {
    const response = await fetch("/api/cases/action", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        case_id: state.caseId,
        action: "promote_document_version",
        document_id: state.documentId,
        version: state.version,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Não foi possível usar esta versão como principal.");
    state.preview = { ...state.preview, is_current: true };
    renderPreview(state.preview);
    setNotice("Pronto. Esta versão agora é a principal; as anteriores continuam preservadas no histórico.", "success");
    promoteButton.disabled = true;
    promoteButton.textContent = "Versão principal";
    window.opener?.postMessage({ type: "justra-case-updated", caseId: state.caseId }, window.location.origin);
  } catch (error) {
    setNotice(`Não consegui promover a versão: ${error.message}`, "error");
    promoteButton.disabled = false;
    promoteButton.textContent = "Usar como principal";
  }
}

function closePreview() {
  window.close();
  if (!window.closed) window.location.href = "/processos";
}

closeButton.addEventListener("click", closePreview);
downloadButton.addEventListener("click", downloadVersion);
promoteButton.addEventListener("click", promoteVersion);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closePreview();
});

window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin) return;
  const data = event.data || {};
  if (data.type !== "justra-preview-auth" || !data.token) return;
  state.token = String(data.token);
  try {
    localStorage.setItem("justra_auth_token", state.token);
  } catch {
    /* storage indisponível; o token em memória basta para esta janela */
  }
  startPreviewLoad();
});

try {
  window.opener?.postMessage({ type: "justra-preview-ready" }, window.location.origin);
} catch {
  /* aberta sem janela principal */
}

if (state.token) {
  startPreviewLoad();
} else {
  setNotice("Aguardando autenticação da janela principal da Justra...", "info");
  statusEl.textContent = "Aguardando sessão";
  hintEl.textContent = "Se esta aba foi aberta diretamente, volte ao processo e use o botão Preview.";
  state.authTimeout = window.setTimeout(() => {
    if (!state.loadStarted) {
      showFatalError(new Error("Sua sessão não chegou nesta janela. Reabra o preview pela tela do processo."));
    }
  }, 5000);
}
