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

const BASE_URL =
  "https://jurisprudencia.jt.jus.br/jurisprudencia-nacional/pesquisa";
const DEFAULT_CHROME_PATH =
  process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "";
const CHROME_PATH = process.env.JUSTRA_CHROME_PATH || DEFAULT_CHROME_PATH;
const OUTPUT_DIR = path.join(DATA_ROOT, "samples", "falcao");
const OUTPUT_PATH = path.join(OUTPUT_DIR, "network_probe.json");
const headed = process.argv.includes("--headed");

function browserLaunchOptions() {
  const options = { headless: !headed };
  if (CHROME_PATH) options.executablePath = CHROME_PATH;
  return options;
}

function nowIso() {
  return new Date().toISOString();
}

function compactHeaders(headers) {
  const allowed = new Set([
    "content-type",
    "content-length",
    "content-encoding",
    "cache-control",
    "server",
    "via",
    "x-cache",
  ]);
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => allowed.has(key.toLowerCase())),
  );
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const browser = await chromium.launch(browserLaunchOptions());
  const context = await browser.newContext({
    locale: "pt-BR",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const startedAt = Date.now();
  const events = [];

  page.on("response", async (response) => {
    const request = response.request();
    const resourceType = request.resourceType();
    const contentType = response.headers()["content-type"] || "";
    if (
      !["xhr", "fetch"].includes(resourceType) &&
      !contentType.includes("json")
    ) {
      return;
    }

    const event = {
      captured_at: nowIso(),
      method: request.method(),
      resource_type: resourceType,
      status: response.status(),
      url: response.url(),
      request_headers: request.headers(),
      request_post_data: request.postData() || "",
      response_headers: compactHeaders(response.headers()),
      body_bytes: 0,
      body_sample: "",
      body_error: "",
    };
    try {
      const body = await response.body();
      event.body_bytes = body.length;
      if (
        contentType.includes("json") ||
        contentType.includes("text") ||
        contentType.includes("javascript")
      ) {
        event.body_sample = body.toString("utf8").slice(0, 4000);
      }
    } catch (error) {
      event.body_error = String(error);
    }
    events.push(event);
  });

  let result = {};
  try {
    const response = await page.goto(BASE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    await page.waitForSelector('[aria-label="Campo de busca do sistema. Faça sua pesquisa."]', {
      timeout: 90_000,
    });

    await page.waitForTimeout(2_000);

    result = {
      ok: true,
      navigation_status: response?.status() || null,
      title: await page.title(),
      url: page.url(),
      elapsed_ms: Date.now() - startedAt,
      result_summary: "",
      headed,
    };
  } catch (error) {
    result = {
      ok: false,
      error: String(error),
      elapsed_ms: Date.now() - startedAt,
      title: await page.title().catch(() => ""),
      url: page.url(),
      headed,
    };
  } finally {
    await browser.close();
  }

  const payload = {
    generated_at: nowIso(),
    base_url: BASE_URL,
    result,
    event_count: events.length,
    events,
  };
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
