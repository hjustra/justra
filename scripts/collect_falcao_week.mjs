import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const DATA_ROOT = path.resolve(process.env.JUSTRA_DATA_DIR || path.join(ROOT, "data"));
const LOG_ROOT = path.resolve(process.env.JUSTRA_LOG_DIR || path.join(ROOT, "logs"));
const CODEX_NODE_MODULES =
  "/Users/heitordoamaraljurkovich/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const RUNTIME_NODE_MODULES =
  process.env.JUSTRA_NODE_MODULES ||
  (fs.existsSync(CODEX_NODE_MODULES) ? CODEX_NODE_MODULES : path.join(ROOT, "node_modules"));
const require = createRequire(path.join(RUNTIME_NODE_MODULES, "package.json"));
const { chromium } = require("playwright");

const FRONTEND_URL =
  "https://jurisprudencia.jt.jus.br/jurisprudencia-nacional/pesquisa";
const API_PATH = "/jurisprudencia-nacional-backend/api/no-auth/pesquisa";
const CITATION_BASE =
  "https://jurisprudencia.jt.jus.br/jurisprudencia-nacional/citacao";
const DEFAULT_CHROME_PATH =
  process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "";
const CHROME_PATH = process.env.JUSTRA_CHROME_PATH || DEFAULT_CHROME_PATH;

function browserLaunchOptions(headed) {
  const options = { headless: !headed };
  if (CHROME_PATH) options.executablePath = CHROME_PATH;
  return options;
}

const COLLECTIONS = [
  { id: "acordaos", label: "Acórdãos" },
  { id: "decisoesmonocraticas", label: "Decisões Monocráticas" },
  { id: "sentencas", label: "Sentenças" },
  {
    id: "recursorevista",
    label: "Admissibilidade de Recurso de Revista",
  },
];

const PARTITION_FACETS = [
  "Tribunal",
  "Órgão Julgador",
  "Magistrada / Magistrado",
  "Classe",
];

