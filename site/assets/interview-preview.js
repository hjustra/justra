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
  interviewId: params.get("interview_id") || "",
  token: readStoredToken(),
  preview: null,
  loadStarted: false,
  authTimeout: null,
  audioUrl: "",
  audioVisible: false,
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
const listenButton = $("#listenAudio");
const transcriptButton = $("#downloadTranscript");
const audioButton = $("#downloadAudio");
const audioBox = $("#audioPreviewBox");
const audioEl = $("#audioPreview");

function authHeaders(extra = {}) {
  return state.token ? { Authorization: `Bearer ${state.token}`, ...extra } : extra;
}

function interviewUrl(kind) {
  return `/api/cases/${encodeURIComponent(state.caseId)}/interviews/${encodeURIComponent(state.interviewId)}/${kind}`;
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

function fmtMoment(value) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

function audioKind(mimeType, name) {
  const lowerName = String(name || "").toLowerCase();
  const lowerMime = String(mimeType || "").toLowerCase();
  if (lowerName.endsWith(".mp3") || lowerMime.includes("mpeg")) return "MP3";
  if (lowerName.endsWith(".wav") || lowerMime.includes("wav")) return "WAV";
  if (lowerName.endsWith(".m4a") || lowerName.endsWith(".mp4") || lowerMime.includes("mp4")) return "M4A/MP4";
  if (lowerName.endsWith(".webm") || lowerMime.includes("webm")) return "WEBM";
  return "Áudio";
}

function sideLabel(value) {
  if (value === "claimant") return "Reclamante";
  if (value === "defendant") return "Reclamado";
  return "Lado não definido";
}

function normalizeTranscript(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function appendTranscriptParagraph(parent, value) {
  const clean = String(value || "").replace(/[ \t]{2,}/g, " ").trim();
  if (!clean) return;
  const paragraph = document.createElement("p");
  paragraph.textContent = clean;
  parent.appendChild(paragraph);
}

function renderTranscript(rawText) {
  const text = normalizeTranscript(rawText);
  contentEl.replaceChildren();
  contentEl.className = "document-content";
  if (!text) {
    contentEl.className = "empty-document";
    contentEl.textContent = "Não encontrei transcrição para mostrar.";
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const block of text.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean)) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    if (lines.length === 1 && /^[A-ZÀ-ÖØ-Þ0-9 .:-]{4,80}$/.test(lines[0])) {
      const heading = document.createElement("h2");
      heading.textContent = lines[0].replace(/[:.]+$/, "");
      fragment.appendChild(heading);
      continue;
    }
    appendTranscriptParagraph(fragment, lines.join(" "));
  }
  contentEl.appendChild(fragment);
}

function renderPreview(preview) {
  state.preview = preview;
  const displayName = preview.name || "Entrevista";
  document.title = `Transcrição · ${displayName}`;
  titleEl.textContent = displayName;
  subtitleEl.textContent = `${preview.case_title || "Dossiê"}${preview.created_at ? ` · ${fmtMoment(preview.created_at)}` : ""}`;
  statusEl.textContent = preview.transcript_status || "Transcrição disponível";
  hintEl.textContent = "Transcrição completa preservada no dossiê. Use como insumo de trabalho, com revisão humana.";
  kindEl.textContent = audioKind(preview.mime_type, preview.name);
  sizeEl.textContent = formatBytes(preview.size_bytes);
  setBadges([
    { label: preview.transcript_status || "Transcrita" },
    { label: sideLabel(preview.representation_side) },
    ...(preview.created_at ? [{ label: fmtMoment(preview.created_at) }] : []),
  ]);
  setNotice("Preview carregado. Você pode baixar a transcrição completa ou o áudio original.", "success");
  renderTranscript(preview.content);
  listenButton.disabled = false;
  transcriptButton.disabled = false;
  audioButton.disabled = false;
}

