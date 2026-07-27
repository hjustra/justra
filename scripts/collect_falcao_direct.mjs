import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const DATA_ROOT = path.resolve(process.env.JUSTRA_DATA_DIR || path.join(ROOT, "data"));
const CODEX_NODE_MODULES =
  "/Users/heitordoamaraljurkovich/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const RUNTIME_NODE_MODULES =
  process.env.JUSTRA_NODE_MODULES ||
  (fs.existsSync(CODEX_NODE_MODULES) ? CODEX_NODE_MODULES : path.join(ROOT, "node_modules"));
const require = createRequire(path.join(RUNTIME_NODE_MODULES, "package.json"));
const { chromium } = require("playwright");

const FRONTEND_URL =
  "https://jurisprudencia.jt.jus.br/jurisprudencia-nacional/pesquisa";
const API_ORIGIN = "https://jurisprudencia.jt.jus.br";
const API_PATHS = {
  "no-auth": "/jurisprudencia-nacional-backend/api/no-auth/pesquisa",
  frontend: "/jurisprudencia-nacional-backend/api/frontend/pesquisa",
};
const CITATION_BASE =
  "https://jurisprudencia.jt.jus.br/jurisprudencia-nacional/citacao";
const DEFAULT_CHROME_PATH =
  process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "";
const CHROME_PATH = process.env.JUSTRA_CHROME_PATH || DEFAULT_CHROME_PATH;
const MAX_ANONYMOUS_DOCUMENTS = 200;
const REQUEST_TIMEOUT_MS = 90_000;

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

function browserLaunchOptions(headed, extra = {}) {
  const options = { ...extra, headless: !headed };
  if (CHROME_PATH) options.executablePath = CHROME_PATH;
  return options;
}

