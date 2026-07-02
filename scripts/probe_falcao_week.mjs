import fs from "node:fs";
import path from "node:path";
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
const API_PATH =
  "/jurisprudencia-nacional-backend/api/no-auth/pesquisa";
const DEFAULT_CHROME_PATH =
  process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "";
const CHROME_PATH = process.env.JUSTRA_CHROME_PATH || DEFAULT_CHROME_PATH;
const OUTPUT_PATH = path.join(
  DATA_ROOT,
  "samples",
  "falcao",
  "week_pagination_probe.json",
);

function browserLaunchOptions(headed = false) {
  const options = { headless: !headed };
  if (CHROME_PATH) options.executablePath = CHROME_PATH;
  return options;
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

function findTotal(payload) {
  for (const key of [
    "total",
    "totalResultados",
    "totalRegistros",
    "totalElements",
    "quantidade",
  ]) {
    if (Number.isFinite(payload?.[key])) return payload[key];
  }
  return null;
}

async function main() {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  const browser = await chromium.launch(browserLaunchOptions(true));
  const context = await browser.newContext({
    locale: "pt-BR",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();

  try {
    await page.goto(FRONTEND_URL, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    await page.waitForSelector(
      '[aria-label="Campo de busca do sistema. Faça sua pesquisa."]',
      { timeout: 90_000 },
    );
    await page.waitForTimeout(1_000);

    const weeklyResponsePromise = page.waitForResponse(
      (response) => isSearchResponse(response, "acordaos", 0),
      { timeout: 90_000 },
    );
    await page
      .locator("div.item:visible", { hasText: "Últimos 7 dias" })
      .click();
    const weeklyResponse = await weeklyResponsePromise;
    const weeklyUrl = weeklyResponse.url();
    const weeklyPayload = await weeklyResponse.json();

    const pages = [0, 19, 20, 50, 500];
    const probes = [];
    for (const pageNumber of pages) {
      const url = new URL(weeklyUrl);
      url.searchParams.set("page", String(pageNumber));
      url.searchParams.set("size", "20");
      const result = await page.evaluate(async (targetUrl) => {
        const startedAt = Date.now();
        const response = await fetch(targetUrl, {
          headers: { accept: "application/json, text/plain, */*" },
          referrer:
            "https://jurisprudencia.jt.jus.br/jurisprudencia-nacional/pesquisa",
        });
        const body = await response.text();
        return {
          ok: response.ok,
          status: response.status,
          elapsed_ms: Date.now() - startedAt,
          body,
        };
      }, url.toString());
      let payload = null;
      try {
        payload = JSON.parse(result.body);
      } catch {
        payload = null;
      }
      probes.push({
        page: pageNumber,
        status: result.status,
        ok: result.ok,
        elapsed_ms: result.elapsed_ms,
        response_bytes: Buffer.byteLength(result.body),
        document_count: Array.isArray(payload?.documentos)
          ? payload.documentos.length
          : null,
        total: findTotal(payload),
        first_document_id:
          payload?.documentos?.[0]?.idDocumentoAcordao || null,
        body_sample: payload ? "" : result.body.slice(0, 500),
      });
      await page.waitForTimeout(500);
    }

    const output = {
      generated_at: new Date().toISOString(),
      weekly_url: weeklyUrl,
      weekly_query: Object.fromEntries(new URL(weeklyUrl).searchParams),
      initial_total: findTotal(weeklyPayload),
      initial_documents: weeklyPayload?.documentos?.length || 0,
      probes,
    };
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
    console.log(JSON.stringify(output, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