function parseArgs(argv) {
  const args = {
    startDate: "2026-06-11",
    endDate: "2026-06-18",
    pageSize: 20,
    sleepMs: 1000,
    jitterMs: 0,
    requestBudget: 0,
    restEvery: 0,
    restMs: 0,
    minimumBlockFreeMinutes: 0,
    maxDocuments: 0,
    headed: true,
    detach: false,
    logPath: "",
    waitForPid: 0,
    waitForCooldown: false,
    validateOnly: false,
    cooldownMinutes: 0,
    blockCooldownMinutes: 900,
    outputTag: "2026-06-11_2026-06-18",
    controlPath: "",
    collections: COLLECTIONS.map((item) => item.id),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--start-date") args.startDate = argv[++index];
    else if (value === "--end-date") args.endDate = argv[++index];
    else if (value === "--page-size") args.pageSize = Number(argv[++index]);
    else if (value === "--sleep-ms") args.sleepMs = Number(argv[++index]);
    else if (value === "--jitter-ms") args.jitterMs = Number(argv[++index]);
    else if (value === "--request-budget") args.requestBudget = Number(argv[++index]);
    else if (value === "--rest-every") args.restEvery = Number(argv[++index]);
    else if (value === "--rest-ms") args.restMs = Number(argv[++index]);
    else if (value === "--minimum-block-free-minutes") {
      args.minimumBlockFreeMinutes = Number(argv[++index]);
    } else if (value === "--max-documents") {
      args.maxDocuments = Number(argv[++index]);
    } else if (value === "--output-tag") args.outputTag = argv[++index];
    else if (value === "--control-path") args.controlPath = argv[++index];
    else if (value === "--collections") {
      args.collections = argv[++index].split(",").filter(Boolean);
    } else if (value === "--headless") args.headed = false;
    else if (value === "--detach") args.detach = true;
    else if (value === "--log-path") args.logPath = argv[++index];
    else if (value === "--wait-for-pid") {
      args.waitForPid = Number(argv[++index]);
    } else if (value === "--wait-for-cooldown") args.waitForCooldown = true;
    else if (value === "--validate-only") args.validateOnly = true;
    else if (value === "--cooldown-minutes") {
      args.cooldownMinutes = Number(argv[++index]);
    } else if (value === "--block-cooldown-minutes") {
      args.blockCooldownMinutes = Number(argv[++index]);
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.startDate)) {
    throw new Error("--start-date deve usar YYYY-MM-DD.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.endDate)) {
    throw new Error("--end-date deve usar YYYY-MM-DD.");
  }
  if (![5, 10, 20].includes(args.pageSize)) {
    throw new Error("--page-size deve ser 5, 10 ou 20.");
  }
  const knownCollections = new Set(COLLECTIONS.map((item) => item.id));
  for (const collection of args.collections) {
    if (!knownCollections.has(collection)) {
      throw new Error(`Coleção desconhecida: ${collection}`);
    }
  }
  for (const [name, number] of Object.entries({
    sleepMs: args.sleepMs,
    jitterMs: args.jitterMs,
    requestBudget: args.requestBudget,
    restEvery: args.restEvery,
    restMs: args.restMs,
    minimumBlockFreeMinutes: args.minimumBlockFreeMinutes,
  })) {
    if (!Number.isFinite(number) || number < 0) {
      throw new Error(`--${name} deve ser um número não negativo.`);
    }
  }
  return args;
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class RequestBudgetReached extends Error {}
class CollectionPaused extends Error {}

const requestPacing = {
  minIntervalMs: 0,
  jitterMs: 0,
  requestBudget: 0,
  restEvery: 0,
  restMs: 0,
  requestsStarted: 0,
  lastStartedAt: 0,
  controlPath: "",
};

function readCollectionControl() {
  if (!requestPacing.controlPath) return { enabled: true, blocked: false };
  try {
    return JSON.parse(fs.readFileSync(requestPacing.controlPath, "utf8"));
  } catch {
    throw new CollectionPaused("Controle de coleta indisponível; parada preventiva.");
  }
}

function writeCollectionControl(changes) {
  if (!requestPacing.controlPath) return;
  const current = readCollectionControl();
  atomicWriteJson(requestPacing.controlPath, {
    ...current,
    ...changes,
    updated_at: nowIso(),
  });
  fs.chmodSync(requestPacing.controlPath, 0o600);
}

function ensureCollectionEnabled() {
  const control = readCollectionControl();
  if (!control.enabled || control.blocked) {
    throw new CollectionPaused(
      control.blocked
        ? "Coleta interrompida por sinal de bloqueio."
        : "Coleta pausada pelo administrador.",
    );
  }
}

async function paceSearchRequest() {
  ensureCollectionEnabled();
  if (
    requestPacing.requestBudget > 0 &&
    requestPacing.requestsStarted >= requestPacing.requestBudget
  ) {
    throw new RequestBudgetReached(
      `Orçamento preventivo de ${requestPacing.requestBudget} requisições atingido.`,
    );
  }
  if (
    requestPacing.requestsStarted > 0 &&
    requestPacing.restEvery > 0 &&
    requestPacing.requestsStarted % requestPacing.restEvery === 0
  ) {
    console.log(
      JSON.stringify({
        event: "preventive_rest",
        requests: requestPacing.requestsStarted,
        rest_minutes: Math.ceil(requestPacing.restMs / 60_000),
        at: nowIso(),
      }),
    );
    await sleep(requestPacing.restMs);
  }
  const jitter =
    requestPacing.jitterMs > 0
      ? Math.floor(Math.random() * (requestPacing.jitterMs + 1))
      : 0;
  const earliest =
    requestPacing.lastStartedAt + requestPacing.minIntervalMs + jitter;
  const waitMs = Math.max(0, earliest - Date.now());
  if (waitMs) await sleep(waitMs);
  ensureCollectionEnabled();
  requestPacing.requestsStarted += 1;
  requestPacing.lastStartedAt = Date.now();
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

function formatBrazilianDate(isoDate) {
  const [year, month, day] = isoDate.split("-");
  return `${day}/${month}/${year}`;
}

function retryAfterMilliseconds(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

function atomicWriteJson(filePath, value) {
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2));
  fs.renameSync(temporaryPath, filePath);
}

function appendJsonl(filePath, value) {
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function documentId(collection, document) {
  const idFields = {
    acordaos: "idDocumentoAcordao",
    decisoesmonocraticas: "idDocumento",
    sentencas: "idSentenca",
    recursorevista: "idRecursoRevista",
    precedentes: "id",
  };
  return (
    document?.[idFields[collection]] ||
    document?.id ||
    document?.idTema ||
    ""
  );
}

function documentKey(collection, document) {
  const id = documentId(collection, document);
  if (id) return `${collection}:${document.tribunal || "sem-tribunal"}:${id}`;
  return `${collection}:sha256:${crypto
    .createHash("sha256")
    .update(JSON.stringify(document))
    .digest("hex")}`;
}

function citationUrl(collection, document) {
  const id = documentId(collection, document);
  if (!id || !document?.tribunal) return "";
  return `${CITATION_BASE}/${encodeURIComponent(collection)}/${encodeURIComponent(
    document.tribunal,
  )}/${encodeURIComponent(id)}`;
}

function isSearchResponse(response, collection, pageNumber = null) {
  try {
    const url = new URL(response.url());
    if (url.pathname !== API_PATH) return false;
    if (url.searchParams.get("colecao") !== collection) return false;
    return (
      pageNumber === null ||
      Number(url.searchParams.get("page")) === pageNumber
    );
  } catch {
    return false;
  }
}

async function captureSearchResponse(page, collection, pageNumber, action) {
  await paceSearchRequest();
  const startedAt = Date.now();
  const responsePromise = page.waitForResponse(
    (response) => isSearchResponse(response, collection, pageNumber),
    { timeout: 90_000 },
  );
  try {
    await action();
  } catch (error) {
    responsePromise.catch(() => {});
    throw error;
  }
  const response = await responsePromise;
  const body = await response.text().catch(() => "");
  return {
    captured_at: nowIso(),
    status: response.status(),
    ok: response.ok(),
    elapsed_ms: Date.now() - startedAt,
    url: response.url(),
    response_bytes: Buffer.byteLength(body),
    retry_after: response.headers()["retry-after"] || "",
    body,
  };
}

async function ensureSidebarOpen(page) {
  const fixedFilters = page.locator("section.filtro-wrapper:visible");
  if ((await fixedFilters.count()) > 0) return;
  const active = page.locator(".p-sidebar-active:visible");
  if (await active.isVisible().catch(() => false)) return;
  const button = page.locator(
    'button[aria-label="Filtros laterais. Clique para abrir."]:visible, button[aria-label="Filtros"]:visible',
  );
  await button.waitFor({ state: "visible", timeout: 90_000 });
  await button.first().click();
  await active.waitFor({ state: "visible", timeout: 10_000 });
}

async function facetSection(page, title) {
  await ensureSidebarOpen(page);
  return page.locator("section.filtro-wrapper:visible").filter({
    has: page.getByRole("heading", { name: title, exact: true }),
  });
}

async function expandFacet(page, title) {
  const section = await facetSection(page, title);
  const more = section.getByRole("button", { name: "Mais...", exact: true });
  if (await more.isVisible().catch(() => false)) await more.click();
  return section;
}

async function readFacetItems(page, title) {
  await expandFacet(page, title);
  return page.evaluate((facetTitle) => {
    const sections = Array.from(
      document.querySelectorAll("section.filtro-wrapper"),
    ).filter((element) => element.getClientRects().length > 0);
    const section = sections.find(
      (candidate) =>
        candidate.querySelector("h3")?.textContent?.trim() === facetTitle,
    );
    if (!section) return [];
    return Array.from(section.querySelectorAll(".filtro-item[aria-label]"))
      .map((element, index) => {
        const ariaLabel = element.getAttribute("aria-label") || "";
        const match = ariaLabel.match(/^(.*)\. Quantidade: (\d+)$/);
        if (!match) return null;
        return {
          name: match[1],
          count: Number(match[2]),
          ariaLabel,
          index,
        };
      })
      .filter(Boolean);
  }, title);
}

async function selectFacetItem(page, collection, facet, item) {
  const section = await expandFacet(page, facet);
  const target = section.getByLabel(item.ariaLabel, { exact: true });
  const matches = await target.count();
  if (matches !== 1) {
    throw new Error(
      `Item de filtro ambíguo (${matches}): ${item.ariaLabel}`,
    );
  }
  return captureSearchResponse(page, collection, 0, () => target.click());
}

async function removeFacetItem(page, collection, item) {
  await ensureSidebarOpen(page);
  const chipName = item.name.replace(/^(?:TST|TRT\d+|CSJT) - /, "");
  const chipCandidates = await page
    .locator(
      '[aria-label^="Chip com"][aria-label*="Selecione para apagar o filtro."]:visible',
    )
    .all();
  const chips = [];
  for (const candidate of chipCandidates) {
    const ariaLabel = (await candidate.getAttribute("aria-label")) || "";
    const suffixIndex = ariaLabel.indexOf(". Selecione para apagar o filtro.");
    const labelBody = suffixIndex >= 0 ? ariaLabel.slice(0, suffixIndex) : ariaLabel;
    const separatorIndex = labelBody.indexOf(":");
    const chipValue =
      separatorIndex >= 0 ? labelBody.slice(separatorIndex + 1).trim() : "";
    if (
      chipValue.toLocaleLowerCase("pt-BR") ===
      chipName.toLocaleLowerCase("pt-BR")
    ) {
      chips.push(candidate);
    }
  }
  if (chips.length !== 1) {
    throw new Error(`Chip de filtro ambíguo (${chips.length}): ${chipName}`);
  }
  const chip = chips[0];
  const removeIcon = chip.locator(".pi-chip-remove-icon");
  const target = (await removeIcon.isVisible().catch(() => false))
    ? removeIcon
    : chip;
  return captureSearchResponse(page, collection, 0, () => target.click());
}

async function chooseCalendarDay(page, inputPlaceholder, isoDate) {
  const input = page.locator(
    `input[placeholder="${inputPlaceholder}"]:visible`,
  );
  await input.click();
  const calendar = page.locator(".p-datepicker:visible");
  await calendar.waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(300);
  const [year, month, day] = isoDate.split("-").map(Number);
  const displayedMonth = await calendar
    .locator(".p-datepicker-month")
    .textContent();
  const displayedYear = Number(
    await calendar.locator(".p-datepicker-year").textContent(),
  );
  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  if (displayedMonth?.trim() !== monthNames[month - 1] || displayedYear !== year) {
    throw new Error(
      `Calendário fora do mês esperado: ${displayedMonth} ${displayedYear}`,
    );
  }
  const dayCell = calendar
    .locator("td:not(.p-datepicker-other-month)")
    .getByText(String(day), { exact: true });
  if ((await dayCell.count()) !== 1) {
    throw new Error(`Dia ${formatBrazilianDate(isoDate)} não encontrado.`);
  }
  await dayCell.click({ force: true });
}

async function setSingleDay(page, collection, isoDate) {
  await ensureSidebarOpen(page);
  await chooseCalendarDay(page, "Início", isoDate);
  await paceSearchRequest();
  const responsePromise = page.waitForResponse(
    (response) => isSearchResponse(response, collection, 0),
    { timeout: 90_000 },
  );
  const startedAt = Date.now();
  try {
    await chooseCalendarDay(page, "Final", isoDate);
    const submit = page.locator(
      'button[aria-label="Botão de pesquisar o período selecionado"]:visible, button[icon="pi pi-chevron-right"]:visible',
    );
    if (await submit.isVisible().catch(() => false)) await submit.click();
  } catch (error) {
    responsePromise.catch(() => {});
    throw error;
  }
  const response = await responsePromise;
  const body = await response.text().catch(() => "");
  return {
    captured_at: nowIso(),
    status: response.status(),
    ok: response.ok(),
    elapsed_ms: Date.now() - startedAt,
    url: response.url(),
    response_bytes: Buffer.byteLength(body),
    body,
  };
}

async function dismissCookieBanner(page) {
  const button = page.getByRole("button", { name: "Ciente", exact: true });
  if (await button.isVisible().catch(() => false)) await button.click();
}

async function selectCollection(page, collection) {
  await ensureSidebarOpen(page);
  const selectedChip = page.locator(
    `[aria-label^="Chip com a coleção filtrada: ${collection.id}."]:visible`,
  );
  if (await selectedChip.isVisible().catch(() => false)) return null;
  const target = page
    .locator(`[aria-label^="${collection.label}. Quantidade:"]:visible`)
    .first();
  return captureSearchResponse(page, collection.id, 0, () => target.click());
}

async function selectPageSize(page, collection, pageSize) {
  const dropdowns = page.getByRole("button", { name: "dropdown trigger" });
  const count = await dropdowns.count();
  if (!count) throw new Error("Seletor de tamanho de página não encontrado.");
  await dropdowns.last().click();
  const panel = page.locator(".p-dropdown-panel:visible");
  await panel.waitFor({ state: "visible", timeout: 10_000 });
  const available = (await panel.getByRole("option").allTextContents())
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value <= pageSize);
  const effectivePageSize = Math.max(...available);
  if (!Number.isFinite(effectivePageSize)) {
    throw new Error("Nenhum tamanho de página compatível foi encontrado.");
  }
  const option = panel.getByRole("option", {
    name: String(effectivePageSize),
    exact: true,
  });
  const response = await captureSearchResponse(page, collection, 0, () =>
    option.click(),
  );
  return { response, pageSize: effectivePageSize };
}

async function nextPage(page, collection, pageNumber) {
  const button = page.locator(
    "button.p-paginator-next:visible:not([disabled])",
  );
  if (!(await button.isVisible().catch(() => false))) return null;
  return captureSearchResponse(page, collection, pageNumber, () =>
    button.click(),
  );
}

async function retryPage(page, collection, pageNumber) {
  const button = page
    .locator("button.p-paginator-page:visible")
    .filter({ hasText: String(pageNumber + 1) });
  if ((await button.count()) !== 1) return null;
  return captureSearchResponse(page, collection, pageNumber, () =>
    button.click(),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.validateOnly) {
    console.log(JSON.stringify({ event: "configuration_valid", args }, null, 2));
    return;
  }
  if (args.detach) {
    const childArgs = process.argv
      .slice(2)
      .filter((value, index, values) => {
        if (value === "--detach") return false;
        if (values[index - 1] === "--log-path") return false;
        return value !== "--log-path";
      });
    const logPath = path.resolve(
      ROOT,
      args.logPath || path.join(LOG_ROOT, `falcao_week_${args.outputTag}.log`),
    );
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const logFd = fs.openSync(logPath, "a");
    const child = spawn(process.execPath, [__filename, ...childArgs], {
      cwd: ROOT,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    fs.closeSync(logFd);
    console.log(
      JSON.stringify({
        event: "detached",
        pid: child.pid,
        log_path: logPath,
        output_tag: args.outputTag,
      }),
    );
    return;
  }
  if (args.waitForPid > 0) {
    console.log(
      JSON.stringify({
        event: "waiting_for_pid",
        pid: args.waitForPid,
        at: nowIso(),
      }),
    );
    while (true) {
      try {
        process.kill(args.waitForPid, 0);
        await sleep(30_000);
      } catch {
        break;
      }
    }
    console.log(
      JSON.stringify({
        event: "wait_complete",
        pid: args.waitForPid,
        at: nowIso(),
      }),
    );
  }
  const selectedCollections = COLLECTIONS.filter((item) =>
    args.collections.includes(item.id),
  );
  const outputDir = path.join(DATA_ROOT, "raw", "falcao", args.outputTag);
  fs.mkdirSync(outputDir, { recursive: true });
  console.log(
    JSON.stringify({
      event: "start",
      at: nowIso(),
      start_date: args.startDate,
      end_date: args.endDate,
      collections: args.collections,
      output_dir: outputDir,
    }),
  );
  const documentsPath = path.join(outputDir, "documents.jsonl");
  const keysPath = path.join(outputDir, "document_keys.txt");
  const requestsPath = path.join(outputDir, "requests.jsonl");
  const checkpointPath = path.join(outputDir, "checkpoint.json");
  const statusPath = path.join(outputDir, "status.json");
  const gapsPath = path.join(outputDir, "coverage_gaps.jsonl");

  Object.assign(requestPacing, {
    minIntervalMs: args.sleepMs,
    jitterMs: args.jitterMs,
    requestBudget: args.requestBudget,
    restEvery: args.restEvery,
    restMs: args.restMs,
    requestsStarted: 0,
    lastStartedAt: Date.now(),
    controlPath: args.controlPath ? path.resolve(args.controlPath) : "",
  });

  const seen = new Set(
    fs.existsSync(keysPath)
      ? fs.readFileSync(keysPath, "utf8").split("\n").filter(Boolean)
      : [],
  );
  const checkpoint = fs.existsSync(checkpointPath)
    ? JSON.parse(fs.readFileSync(checkpointPath, "utf8"))
    : { completed_windows: {}, started_at: nowIso() };
  checkpoint.completed_windows ||= {};
  checkpoint.completed_partitions ||= {};
  checkpoint.completed_collections ||= {};

  const state = {
    started_at: checkpoint.started_at || nowIso(),
    updated_at: nowIso(),
    date_range: { start: args.startDate, end: args.endDate },
    current: null,
    unique_documents: seen.size,
    documents_this_run: 0,
    duplicate_documents_this_run: 0,
    requests_this_run: 0,
    status_counts: {},
    block_events: 0,
    completed_windows: Object.keys(checkpoint.completed_windows).length,
    coverage_gaps_this_run: 0,
    stopped_by_limit: false,
    safe_policy: {
      min_interval_ms: args.sleepMs,
      jitter_ms: args.jitterMs,
      request_budget: args.requestBudget,
      rest_every: args.restEvery,
      rest_ms: args.restMs,
      minimum_block_free_minutes: args.minimumBlockFreeMinutes,
    },
    output_dir: outputDir,
  };

  function saveState() {
    state.updated_at = nowIso();
    state.unique_documents = seen.size;
    state.completed_windows = Object.keys(checkpoint.completed_windows).length;
    checkpoint.updated_at = state.updated_at;
    checkpoint.unique_documents = seen.size;
    atomicWriteJson(checkpointPath, checkpoint);
    atomicWriteJson(statusPath, state);
  }

  function logRequest(response, context, throwOnError = true) {
    if (response._logged) return;
    const row = {
      captured_at: response.captured_at,
      ...context,
      status: response.status,
      ok: response.ok,
      elapsed_ms: response.elapsed_ms,
      response_bytes: response.response_bytes,
      retry_after: response.retry_after,
      url: response.url,
    };
    appendJsonl(requestsPath, row);
    response._logged = true;
    state.requests_this_run += 1;
    state.status_counts[String(response.status)] =
      (state.status_counts[String(response.status)] || 0) + 1;
    if ([403, 429].includes(response.status)) state.block_events += 1;
    if ([403, 429].includes(response.status)) {
      const cooldownMs =
        retryAfterMilliseconds(response.retry_after) ||
        args.blockCooldownMinutes * 60_000;
      checkpoint.cooldown_until = new Date(Date.now() + cooldownMs).toISOString();
      state.cooldown_until = checkpoint.cooldown_until;
      state.paused_for_block = true;
      state.stop_reason = `HTTP ${response.status}`;
      writeCollectionControl({
        enabled: false,
        blocked: true,
        last_block_at: response.captured_at || nowIso(),
        block_status: response.status,
        block_url: response.url,
        paused_at: nowIso(),
      });
    }
    saveState();
    if (!response.ok && throwOnError) {
      saveState();
      throw new Error(`Falcão respondeu HTTP ${response.status}.`);
    }
  }

  function ingest(response, collection, context) {
    logRequest(response, context);
    let payload;
    try {
      payload = JSON.parse(response.body);
    } catch (error) {
      throw new Error(`Resposta JSON inválida: ${error}`);
    }
    const documents = Array.isArray(payload.documentos)
      ? payload.documentos
      : [];
    let newDocuments = 0;
    for (let index = 0; index < documents.length; index += 1) {
      const document = documents[index];
      const key = documentKey(collection.id, document);
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
          citation_url: citationUrl(collection.id, document),
          date_window: context.date,
          filters: context.filters,
          page: context.page,
          index_in_page: index,
        },
      });
      newDocuments += 1;
      state.documents_this_run += 1;
    }
    return { returned: documents.length, newDocuments };
  }

  function limitReached() {
    return args.maxDocuments > 0 && seen.size >= args.maxDocuments;
  }

  function windowKey(date, collection, filters) {
    return [
      date,
      collection.id,
      ...filters.map((filter) => `${filter.facet}=${filter.name}`),
    ].join("|");
  }

  const requestHistory = fs.existsSync(requestsPath)
    ? fs.readFileSync(requestsPath, "utf8").trim().split("\n").filter(Boolean)
    : [];
  let lastBlockAt = 0;
  for (let index = requestHistory.length - 1; index >= 0; index -= 1) {
    try {
      const row = JSON.parse(requestHistory[index]);
      if ([403, 429].includes(Number(row.status))) {
        lastBlockAt = Date.parse(row.captured_at || "") || 0;
        break;
      }
    } catch {
      // Linha histórica inválida não deve derrubar a retomada segura.
    }
  }
  const cooldownCandidates = [Date.parse(checkpoint.cooldown_until || "") || 0];
  if (args.cooldownMinutes > 0) {
    cooldownCandidates.push(Date.now() + args.cooldownMinutes * 60_000);
  }
  if (lastBlockAt && args.minimumBlockFreeMinutes > 0) {
    cooldownCandidates.push(
      lastBlockAt + args.minimumBlockFreeMinutes * 60_000,
    );
  }
  const safestCooldown = Math.max(...cooldownCandidates);
  if (safestCooldown > Date.now()) {
    checkpoint.cooldown_until = new Date(safestCooldown).toISOString();
  }
  if (checkpoint.cooldown_until) {
    let remainingMs = Date.parse(checkpoint.cooldown_until) - Date.now();
    if (remainingMs > 0) {
      state.cooldown_until = checkpoint.cooldown_until;
      state.paused_for_cooldown = true;
      saveState();
      console.log(
        JSON.stringify({
          event: "cooldown",
          until: checkpoint.cooldown_until,
          remaining_minutes: Math.ceil(remainingMs / 60_000),
          waiting: args.waitForCooldown,
        }),
      );
      if (!args.waitForCooldown) return;
      while (remainingMs > 0) {
        await sleep(Math.min(remainingMs, 60_000));
        remainingMs = Date.parse(checkpoint.cooldown_until) - Date.now();
      }
    }
    checkpoint.cooldown_until = null;
    state.cooldown_until = null;
    state.paused_for_cooldown = false;
    saveState();
  }

  const browser = await chromium.launch(browserLaunchOptions(args.headed));
  const context = await browser.newContext({
    locale: "pt-BR",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  let pageSizeConfigured = false;
  let effectivePageSize = args.pageSize;

  async function collectLeaf(
    date,
    collection,
    filters,
    expectedCount,
    firstResponse,
  ) {
    const key = windowKey(date, collection, filters);
    if (checkpoint.completed_windows[key]) return;
    state.current = { date, collection: collection.id, filters, expectedCount };
    saveState();
    let returned = 0;
    let newDocuments = 0;
    const first = ingest(firstResponse, collection, {
      date,
      filters,
      page: 0,
      expected_count: expectedCount,
    });
    returned += first.returned;
    newDocuments += first.newDocuments;
    const pages = Math.ceil(expectedCount / effectivePageSize);
    for (let pageNumber = 1; pageNumber < pages; pageNumber += 1) {
      if (limitReached()) return;
      let response = await nextPage(page, collection.id, pageNumber);
      if (!response) {
        throw new Error(
          `Paginação terminou antes do esperado em ${key}, página ${pageNumber}.`,
        );
      }
      for (let attempt = 1; !response.ok && attempt <= 3; attempt += 1) {
        logRequest(
          response,
          {
            date,
            filters,
            page: pageNumber,
            expected_count: expectedCount,
            retry_attempt: attempt - 1,
          },
          false,
        );
        if ([403, 429].includes(response.status)) {
          throw new Error(
            `Falcão respondeu HTTP ${response.status}; retentativas foram desativadas por segurança.`,
          );
        }
        await sleep(5_000 * attempt);
        response = await retryPage(page, collection.id, pageNumber);
        if (!response) break;
      }
      if (!response?.ok) {
        throw new Error(
          `Página ${pageNumber} falhou após retentativas em ${key}.`,
        );
      }
      const result = ingest(response, collection, {
        date,
        filters,
        page: pageNumber,
        expected_count: expectedCount,
      });
      returned += result.returned;
      newDocuments += result.newDocuments;
      if (pageNumber % 5 === 0) saveState();
    }
    checkpoint.completed_windows[key] = {
      completed_at: nowIso(),
      expected_count: expectedCount,
      returned_documents: returned,
      new_documents: newDocuments,
    };
    console.log(
      JSON.stringify({
        event: "window_complete",
        key,
        expected: expectedCount,
        returned,
        new_documents: newDocuments,
        unique_documents: seen.size,
      }),
    );
    saveState();
  }

  async function traverse(
    date,
    collection,
    filters,
    parentCount,
    firstResponse,
    nextFacetIndex,
  ) {
    if (limitReached()) return;
    if (parentCount <= 200) {
      await collectLeaf(
        date,
        collection,
        filters,
        parentCount,
        firstResponse,
      );
      return;
    }
    if (nextFacetIndex >= PARTITION_FACETS.length) {
      const gap = {
        detected_at: nowIso(),
        reason: "window_above_200_after_all_facets",
        date,
        collection: collection.id,
        filters,
        count: parentCount,
      };
      appendJsonl(gapsPath, gap);
      state.coverage_gaps_this_run += 1;
      saveState();
      return;
    }

    const facet = PARTITION_FACETS[nextFacetIndex];
    const items = await readFacetItems(page, facet);
    const childTotal = items.reduce((sum, item) => sum + item.count, 0);
    if (!items.length) {
      const gap = {
        detected_at: nowIso(),
        reason: "facet_without_items",
        date,
        collection: collection.id,
        filters,
        parent_count: parentCount,
        facet,
      };
      appendJsonl(gapsPath, gap);
      state.coverage_gaps_this_run += 1;
      saveState();
      await traverse(
        date,
        collection,
        filters,
        parentCount,
        firstResponse,
        nextFacetIndex + 1,
      );
      return;
    }
    if (childTotal !== parentCount) {
      appendJsonl(gapsPath, {
        detected_at: nowIso(),
        reason: "facet_count_mismatch",
        date,
        collection: collection.id,
        filters,
        parent_count: parentCount,
        facet,
        child_total: childTotal,
        difference: parentCount - childTotal,
      });
      state.coverage_gaps_this_run += 1;
    }

    for (const item of items) {
      if (limitReached()) return;
      const response = await selectFacetItem(
        page,
        collection.id,
        facet,
        item,
      );
      logRequest(response, {
        event: "select_facet",
        date,
        collection: collection.id,
        facet,
        item: item.name,
      });
      const childFilters = [...filters, { facet, name: item.name }];
      await traverse(
        date,
        collection,
        childFilters,
        item.count,
        response,
        nextFacetIndex + 1,
      );
      if (limitReached()) return;
      const restored = await removeFacetItem(page, collection.id, item);
      logRequest(restored, {
        event: "remove_facet",
        date,
        collection: collection.id,
        facet,
        item: item.name,
      });
    }
    if (childTotal < parentCount && !limitReached()) {
      await traverse(
        date,
        collection,
        filters,
        parentCount,
        firstResponse,
        nextFacetIndex + 1,
      );
    }
  }

  try {
    const navigation = await page.goto(FRONTEND_URL, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    await page.waitForSelector(
      '[aria-label="Campo de busca do sistema. Faça sua pesquisa."]',
      { timeout: 90_000 },
    );
    if (navigation?.status() !== 200) {
      throw new Error(`Frontend respondeu HTTP ${navigation?.status()}.`);
    }
    await page.waitForTimeout(1_000);
    await dismissCookieBanner(page);

    for (const date of dateRange(args.startDate, args.endDate)) {
      if (limitReached()) break;
      let currentCollection = selectedCollections[0];
      const initialCollectionResponse = await selectCollection(
        page,
        currentCollection,
      );
      if (initialCollectionResponse) {
        logRequest(initialCollectionResponse, {
          event: "select_collection",
          date,
          collection: currentCollection.id,
        });
      }
      let response = await setSingleDay(page, currentCollection.id, date);
      logRequest(response, {
        event: "set_date",
        date,
        collection: currentCollection.id,
      });
      if (!pageSizeConfigured) {
        const pageSizeResult = await selectPageSize(
          page,
          currentCollection.id,
          args.pageSize,
        );
        response = pageSizeResult.response;
        effectivePageSize = pageSizeResult.pageSize;
        state.effective_page_size = effectivePageSize;
        logRequest(response, {
          event: "set_page_size",
          date,
          collection: currentCollection.id,
        });
        pageSizeConfigured = true;
      }

      for (const collection of selectedCollections) {
        if (limitReached()) break;
        const collectionKey = `${date}|${collection.id}`;
        if (checkpoint.completed_collections[collectionKey]) continue;
        currentCollection = collection;
        const collectionResponse = await selectCollection(page, collection);
        if (collectionResponse) {
          logRequest(collectionResponse, {
            event: "select_collection",
            date,
            collection: collection.id,
          });
        }
        const tribunals = await readFacetItems(page, "Tribunal");
        console.log(
          JSON.stringify({
            event: "partition_plan",
            date,
            collection: collection.id,
            tribunals: tribunals.length,
            documents: tribunals.reduce((sum, item) => sum + item.count, 0),
          }),
        );
        for (const tribunal of tribunals) {
          if (limitReached()) break;
          const partitionKey = `${date}|${collection.id}|Tribunal=${tribunal.name}`;
          if (checkpoint.completed_partitions[partitionKey]) continue;
          const tribunalResponse = await selectFacetItem(
            page,
            collection.id,
            "Tribunal",
            tribunal,
          );
          logRequest(tribunalResponse, {
            event: "select_facet",
            date,
            collection: collection.id,
            facet: "Tribunal",
            item: tribunal.name,
          });
          await traverse(
            date,
            collection,
            [{ facet: "Tribunal", name: tribunal.name }],
            tribunal.count,
            tribunalResponse,
            1,
          );
          if (limitReached()) break;
          const restored = await removeFacetItem(
            page,
            collection.id,
            tribunal,
          );
          logRequest(restored, {
            event: "remove_facet",
            date,
            collection: collection.id,
            facet: "Tribunal",
            item: tribunal.name,
          });
          checkpoint.completed_partitions[partitionKey] = {
            completed_at: nowIso(),
            expected_count: tribunal.count,
          };
          saveState();
        }
        if (!limitReached()) {
          checkpoint.completed_collections[collectionKey] = {
            completed_at: nowIso(),
            tribunals: tribunals.length,
          };
          saveState();
        }
      }
    }
    state.stopped_by_limit = limitReached();
    state.current = null;
    state.finished_at = nowIso();
    saveState();
  } catch (error) {
    if (error instanceof RequestBudgetReached || error instanceof CollectionPaused) {
      state.stopped_by_request_budget = true;
      state.stop_reason = String(error);
      state.paused_by_control = error instanceof CollectionPaused;
      state.current = null;
      state.finished_at = nowIso();
      saveState();
      console.log(
        JSON.stringify({
          event: error instanceof CollectionPaused ? "paused_by_control" : "request_budget_reached",
          requests: requestPacing.requestsStarted,
          at: state.finished_at,
        }),
      );
    } else {
      state.error = String(error);
      saveState();
      await page
        .screenshot({ path: path.join(outputDir, "failure.png"), fullPage: true })
        .catch(() => {});
      await fs.promises
        .writeFile(path.join(outputDir, "failure.html"), await page.content())
        .catch(() => {});
      throw error;
    }
  } finally {
    await browser.close();
  }

  console.log(JSON.stringify({ event: "finish", ...state }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