async function newBrowserContext(args) {
  if (args.connectCdp) {
    const browser = await chromium.connectOverCDP(args.connectCdp);
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error(`Nenhum contexto de navegador disponível em ${args.connectCdp}.`);
    }
    return {
      browser,
      context,
      persistent: false,
      remoteCdp: true,
      userDataDir: "",
      closeContext: false,
      disconnectBrowser: true,
    };
  }

  const headed = Boolean(args.headed || args.authSetup);
  const launchOptions = browserLaunchOptions(headed, { timeout: 90_000 });
  if (args.userDataDir) {
    const userDataDir = path.resolve(args.userDataDir);
    fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
    const context = await chromium.launchPersistentContext(userDataDir, {
      ...launchOptions,
      locale: "pt-BR",
      viewport: { width: 1440, height: 1000 },
    });
    return { browser: null, context, persistent: true, userDataDir };
  }
  const browser = await chromium.launch(launchOptions);
  const chromeVersion = browser.version();
  const context = await browser.newContext({
    locale: "pt-BR",
    userAgent:
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ` +
      `AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`,
  });
  return { browser, context, persistent: false, userDataDir: "" };
}

async function waitForInteractiveAuth(page, args) {
  console.log(
    JSON.stringify(
      {
        event: "falcao_auth_setup_started",
        frontend_url: FRONTEND_URL,
        user_data_dir: path.resolve(args.userDataDir),
        wait_minutes: args.authWaitMinutes,
        instructions:
          "Faça login no navegador aberto. Quando terminar, volte ao terminal e pressione Enter; se não pressionar, encerro no timeout.",
      },
      null,
      2,
    ),
  );
  const timeoutMs = Math.round(args.authWaitMinutes * 60_000);
  if (!process.stdin.isTTY) {
    await sleep(timeoutMs);
    return;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    await Promise.race([
      rl.question("Depois de concluir o login no Falcão/gov.br, pressione Enter para salvar a sessão..."),
      sleep(timeoutMs),
    ]);
  } finally {
    rl.close();
  }
  await page.waitForTimeout(1_000);
}

const COLLECTIONS = [
  { id: "acordaos", label: "Acórdãos", idField: "idDocumentoAcordao" },
  {
    id: "decisoesmonocraticas",
    label: "Decisões Monocráticas",
    idField: "idDocumento",
  },
  { id: "sentencas", label: "Sentenças", idField: "idSentenca" },
  {
    id: "recursorevista",
    label: "Admissibilidade de Recurso de Revista",
    idField: "idRecursoRevista",
  },
  { id: "precedentes", label: "Precedentes", idField: "id" },
];

const FACETS = [
  {
    param: "tribunais",
    label: "Tribunal",
    aliases: ["tribunal", "tribunais"],
  },
  {
    param: "orgaoJulgador",
    label: "Órgão Julgador",
    aliases: ["orgaojulgador", "orgao julgador"],
  },
  {
    param: "nomeRelator",
    label: "Magistrada / Magistrado",
    aliases: ["nomerelator", "relator", "magistrado", "magistrada magistrado"],
  },
  {
    param: "classeProcesso",
    label: "Classe",
    aliases: ["classeprocesso", "classe"],
  },
];

function parseArgs(argv) {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const args = {
    startDate: yesterday,
    endDate: yesterday,
    pageSize: 10,
    minDelayMs: 30_000,
    maxDelayMs: 90_000,
    requestBudget: 0,
    documentLimit: Number(process.env.FALCAO_DOCUMENT_LIMIT || 0),
    nonBlockRetries: 2,
    minimumBlockFreeMinutes: 0,
    blockCooldownMinutes: 2_880,
    outputTag: `daily_${yesterday}`,
    controlPath: "",
    collections: COLLECTIONS.map((item) => item.id),
    headed: false,
    connectCdp: process.env.FALCAO_CDP_ENDPOINT || "",
    userDataDir: process.env.FALCAO_USER_DATA_DIR || "",
    authSetup: false,
    authWaitMinutes: 15,
    apiMode: process.env.FALCAO_API_MODE || "no-auth",
    apiPath: process.env.FALCAO_API_PATH || "",
    fallbackNoAuth: envFlag("FALCAO_FALLBACK_NO_AUTH", false),
    validateOnly: false,
    mode: "d-1",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--start-date") args.startDate = argv[++index];
    else if (value === "--end-date") args.endDate = argv[++index];
    else if (value === "--page-size") args.pageSize = Number(argv[++index]);
    else if (value === "--min-delay-ms") args.minDelayMs = Number(argv[++index]);
    else if (value === "--max-delay-ms") args.maxDelayMs = Number(argv[++index]);
    else if (value === "--sleep-ms") args.minDelayMs = Number(argv[++index]);
    else if (value === "--jitter-ms") {
      args.maxDelayMs = args.minDelayMs + Number(argv[++index]);
    } else if (value === "--request-budget") {
      args.requestBudget = Number(argv[++index]);
    } else if (value === "--document-limit") {
      args.documentLimit = Number(argv[++index]);
    } else if (value === "--non-block-retries") {
      args.nonBlockRetries = Number(argv[++index]);
    } else if (value === "--minimum-block-free-minutes") {
      args.minimumBlockFreeMinutes = Number(argv[++index]);
    } else if (value === "--block-cooldown-minutes") {
      args.blockCooldownMinutes = Number(argv[++index]);
    } else if (value === "--output-tag") args.outputTag = argv[++index];
    else if (value === "--control-path") args.controlPath = argv[++index];
    else if (value === "--connect-cdp") args.connectCdp = argv[++index];
    else if (value === "--user-data-dir") args.userDataDir = argv[++index];
    else if (value === "--auth-setup") args.authSetup = true;
    else if (value === "--auth-wait-minutes") args.authWaitMinutes = Number(argv[++index]);
    else if (value === "--collections") {
      args.collections = argv[++index].split(",").filter(Boolean);
    } else if (value === "--headed") args.headed = true;
    else if (value === "--headless") args.headed = false;
    else if (value === "--api-mode") args.apiMode = argv[++index];
    else if (value === "--api-path") args.apiPath = argv[++index];
    else if (value === "--fallback-no-auth") args.fallbackNoAuth = true;
    else if (value === "--no-fallback-no-auth") args.fallbackNoAuth = false;
    else if (value === "--validate-only") args.validateOnly = true;
    else if (value === "--mode") args.mode = argv[++index];
    // Compatibilidade com o wrapper antigo. O motor direto não usa estes controles.
    else if (["--rest-every", "--rest-ms", "--cooldown-minutes"].includes(value)) index += 1;
    else if (value === "--wait-for-cooldown") continue;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.startDate)) {
    throw new Error("--start-date deve usar YYYY-MM-DD.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.endDate)) {
    throw new Error("--end-date deve usar YYYY-MM-DD.");
  }
  if (args.startDate > args.endDate) {
    throw new Error("--start-date não pode ser posterior a --end-date.");
  }
  if (args.pageSize !== 10) {
    throw new Error("O acesso anônimo deve usar --page-size 10.");
  }
  for (const [name, number] of Object.entries({
    minDelayMs: args.minDelayMs,
    maxDelayMs: args.maxDelayMs,
    requestBudget: args.requestBudget,
    documentLimit: args.documentLimit,
    nonBlockRetries: args.nonBlockRetries,
    minimumBlockFreeMinutes: args.minimumBlockFreeMinutes,
    authWaitMinutes: args.authWaitMinutes,
  })) {
    if (!Number.isFinite(number) || number < 0) {
      throw new Error(`${name} deve ser um número não negativo.`);
    }
  }
  if (args.minDelayMs > args.maxDelayMs) {
    throw new Error("--min-delay-ms não pode superar --max-delay-ms.");
  }
  if (!Number.isInteger(args.nonBlockRetries) || args.nonBlockRetries < 0 || args.nonBlockRetries > 5) {
    throw new Error("--non-block-retries deve ser um inteiro entre 0 e 5.");
  }
  if (!Number.isInteger(args.documentLimit)) {
    throw new Error("--document-limit deve ser um inteiro não negativo.");
  }
  if (!Number.isFinite(args.authWaitMinutes) || args.authWaitMinutes < 1 || args.authWaitMinutes > 120) {
    throw new Error("--auth-wait-minutes deve ficar entre 1 e 120.");
  }
  if (args.authSetup && !args.userDataDir) {
    throw new Error("--auth-setup exige --user-data-dir para salvar a sessão.");
  }
  if (args.authSetup && args.connectCdp) {
    throw new Error("--auth-setup não deve ser usado junto com --connect-cdp.");
  }
  if (!Object.prototype.hasOwnProperty.call(API_PATHS, args.apiMode)) {
    throw new Error("--api-mode deve ser no-auth ou frontend.");
  }
  if (args.apiPath && !args.apiPath.startsWith("/jurisprudencia-nacional-backend/api/")) {
    throw new Error("--api-path deve apontar para a API interna do Falcão.");
  }
  args.apiPath = args.apiPath || API_PATHS[args.apiMode];
  const known = new Set(COLLECTIONS.map((item) => item.id));
  for (const collection of args.collections) {
    if (!known.has(collection)) throw new Error(`Coleção desconhecida: ${collection}`);
  }
  return args;
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(lower, upper) {
  if (upper <= lower) return lower;
  return lower + Math.floor(Math.random() * (upper - lower + 1));
}

function dateRange(startDate, endDate) {
  const dates = [];
  let cursor = new Date(`${startDate}T12:00:00Z`);
  const end = new Date(`${endDate}T12:00:00Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + 86_400_000);
  }
  return dates;
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, filePath);
}

