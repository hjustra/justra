import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const RUNTIME_NODE_MODULES =
  "/Users/heitordoamaraljurkovich/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const require = createRequire(path.join(RUNTIME_NODE_MODULES, "package.json"));
const { chromium } = require("playwright");

const FRONTEND_URL =
  "https://jurisprudencia.jt.jus.br/jurisprudencia-nacional/pesquisa";
const API_URL =
  "https://jurisprudencia.jt.jus.br/jurisprudencia-nacional-backend/api/no-auth/pesquisa";
const CITATION_BASE =
  "https://jurisprudencia.jt.jus.br/jurisprudencia-nacional/citacao";
const CHROME_PATH =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUTPUT_DIR = path.join(ROOT, "data", "samples", "falcao");

const COLLECTIONS = [
  { id: "acordaos", label: "Acórdãos", expectedTotal: 11_756_525 },
  {
    id: "decisoesmonocraticas",
    label: "Decisões Monocráticas",
    expectedTotal: 11_878_421,
  },
  { id: "sentencas", label: "Sentenças", expectedTotal: 27_812_004 },
  {
    id: "recursorevista",
    label: "Admissibilidade de Recurso de Revista",
    expectedTotal: 3_364_012,
  },
  { id: "precedentes", label: "Precedentes", expectedTotal: 11_350 },
];

function parseArgs(argv) {
  const args = {
    limitPerCollection: 250,
    pageSize: 10,
    sleepMs: 1000,
    maxRetries: 3,
    outputTag: "sample_1000",
    headed: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--limit-per-collection") {
      args.limitPerCollection = Number(argv[++index]);
    } else if (value === "--page-size") {
      args.pageSize = Number(argv[++index]);
    } else if (value === "--sleep-ms") {
      args.sleepMs = Number(argv[++index]);
    } else if (value === "--max-retries") {
      args.maxRetries = Number(argv[++index]);
    } else if (value === "--output-tag") {
      args.outputTag = argv[++index];
    } else if (value === "--headless") {
      args.headed = false;
    }
  }
  if (
    !Number.isInteger(args.limitPerCollection) ||
    args.limitPerCollection <= 0 ||
    !Number.isInteger(args.pageSize) ||
    args.pageSize <= 0
  ) {
    throw new Error("Limites inválidos.");
  }
  return args;
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values, probability) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(probability * sorted.length) - 1),
  );
  return sorted[position];
}

function stats(values) {
  if (!values.length) {
    return { count: 0, min: 0, max: 0, avg: 0, p50: 0, p95: 0 };
  }
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    count: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    avg: sum / values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
  };
}

function extractTopLevelNumbers(payload) {
  return Object.fromEntries(
    Object.entries(payload || {}).filter(
      ([, value]) => typeof value === "number" && Number.isFinite(value),
    ),
  );
}

function textFieldLengths(document) {
  const fields = {};
  for (const [key, value] of Object.entries(document || {})) {
    if (typeof value !== "string" || !value) continue;
    if (
      /(texto|ementa|acordao|acórdão|decisao|decisão|sentenca|sentença|inteiro|conteudo|conteúdo)/i.test(
        key,
      )
    ) {
      fields[key] = value.length;
    }
  }
  return fields;
}