async function loadPreview() {
  if (!state.caseId || !state.interviewId) {
    throw new Error("Link de preview incompleto. Reabra a transcrição pela tela do processo.");
  }
  if (!state.token) {
    throw new Error("Sua sessão não está ativa nesta janela. Volte para a Justra, faça login e abra o preview novamente.");
  }
  const response = await fetch(interviewUrl("preview"), { headers: authHeaders() });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Não foi possível abrir a transcrição.");
  renderPreview(data.preview || {});
}

function showFatalError(error) {
  titleEl.textContent = "Transcrição indisponível";
  subtitleEl.textContent = "Não consegui carregar a transcrição desta entrevista.";
  statusEl.textContent = "Erro no preview";
  hintEl.textContent = error.message;
  setBadges([{ label: "Falha ao carregar", kind: "warn" }]);
  setNotice(error.message, "error");
  contentEl.className = "empty-document";
  contentEl.textContent = "Tente reabrir pela tela do processo. Se a transcrição ainda estiver pendente, baixe o áudio original.";
  listenButton.disabled = !state.interviewId;
  transcriptButton.disabled = true;
  audioButton.disabled = !state.interviewId;
}

function startPreviewLoad() {
  if (state.loadStarted) return;
  state.loadStarted = true;
  if (state.authTimeout) window.clearTimeout(state.authTimeout);
  loadPreview().catch(showFatalError);
}

function filenameFromDisposition(header, fallback) {
  const match = String(header || "").match(/filename=\"?([^\";]+)\"?/i);
  return match ? decodeURIComponent(match[1]) : fallback;
}

async function downloadArtifact(kind) {
  const button = kind === "audio" ? audioButton : transcriptButton;
  const previousText = button.textContent;
  button.disabled = true;
  button.textContent = "Baixando...";
  try {
    const response = await fetch(interviewUrl(`${kind}/download`), { headers: authHeaders() });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "Não foi possível baixar este arquivo.");
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filenameFromDisposition(
      response.headers.get("Content-Disposition"),
      kind === "audio" ? (state.preview?.name || "entrevista.webm") : "transcricao-entrevista.txt",
    );
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setNotice("Download iniciado.", "success");
  } catch (error) {
    setNotice(`Não consegui baixar: ${error.message}`, "error");
  } finally {
    button.disabled = false;
    button.textContent = previousText;
  }
}

async function ensureAudioUrl() {
  if (state.audioUrl) return state.audioUrl;
  const response = await fetch(interviewUrl("playback-url"), { headers: authHeaders() });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Não foi possível carregar o áudio original.");
  }
  const data = await response.json().catch(() => ({}));
  if (!data.url) throw new Error("Não foi possível preparar o link de áudio.");
  state.audioUrl = data.url;
  return state.audioUrl;
}

async function toggleAudioPreview() {
  if (state.audioVisible) {
    state.audioVisible = false;
    audioBox.classList.add("hidden");
    audioEl.pause();
    listenButton.textContent = "Ouvir áudio";
    return;
  }
  const previousText = listenButton.textContent;
  listenButton.disabled = true;
  listenButton.textContent = "Carregando...";
  try {
    audioEl.src = await ensureAudioUrl();
    audioBox.classList.remove("hidden");
    state.audioVisible = true;
    listenButton.textContent = "Ocultar áudio";
    audioEl.play().catch(() => {});
  } catch (error) {
    listenButton.textContent = previousText;
    setNotice(`Não consegui carregar o áudio: ${error.message}`, "error");
  } finally {
    listenButton.disabled = false;
  }
}

function closePreview() {
  window.close();
  if (!window.closed) window.location.href = "/processos";
}

closeButton.addEventListener("click", closePreview);
listenButton.addEventListener("click", toggleAudioPreview);
transcriptButton.addEventListener("click", () => downloadArtifact("transcript"));
audioButton.addEventListener("click", () => downloadArtifact("audio"));
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
    /* storage indisponível; o token em memória basta */
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
  hintEl.textContent = "Se esta aba foi aberta diretamente, volte ao processo e use o botão Ver transcrição.";
  state.authTimeout = window.setTimeout(() => {
    if (!state.loadStarted) {
      showFatalError(new Error("Sua sessão não chegou nesta janela. Reabra o preview pela tela do processo."));
    }
  }, 5000);
}