function appendJsonl(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function sessionId() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let value = "_";
  for (let index = 0; index < 7; index += 1) {
    value += alphabet[crypto.randomInt(alphabet.length)];
  }
  return value;
}

function normalizedName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase();
}

function documentId(collection, document) {
  return String(
    document?.[collection.idField] || document?.id || document?.idTema || "",
  ).trim();
}

function documentKey(collection, document) {
  const id = documentId(collection, document);
  const tribunal = String(document?.tribunal || "sem-tribunal").toUpperCase();
  if (id) return `${collection.id}:${tribunal}:${id}`;
  return `${collection.id}:sha256:${crypto
    .createHash("sha256")
    .update(JSON.stringify(document))
    .digest("hex")}`;
}

function citationUrl(collection, document) {
  const id = documentId(collection, document);
  if (!id || !document?.tribunal) return "";
  return `${CITATION_BASE}/${encodeURIComponent(collection.id)}/${encodeURIComponent(
    document.tribunal,
  )}/${encodeURIComponent(id)}`;
}

function filterKey(filters) {
  if (!filters.length) return "root";
  return filters.map((item) => `${item.param}=${item.value}`).join("|");
}

function partitionKey(date, collection, filters) {
  return `${date}|${collection.id}|${filterKey(filters)}`;
}

function filterHash(filters) {
  return crypto.createHash("sha1").update(filterKey(filters)).digest("hex").slice(0, 12);
}

class BlockedError extends Error {}
class HttpResponseError extends Error {
  constructor(response) {
    super(`Falcão respondeu HTTP ${response.status}.`);
    this.status = response.status;
    this.url = response.url;
    this.body = response.body || "";
  }
}
class RequestBudgetReached extends Error {}
class DocumentLimitReached extends Error {}
class PausedError extends Error {}

function pickTokenCandidate(value) {
  if (!value) return "";
  const text = String(value);
  if (text.startsWith("Bearer ")) return text.slice("Bearer ".length).trim();
  const jwt = text.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  return jwt ? jwt[0] : "";
}