function documentMetrics(document) {
  const serialized = JSON.stringify(document);
  const fieldLengths = textFieldLengths(document);
  const primaryTextChars = Math.max(0, ...Object.values(fieldLengths));
  return {
    json_bytes: Buffer.byteLength(serialized),
    gzip_bytes: zlib.gzipSync(serialized).length,
    primary_text_chars: primaryTextChars,
    text_field_lengths: fieldLengths,
  };
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
  if (id) {
    return `${collection}:${document.tribunal || "sem-tribunal"}:${id}`;
  }
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

function appendJsonl(filePath, row) {
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`);
}

function estimateBytes(averageBytes, totalDocuments) {
  return averageBytes * totalDocuments;
}

function humanBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(2)} ${units[unitIndex]}`;
}

function findReportedTotal(payload, fallback) {
  const candidates = [
    "total",
    "totalResultados",
    "totalRegistros",
    "totalElements",
    "quantidade",
  ];
  for (const key of candidates) {
    const value = payload?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return fallback;
}

function buildApiUrl({ collection, page, pageSize, sessionId }) {
  const url = new URL(API_URL);
  const params = {
    sessionId,
    latitude: "0",
    longitude: "0",
    texto: "",
    verTodosPrecedentes: "false",
    tribunais: "",
    pesquisaSomenteNasEmentas: "false",
    colecao: collection,
    page: String(page),
    size: String(pageSize),
  };
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function matchesCollectionResponse(response, collection, expectedPage = null) {
  try {
    const url = new URL(response.url());
    const apiUrl = new URL(API_URL);
    if (url.origin !== apiUrl.origin || url.pathname !== apiUrl.pathname) {
      return false;
    }
    if (url.searchParams.get("colecao") !== collection) return false;
    if (
      expectedPage !== null &&
      Number(url.searchParams.get("page")) !== expectedPage
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function captureUiResponse(page, collection, expectedPage, action) {
  const startedAt = Date.now();
  const responsePromise = page.waitForResponse(
    (response) =>
      matchesCollectionResponse(response, collection, expectedPage),
    { timeout: 90_000 },
  );
  await action();
  const response = await responsePromise;
  let responseText = "";
  let error = "";
  try {
    responseText = await response.text();
  } catch (responseError) {
    error = String(responseError);
  }
  return {
    ok: response.ok(),
    status: response.status(),
    elapsed_ms: Date.now() - startedAt,
    content_type: response.headers()["content-type"] || "",
    content_encoding: response.headers()["content-encoding"] || "",
    response_text: responseText,
    error,
    url: response.url(),
  };
}

async function selectCollection(page, collection) {
  const selector = `[aria-label^="${collection.label}. Quantidade:"]:visible`;
  let target = page.locator(selector).first();
  if (!(await target.isVisible().catch(() => false))) {
    await page
      .getByRole("button", {
        name: "Filtros laterais. Clique para abrir.",
      })
      .click();
    target = page.locator(selector).first();
    await target.waitFor({ state: "visible", timeout: 15_000 });
  }
  return captureUiResponse(page, collection.id, 0, () => target.click());
}

async function selectPageSize(page, collection, pageSize) {
  await page
    .getByRole("button", { name: "dropdown trigger" })
    .last()
    .click();
  const option = page.getByRole("option", {
    name: String(pageSize),
    exact: true,
  });
  await option.waitFor({ state: "visible", timeout: 10_000 });
  return captureUiResponse(page, collection.id, 0, () => option.click());
}

async function goToNextPage(page, collection, pageNumber) {
  const nextButton = page
    .locator("button.p-paginator-next:visible:not([disabled])")
    .first();
  if (!(await nextButton.isVisible().catch(() => false))) {
    return null;
  }
  return captureUiResponse(page, collection.id, pageNumber, () =>
    nextButton.click(),
  );
}

async function searchCollection(page, collection, query) {
  const searchInput = page.getByRole("combobox", {
    name: "Campo de busca do sistema. Faça sua pesquisa.",
  });
  await searchInput.fill(query);
  return captureUiResponse(page, collection.id, 0, () =>
    searchInput.press("Enter"),
  );
}

async function clearCollectionSearch(page, collection) {
  const searchInput = page.getByRole("combobox", {
    name: "Campo de busca do sistema. Faça sua pesquisa.",
  });
  await searchInput.fill("");
  await captureUiResponse(page, collection.id, 0, () =>
    searchInput.press("Enter"),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const documentsPath = path.join(
    OUTPUT_DIR,
    `${args.outputTag}_documents.jsonl`,
  );
  const requestsPath = path.join(
    OUTPUT_DIR,
    `${args.outputTag}_requests.jsonl`,
  );
  const summaryPath = path.join(OUTPUT_DIR, `${args.outputTag}_summary.json`);
  const checkpointPath = path.join(
    OUTPUT_DIR,
    `${args.outputTag}_checkpoint.json`,
  );
  for (const filePath of [
    documentsPath,
    requestsPath,
    summaryPath,
    checkpointPath,
  ]) {
    fs.rmSync(filePath, { force: true });
  }

  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: !args.headed,
  });
  const context = await browser.newContext({
    locale: "pt-BR",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  let sessionId = "";
  page.on("request", (request) => {
    const requestUrl = request.url();
    if (
      sessionId ||
      !requestUrl.includes(
        "/jurisprudencia-nacional-backend/api/no-auth/pesquisa?",
      )
    ) {
      return;
    }
    try {
      sessionId = new URL(requestUrl).searchParams.get("sessionId") || "";
    } catch {
      sessionId = "";
    }
  });
  page.on("response", (response) => {
    try {
      const responseUrl = new URL(response.url());
      const apiUrl = new URL(API_URL);
      if (
        responseUrl.origin === apiUrl.origin &&
        responseUrl.pathname === apiUrl.pathname
      ) {
        console.log(
          JSON.stringify({
            event: "api_response",
            at: nowIso(),
            status: response.status(),
            collection: responseUrl.searchParams.get("colecao"),
            page: responseUrl.searchParams.get("page"),
            size: responseUrl.searchParams.get("size"),
          }),
        );
      }
    } catch {
      // Ignore non-URL browser events.
    }
  });
  browser.on("disconnected", () => {
    console.error(JSON.stringify({ event: "browser_disconnected", at: nowIso() }));
  });
  page.on("close", () => {
    console.error(JSON.stringify({ event: "page_closed", at: nowIso() }));
  });
  page.on("crash", () => {
    console.error(JSON.stringify({ event: "page_crashed", at: nowIso() }));
  });
  const runStartedAt = Date.now();
  const seen = new Set();
  const allRequestMetrics = [];
  const collectionSummaries = [];
  let blockEvents = 0;
  let errorEvents = 0;
  let pageSizeConfigured = false;

  try {
    const configResponsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith("/assets/config/config.json") &&
        response.status() === 200,
      { timeout: 90_000 },
    );
    const [navigation] = await Promise.all([
      page.goto(FRONTEND_URL, {
        waitUntil: "domcontentloaded",
        timeout: 90_000,
      }),
      configResponsePromise,
    ]);
    await page.waitForTimeout(3_000);
    if (navigation?.status() !== 200 || (await page.title()).startsWith("ERROR")) {
      throw new Error(
        `Frontend bloqueado: HTTP ${navigation?.status() || "sem status"} - ${await page.title()}`,
      );
    }
    console.log(
      JSON.stringify({
        event: "frontend_ready",
        at: nowIso(),
        status: navigation?.status() || null,
        title: await page.title(),
      }),
    );
    for (let attempt = 0; attempt < 50 && !sessionId; attempt += 1) {
      await page.waitForTimeout(100);
    }
    if (!sessionId) {
      throw new Error("A aplicação não forneceu sessionId.");
    }

    for (const collection of COLLECTIONS) {
      const collectionStartedAt = Date.now();
      const collectionMetrics = [];
      const responseBytes = [];
      const primaryTextChars = [];
      const jsonBytes = [];
      const gzipBytes = [];
      let collected = 0;
      let pageNumber = 0;
      let duplicates = 0;
      let reportedTotal = collection.expectedTotal;
      let lastTopLevelNumbers = {};
      let initialized = false;
      let fallbackQuery = "";

      while (collected < args.limitPerCollection) {
        let response;
        if (!initialized) {
          response = await selectCollection(page, collection);
          initialized = true;
          if (args.pageSize !== 5 && !pageSizeConfigured) {
            response = await selectPageSize(
              page,
              collection,
              args.pageSize,
            );
            pageSizeConfigured = true;
          }
        } else {
          response = await goToNextPage(page, collection, pageNumber);
          if (!response && !fallbackQuery) {
            fallbackQuery = "horas extras";
            pageNumber = 0;
            response = await searchCollection(
              page,
              collection,
              fallbackQuery,
            );
          }
          if (!response) {
            throw new Error(
              `Paginação esgotada em ${collection.id} antes de ${args.limitPerCollection} documentos únicos.`,
            );
          }
        }

        const requestRow = {
          collected_at: nowIso(),
          collection: collection.id,
          page: pageNumber,
          page_size: args.pageSize,
          attempt: 1,
          status: response.status,
          ok: response.ok,
          elapsed_ms: response.elapsed_ms,
          response_bytes: Buffer.byteLength(response.response_text || ""),
          content_type: response.content_type,
          error: response.error,
          url: response.url,
          query_window: fallbackQuery,
        };
        appendJsonl(requestsPath, requestRow);
        allRequestMetrics.push(requestRow);
        collectionMetrics.push(requestRow);
        responseBytes.push(requestRow.response_bytes);
        if ([403, 429].includes(response.status)) blockEvents += 1;
        if (!response.ok) errorEvents += 1;

        if (!response?.ok) {
          throw new Error(
            `Falha na coleção ${collection.id}, página ${pageNumber}: HTTP ${response?.status || 0} ${response?.error || ""}`,
          );
        }

        let payload;
        try {
          payload = JSON.parse(response.response_text);
        } catch (error) {
          throw new Error(
            `JSON inválido na coleção ${collection.id}, página ${pageNumber}: ${error}`,
          );
        }
        const documents = Array.isArray(payload.documentos)
          ? payload.documentos
          : [];
        reportedTotal = findReportedTotal(payload, reportedTotal);
        lastTopLevelNumbers = extractTopLevelNumbers(payload);
        if (!documents.length) break;

        for (let index = 0; index < documents.length; index += 1) {
          if (collected >= args.limitPerCollection) break;
          const document = documents[index];
          const key = documentKey(collection.id, document);
          if (seen.has(key)) {
            duplicates += 1;
            continue;
          }
          seen.add(key);
          const metrics = documentMetrics(document);
          jsonBytes.push(metrics.json_bytes);
          gzipBytes.push(metrics.gzip_bytes);
          primaryTextChars.push(metrics.primary_text_chars);
          appendJsonl(documentsPath, {
            ...document,
            _justra: {
              collected_at: nowIso(),
              collection: collection.id,
              collection_label: collection.label,
              page: pageNumber,
              index_in_page: index,
              query_window: fallbackQuery,
              document_key: key,
              citation_url: citationUrl(collection.id, document),
              metrics,
            },
          });
          collected += 1;
        }

        fs.writeFileSync(
          checkpointPath,
          JSON.stringify(
            {
              updated_at: nowIso(),
              collection: collection.id,
              page: pageNumber,
              query_window: fallbackQuery,
              collected_in_collection: collected,
              collected_total: seen.size,
              block_events: blockEvents,
              error_events: errorEvents,
            },
            null,
            2,
          ),
        );
        console.log(
          JSON.stringify({
            event: "progress",
            collection: collection.id,
            page: pageNumber,
            collected,
            target: args.limitPerCollection,
            status: response.status,
            elapsed_ms: response.elapsed_ms,
            response_bytes: Buffer.byteLength(response.response_text),
            block_events: blockEvents,
          }),
        );
        pageNumber += 1;
        if (collected < args.limitPerCollection) {
          await sleep(args.sleepMs);
        }
      }

      if (fallbackQuery) {
        await clearCollectionSearch(page, collection);
      }

      const jsonStats = stats(jsonBytes);
      const gzipStats = stats(gzipBytes);
      const textStats = stats(primaryTextChars);
      collectionSummaries.push({
        collection: collection.id,
        label: collection.label,
        sampled_documents: collected,
        duplicate_documents: duplicates,
        fallback_query: fallbackQuery,
        reported_total: reportedTotal,
        top_level_numeric_fields: lastTopLevelNumbers,
        elapsed_ms: Date.now() - collectionStartedAt,
        requests: collectionMetrics.length,
        request_latency_ms: stats(collectionMetrics.map((row) => row.elapsed_ms)),
        response_bytes: stats(responseBytes),
        document_json_bytes: jsonStats,
        document_gzip_bytes: gzipStats,
        primary_text_chars: textStats,
        estimated_collection_raw_json_bytes: estimateBytes(
          jsonStats.avg,
          reportedTotal,
        ),
        estimated_collection_raw_json: humanBytes(
          estimateBytes(jsonStats.avg, reportedTotal),
        ),
        estimated_collection_gzip_bytes: estimateBytes(
          gzipStats.avg,
          reportedTotal,
        ),
        estimated_collection_gzip: humanBytes(
          estimateBytes(gzipStats.avg, reportedTotal),
        ),
      });
    }
  } finally {
    await browser.close();
  }

  const estimatedAllRaw = collectionSummaries.reduce(
    (sum, item) => sum + item.estimated_collection_raw_json_bytes,
    0,
  );
  const estimatedAllGzip = collectionSummaries.reduce(
    (sum, item) => sum + item.estimated_collection_gzip_bytes,
    0,
  );
  const summary = {
    generated_at: nowIso(),
    started_at: new Date(runStartedAt).toISOString(),
    elapsed_ms: Date.now() - runStartedAt,
    requested_documents:
      args.limitPerCollection * COLLECTIONS.length,
    unique_documents: seen.size,
    page_size: args.pageSize,
    sleep_ms: args.sleepMs,
    headed: args.headed,
    session_id: sessionId,
    total_requests: allRequestMetrics.length,
    status_counts: Object.fromEntries(
      [...new Set(allRequestMetrics.map((row) => row.status))].map((status) => [
        String(status),
        allRequestMetrics.filter((row) => row.status === status).length,
      ]),
    ),
    block_events: blockEvents,
    error_events: errorEvents,
    request_latency_ms: stats(
      allRequestMetrics.map((row) => row.elapsed_ms),
    ),
    response_bytes: stats(
      allRequestMetrics.map((row) => row.response_bytes),
    ),
    collections: collectionSummaries,
    estimated_all_collections_raw_json_bytes: estimatedAllRaw,
    estimated_all_collections_raw_json: humanBytes(estimatedAllRaw),
    estimated_all_collections_gzip_bytes: estimatedAllGzip,
    estimated_all_collections_gzip: humanBytes(estimatedAllGzip),
    files: {
      documents: documentsPath,
      requests: requestsPath,
      checkpoint: checkpointPath,
      summary: summaryPath,
    },
  };
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ event: "finish", ...summary }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