async function authHeadersFromPage(page) {
  const token = await page.evaluate(() => {
    function candidate(value) {
      if (!value) return "";
      const text = String(value);
      if (text.startsWith("Bearer ")) return text.slice("Bearer ".length).trim();
      const jwt = text.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
      return jwt ? jwt[0] : "";
    }

    function fromParsed(value, depth = 0) {
      if (depth > 6 || value == null) return "";
      if (typeof value === "string") return candidate(value);
      if (typeof value !== "object") return "";

      const preferredKeys = [
        "access_token",
        "accessToken",
        "token",
        "id_token",
        "idToken",
      ];
      for (const key of preferredKeys) {
        const found = fromParsed(value[key], depth + 1);
        if (found) return found;
      }
      for (const nested of Object.values(value)) {
        const found = fromParsed(nested, depth + 1);
        if (found) return found;
      }
      return "";
    }

    const stores = [window.localStorage, window.sessionStorage];
    for (const store of stores) {
      for (let index = 0; index < store.length; index += 1) {
        const key = store.key(index);
        const raw = key ? store.getItem(key) : "";
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw);
          const nested = fromParsed(parsed);
          if (nested) return nested;
        } catch {
          const direct = candidate(raw);
          if (direct) return direct;
        }
      }
    }
    return "";
  });
  return token ? { Authorization: `Bearer ${pickTokenCandidate(token)}` } : {};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.validateOnly) {
    console.log(JSON.stringify({ ok: true, args }, null, 2));
    return;
  }

  const selectedCollections = COLLECTIONS.filter((item) =>
    args.collections.includes(item.id),
  );
  const outputDir = path.join(DATA_ROOT, "raw", "falcao", args.outputTag);
  fs.mkdirSync(outputDir, { recursive: true });
  const documentsPath = path.join(outputDir, "documents.jsonl");
  const keysPath = path.join(outputDir, "document_keys.txt");
  const requestsPath = path.join(outputDir, "requests.jsonl");
  const checkpointPath = path.join(outputDir, "checkpoint.json");
  const statusPath = path.join(outputDir, "status.json");
  const gapsPath = path.join(outputDir, "coverage_gaps.jsonl");

  const seen = new Set(
    fs.existsSync(keysPath)
      ? fs.readFileSync(keysPath, "utf8").split("\n").filter(Boolean)
      : [],
  );
  const checkpoint = loadJson(checkpointPath, {
    version: 2,
    created_at: nowIso(),
    pages: {},
    completed_partitions: {},
    completed_branches: {},
    dates: {},
    gaps: [],
  });
  checkpoint.version = 2;
  checkpoint.pages ||= {};
  checkpoint.completed_partitions ||= {};
  checkpoint.completed_branches ||= {};
  checkpoint.dates ||= {};
  checkpoint.gaps ||= [];

  const state = {
    started_at: checkpoint.created_at || nowIso(),
    updated_at: nowIso(),
    mode: args.mode,
    date_range: { start: args.startDate, end: args.endDate },
    page_size: args.pageSize,
    min_delay_ms: args.minDelayMs,
    max_delay_ms: args.maxDelayMs,
    current: null,
    unique_documents: seen.size,
    documents_this_run: 0,
    duplicate_documents_this_run: 0,
    requests_this_run: 0,
    request_elapsed_total_ms: 0,
    document_limit: args.documentLimit,
    status_counts: {},
    block_events: 0,
    api_mode_requested: args.apiMode,
    api_mode: args.apiMode,
    api_path: args.apiPath,
    fallback_no_auth_enabled: args.fallbackNoAuth,
    fallback_no_auth_used: false,
    completed_windows: Object.keys(checkpoint.completed_partitions).length,
    coverage_gaps: checkpoint.gaps.length,
    complete: false,
    output_dir: outputDir,
  };

  function saveState() {
    state.updated_at = nowIso();
    state.unique_documents = seen.size;
    state.completed_windows = Object.keys(checkpoint.completed_partitions).length;
    state.coverage_gaps = checkpoint.gaps.length;
    checkpoint.updated_at = state.updated_at;
    checkpoint.unique_documents = seen.size;
    atomicWriteJson(checkpointPath, checkpoint);
    atomicWriteJson(statusPath, state);
  }

  function readControl() {
    if (!args.controlPath) return { enabled: true, blocked: false };
    const control = loadJson(args.controlPath, null);
    if (!control) throw new PausedError("Controle de coleta indisponível.");
    return control;
  }

  function writeControl(changes) {
    if (!args.controlPath) return;
    const current = readControl();
    atomicWriteJson(args.controlPath, { ...current, ...changes, updated_at: nowIso() });
    fs.chmodSync(args.controlPath, 0o600);
  }

  function ensureEnabled() {
    const control = readControl();
    if (!control.enabled || control.blocked) {
      throw new PausedError(
        control.blocked
          ? "Coleta interrompida por sinal de bloqueio."
          : "Coleta pausada pelo administrador.",
      );
    }
  }

  let requestsStarted = 0;
  let lastRequestStartedAt = 0;
  let nextSampledDelayMs = 0;

  async function pace() {
    ensureEnabled();
    if (args.requestBudget > 0 && requestsStarted >= args.requestBudget) {
      throw new RequestBudgetReached(
        `Orçamento preventivo de ${args.requestBudget} requisições atingido.`,
      );
    }
    nextSampledDelayMs = randomBetween(args.minDelayMs, args.maxDelayMs);
    if (lastRequestStartedAt) {
      const waitMs = Math.max(
        0,
        lastRequestStartedAt + nextSampledDelayMs - Date.now(),
      );
      if (waitMs) await sleep(waitMs);
    }
    ensureEnabled();
    requestsStarted += 1;
    lastRequestStartedAt = Date.now();
  }

  function baseParams(date, collection, filters = []) {
    const params = new URLSearchParams({
      sessionId: state.session_id,
      latitude: "0",
      longitude: "0",
      texto: "",
      verTodosPrecedentes: "false",
      tribunais: "",
      pesquisaSomenteNasEmentas: "false",
      filtroRapidoData: "IntervaloSelecionado",
      dataInicio: date,
      dataFim: date,
      colecao: collection.id,
    });
    for (const filter of filters) params.set(filter.param, filter.value);
    return params;
  }

  let activeApiMode = args.apiMode;
  let activeApiPath = args.apiPath;

  function requestUrl(date, collection, filters, pageNumber, filtersOnly = false) {
    const params = baseParams(date, collection, filters);
    if (!filtersOnly) {
      params.set("page", String(pageNumber));
      params.set("size", String(args.pageSize));
    }
    return `${API_ORIGIN}${activeApiPath}${filtersOnly ? "/filtros" : ""}?${params}`;
  }

  function logRequest(response, context) {
    const row = {
      captured_at: nowIso(),
      ...context,
      status: response.status,
      ok: response.ok,
      elapsed_ms: response.elapsed_ms,
      response_bytes: response.response_bytes,
      retry_after: response.retry_after || "",
      error_body: response.ok ? "" : String(response.body || "").slice(0, 1_000),
      sampled_delay_ms: response.sampled_delay_ms,
      url: response.url,
    };
    appendJsonl(requestsPath, row);
    state.requests_this_run += 1;
    state.request_elapsed_total_ms += Number(response.elapsed_ms || 0);
    state.status_counts[String(response.status)] =
      (state.status_counts[String(response.status)] || 0) + 1;
    if ([403, 429].includes(response.status)) {
      state.block_events += 1;
      state.stop_reason = `HTTP ${response.status}`;
      state.blocked_at = row.captured_at;
      const currentControl = readControl();
      const consecutive429Count =
        response.status === 429
          ? Number(currentControl.consecutive_429_count || 0) + 1
          : Number(currentControl.consecutive_429_count || 0);
      writeControl({
        enabled: false,
        blocked: true,
        last_block_at: row.captured_at,
        block_status: response.status,
        block_url: response.url,
        consecutive_429_count: consecutive429Count,
        strategy_review_required:
          Boolean(currentControl.strategy_review_required) || consecutive429Count >= 2,
      });
      saveState();
      throw new BlockedError(`Falcão respondeu HTTP ${response.status}.`);
    }
    saveState();
    if (!response.ok) throw new HttpResponseError(response);
  }

  let page;
  let authHeaders = {};

  function activateNoAuthFallback(reason, failedUrl = "") {
    if (!args.fallbackNoAuth || activeApiMode !== "frontend") return false;
    const activatedAt = nowIso();
    activeApiMode = "no-auth";
    activeApiPath = API_PATHS["no-auth"];
    authHeaders = {};
    state.api_mode = activeApiMode;
    state.api_path = activeApiPath;
    state.auth_header_available = false;
    state.authentication_state = "unavailable";
    state.fallback_no_auth_used = true;
    state.fallback_no_auth_reason = reason;
    state.fallback_no_auth_at = activatedAt;
    writeControl({
      gold_account_authenticated: false,
      gold_account_tested: true,
      authentication_state: "reauthentication_required",
      authentication_failed_at: activatedAt,
      active_api_mode: activeApiMode,
      fallback_no_auth_used: true,
      fallback_no_auth_reason: reason,
      fallback_no_auth_url: failedUrl,
    });
    saveState();
    return true;
  }

  async function apiGet(url, context) {
    let targetUrl = url;
    for (let attempt = 0; ; attempt += 1) {
      await pace();
      const sampledDelay = nextSampledDelayMs;
      const response = await page.evaluate(async ({ target, timeoutMs, headers }) => {
        const started = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const result = await fetch(target, {
            method: "GET",
            credentials: "include",
            headers: { Accept: "application/json, text/plain, */*", ...headers },
            signal: controller.signal,
          });
          const body = await result.text();
          return {
            status: result.status,
            ok: result.ok,
            elapsed_ms: Date.now() - started,
            retry_after: result.headers.get("retry-after") || "",
            body,
          };
        } finally {
          clearTimeout(timer);
        }
      }, { target: targetUrl, timeoutMs: REQUEST_TIMEOUT_MS, headers: authHeaders });
      response.url = targetUrl;
      response.response_bytes = Buffer.byteLength(response.body || "");
      response.sampled_delay_ms = sampledDelay;
      try {
        logRequest(response, { ...context, attempt: attempt + 1 });
      } catch (error) {
        if (
          error instanceof HttpResponseError &&
          error.status === 401 &&
          activateNoAuthFallback("http_401", targetUrl)
        ) {
          targetUrl = targetUrl.replace(
            `${API_ORIGIN}${API_PATHS.frontend}`,
            `${API_ORIGIN}${API_PATHS["no-auth"]}`,
          );
          continue;
        }
        const retryable =
          error instanceof HttpResponseError &&
          (error.status === 400 || error.status === 408 || error.status >= 500);
        if (retryable && attempt < args.nonBlockRetries) continue;
        throw error;
      }
      try {
        response.payload = JSON.parse(response.body);
      } catch (error) {
        throw new Error(`Resposta JSON inválida: ${error}`);
      }
      return response;
    }
  }

  function findFacet(payload, definition) {
    const available = Array.isArray(payload?.filtrosDisponiveis)
      ? payload.filtrosDisponiveis
      : [];
    const match = available.find((item) => {
      const names = [item.nomeDoFiltro, item.nomeWeb].map(normalizedName);
      return names.some((name) =>
        definition.aliases.some((alias) => name === normalizedName(alias)),
      );
    });
    if (!match) return [];
    return (Array.isArray(match.valoresFiltro) ? match.valoresFiltro : [])
      .map((item) => ({
        value: String(item.valor ?? ""),
        label: String(item.valorWeb || item.valor || "Sem informação"),
        count: Number(item.quantidade || 0),
      }))
      .filter((item) => item.value && Number.isFinite(item.count) && item.count > 0);
  }

  function recordGap(gap) {
    const row = { detected_at: nowIso(), ...gap };
    const key = crypto
      .createHash("sha256")
      .update(JSON.stringify(gap))
      .digest("hex");
    if (!checkpoint.gaps.some((item) => item.key === key)) {
      checkpoint.gaps.push({ ...row, key });
      appendJsonl(gapsPath, row);
      saveState();
    }
  }

  function ingestDocuments(payload, collection, context) {
    const documents = Array.isArray(payload?.documentos) ? payload.documentos : [];
    let newDocuments = 0;
    let processedDocuments = 0;
    for (let index = 0; index < documents.length; index += 1) {
      if (args.documentLimit > 0 && state.documents_this_run >= args.documentLimit) {
        break;
      }
      const document = documents[index];
      processedDocuments += 1;
      const key = documentKey(collection, document);
      if (seen.has(key)) {
        state.duplicate_documents_this_run += 1;
        continue;
      }
      seen.add(key);
      fs.appendFileSync(keysPath, `${key}\n`);
      appendJsonl(documentsPath, {
        ...document,
        _justra: {
          collected_at: nowIso(),
          collection: collection.id,
          collection_label: collection.label,
          document_key: key,
          citation_url: citationUrl(collection, document),
          date_window: context.date,
          filters: context.filters,
          page: context.page,
          index_in_page: index,
          source_transport: "browser_fetch",
        },
      });
      newDocuments += 1;
      state.documents_this_run += 1;
    }
    return {
      returned: documents.length,
      processedDocuments,
      newDocuments,
      limitReached:
        args.documentLimit > 0 && state.documents_this_run >= args.documentLimit,
    };
  }

  function rawPagePath(date, collection, filters, pageNumber) {
    return path.join(
      outputDir,
      "raw",
      date,
      collection.id,
      filterHash(filters),
      `page_${String(pageNumber).padStart(3, "0")}.json`,
    );
  }

  async function collectLeaf(date, collection, filters, total, firstResponse) {
    const leafKey = partitionKey(date, collection, filters);
    if (checkpoint.completed_partitions[leafKey]) return true;
    const pages = Math.ceil(total / args.pageSize);
    let returned = 0;
    for (let pageNumber = 0; pageNumber < pages; pageNumber += 1) {
      const pageKey = `${leafKey}|page=${pageNumber}`;
      if (checkpoint.pages[pageKey]) {
        returned += Number(checkpoint.pages[pageKey].returned || 0);
        continue;
      }
      state.current = { date, collection: collection.id, filters, page: pageNumber, expected_count: total };
      saveState();
      const response =
        pageNumber === 0
          ? firstResponse
          : await apiGet(requestUrl(date, collection, filters, pageNumber), {
              event: "page",
              date,
              collection: collection.id,
              filters,
              page: pageNumber,
              expected_count: total,
            });
      const rawPath = rawPagePath(date, collection, filters, pageNumber);
      atomicWriteJson(rawPath, response.payload);
      const ingested = ingestDocuments(response.payload, collection, {
        date,
        filters,
        page: pageNumber,
      });
      returned += ingested.returned;
      if (ingested.processedDocuments === ingested.returned) {
        checkpoint.pages[pageKey] = {
          completed_at: nowIso(),
          returned: ingested.returned,
          new_documents: ingested.newDocuments,
          raw_path: path.relative(ROOT, rawPath),
        };
      }
      saveState();
      if (ingested.limitReached) {
        throw new DocumentLimitReached(
          `Limite de ${args.documentLimit} documentos atingido.`,
        );
      }
    }
    if (returned < total) {
      recordGap({
        reason: "pagination_returned_less_than_total",
        date,
        collection: collection.id,
        filters,
        expected: total,
        returned,
      });
      return false;
    }
    checkpoint.completed_partitions[leafKey] = {
      completed_at: nowIso(),
      expected_count: total,
      pages,
      filters,
    };
    saveState();
    return true;
  }

  async function collectPartition(date, collection, filters = []) {
    const currentPartitionKey = partitionKey(date, collection, filters);
    if (
      checkpoint.completed_partitions[currentPartitionKey] ||
      checkpoint.completed_branches[currentPartitionKey]
    ) {
      return true;
    }
    const response = await apiGet(requestUrl(date, collection, filters, 0), {
      event: filters.length ? "probe_partition" : "probe_collection",
      date,
      collection: collection.id,
      filters,
      page: 0,
    });
    const total = Number(response.payload?.quantidadeTotal || 0);
    let leafHttpError = null;
    if (total <= MAX_ANONYMOUS_DOCUMENTS) {
      try {
        return await collectLeaf(date, collection, filters, total, response);
      } catch (error) {
        if (!(error instanceof HttpResponseError)) throw error;
        leafHttpError = error;
      }
    }

    const filtersResponse = await apiGet(
      requestUrl(date, collection, filters, 0, true),
      {
        event: "partition_facets",
        date,
        collection: collection.id,
        filters,
        page: null,
        expected_count: total,
      },
    );
    const used = new Set(filters.map((item) => item.param));
    const candidates = [];
    for (const definition of FACETS) {
      if (used.has(definition.param)) continue;
      const values = findFacet(filtersResponse.payload, definition);
      if (!values.length) continue;
      const largest = Math.max(...values.map((item) => item.count));
      if (largest >= total && values.length === 1) continue;
      const childSum = values.reduce((sum, item) => sum + item.count, 0);
      candidates.push({ definition, values, childSum, largest });
    }
    // Prefere uma faceta exaustiva; isso evita perder documentos sem órgão ou
    // relator quando outra dimensão disponível cobre o conjunto inteiro.
    const selected =
      candidates.find((candidate) => candidate.childSum >= total) ||
      candidates.sort((left, right) => right.childSum - left.childSum)[0] ||
      null;
    if (!selected) {
      recordGap({
        reason: leafHttpError
          ? "unable_to_repartition_after_http_error"
          : "unable_to_partition_below_anonymous_limit",
        date,
        collection: collection.id,
        filters,
        expected: total,
        status: leafHttpError?.status,
        url: leafHttpError?.url,
        response_body: String(leafHttpError?.body || "").slice(0, 1_000),
      });
      return false;
    }

    const childSum = selected.childSum;
    let complete = true;
    for (const value of selected.values) {
      const childFilters = [
        ...filters,
        {
          param: selected.definition.param,
          facet: selected.definition.label,
          name: value.label,
          value: value.value,
          expected_count: value.count,
        },
      ];
      try {
        const childComplete = await collectPartition(date, collection, childFilters);
        complete = childComplete && complete;
      } catch (error) {
        if (!(error instanceof HttpResponseError)) throw error;
        recordGap({
          reason: "non_blocking_http_error",
          date,
          collection: collection.id,
          filters: childFilters,
          status: error.status,
          url: error.url,
          response_body: String(error.body || "").slice(0, 1_000),
        });
        complete = false;
      }
    }
    if (childSum < total) {
      recordGap({
        reason: "facet_counts_do_not_cover_parent",
        date,
        collection: collection.id,
        filters,
        facet: selected.definition.label,
        expected: total,
        child_sum: childSum,
      });
      complete = false;
    }
    if (complete) {
      checkpoint.completed_branches[currentPartitionKey] = {
        completed_at: nowIso(),
        expected_count: total,
        filters,
        facet: selected.definition.label,
        strategy: leafHttpError ? "split_after_http_error" : "partitioned",
      };
      saveState();
    }
    return complete;
  }

  let browser = null;
  let context = null;
  let browserState = null;
  try {
    browserState = await newBrowserContext(args);
    browser = browserState.browser;
    context = browserState.context;
    page =
      context.pages().find((candidate) => candidate.url().startsWith(FRONTEND_URL)) ||
      context.pages()[0] ||
      await context.newPage();
    state.session_id = sessionId();
    state.auth_mode = args.connectCdp
      ? "connected_chrome_cdp"
      : args.userDataDir
        ? "persistent_browser_profile"
        : "anonymous_browser_context";
    state.cdp_endpoint = args.connectCdp || "";
    state.user_data_dir = args.userDataDir ? path.resolve(args.userDataDir) : "";
    saveState();
    const reuseCurrentPage =
      args.connectCdp && page.url().startsWith(FRONTEND_URL);
    if (!reuseCurrentPage) {
      const navigation = await page.goto(FRONTEND_URL, {
        waitUntil: "domcontentloaded",
        timeout: 90_000,
      });
      if (!navigation || !navigation.ok()) {
        const status = navigation?.status() || 0;
        if ([403, 429].includes(status)) {
          writeControl({
            enabled: false,
            blocked: true,
            last_block_at: nowIso(),
            block_status: status,
            block_url: FRONTEND_URL,
          });
          throw new BlockedError(`Frontend respondeu HTTP ${status}.`);
        }
        throw new Error(`Frontend respondeu HTTP ${status}.`);
      }
    }
    state.reused_current_page = Boolean(reuseCurrentPage);
    state.current_page_url = page.url();
    saveState();
    if (args.authSetup) {
      await waitForInteractiveAuth(page, args);
      state.current = null;
      state.finished_at = nowIso();
      state.complete = true;
      state.result = "auth_setup_complete";
      saveState();
      return;
    }
    if (args.apiMode === "frontend") {
      authHeaders = await authHeadersFromPage(page);
      state.auth_header_available = Boolean(authHeaders.Authorization);
      state.authentication_state = authHeaders.Authorization ? "authenticated" : "unavailable";
      saveState();
      if (authHeaders.Authorization) {
        const verifiedAt = nowIso();
        writeControl({
          gold_account_authenticated: true,
          gold_account_tested: true,
          authentication_state: "authenticated",
          authentication_verified_at: verifiedAt,
          authentication_failed_at: "",
          active_api_mode: "frontend",
          fallback_no_auth_used: false,
          fallback_no_auth_reason: "",
          fallback_no_auth_url: "",
        });
      } else {
        activateNoAuthFallback("missing_auth_header");
      }
    }

    let allComplete = true;
    const activeDates = dateRange(args.startDate, args.endDate);
    for (const date of activeDates) {
      checkpoint.dates[date] ||= { collections: {}, updated_at: nowIso() };
      for (const collection of selectedCollections) {
        const saved = checkpoint.dates[date].collections[collection.id];
        if (saved?.status === "complete") continue;
        // Uma nova tentativa substitui os gaps desta coleção. Se o problema
        // persistir, a travessia abaixo volta a registrá-lo.
        checkpoint.gaps = checkpoint.gaps.filter(
          (gap) => !(gap.date === date && gap.collection === collection.id),
        );
        state.current = { date, collection: collection.id, filters: [], page: 0 };
        saveState();
        let complete;
        try {
          complete = await collectPartition(date, collection, []);
        } catch (error) {
          if (!(error instanceof HttpResponseError)) throw error;
          recordGap({
            reason: "non_blocking_http_error",
            date,
            collection: collection.id,
            filters: [],
            status: error.status,
            url: error.url,
            response_body: String(error.body || "").slice(0, 1_000),
          });
          complete = false;
        }
        const collectionPrefix = `${date}|${collection.id}|`;
        const completedLeaves = Object.entries(checkpoint.completed_partitions).filter(
          ([key]) => key.startsWith(collectionPrefix),
        );
        const expectedDocuments = completedLeaves.reduce(
          (sum, [, item]) => sum + Number(item.expected_count || 0),
          0,
        );
        checkpoint.dates[date].collections[collection.id] = {
          status: complete ? "complete" : "partial",
          updated_at: nowIso(),
          documents: expectedDocuments,
          completed_partitions: completedLeaves.length,
        };
        checkpoint.dates[date].updated_at = nowIso();
        allComplete = complete && allComplete;
        saveState();
      }
    }
    state.current = null;
    state.finished_at = nowIso();
    const activeGaps = checkpoint.gaps.filter((gap) => activeDates.includes(gap.date));
    state.complete = allComplete && activeGaps.length === 0;
    state.result = state.complete ? "complete" : "partial";
    saveState();
    if (!state.complete) process.exitCode = 2;
  } catch (error) {
    state.current = null;
    state.finished_at = nowIso();
    state.complete = false;
    state.error = String(error?.message || error);
    if (error instanceof BlockedError) {
      state.result = "blocked";
      process.exitCode = 3;
    } else if (error instanceof RequestBudgetReached) {
      state.result = "paused_by_request_budget";
      process.exitCode = 0;
    } else if (error instanceof DocumentLimitReached) {
      state.result = "document_limit_reached";
      state.stop_reason = error.message;
      delete state.error;
      process.exitCode = 0;
    } else if (error instanceof PausedError) {
      state.result = "paused_by_control";
      process.exitCode = 0;
    } else {
      state.result = "error";
      process.exitCode = 1;
    }
    saveState();
    console.error(error?.stack || String(error));
  } finally {
    if (context && browserState?.closeContext !== false) {
      await context.close().catch(() => {});
    }
    if (browserState?.disconnectBrowser && browser?.disconnect) {
      browser.disconnect();
    } else if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

await main();
