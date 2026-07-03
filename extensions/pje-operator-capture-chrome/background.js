const JUSTRA_IMPORT_PATH = "/api/pje-extension/import";
const DEFAULT_SETTINGS = {
  enabled: true,
  environmentName: "staging",
  autoCapture: true,
  settleDelayMs: 2500,
  resendCooldownMinutes: 60,
  expectedProcessNumber: "",
  jobId: ""
};

const JUSTRA_ENVIRONMENTS = [
  {
    name: "local",
    label: "Justra local",
    baseUrl: "http://127.0.0.1:8787"
  },
  {
    name: "staging",
    label: "Justra staging",
    baseUrl: "https://staging.justra.com.br"
  },
  {
    name: "production",
    label: "Justra produção",
    baseUrl: "https://justra.com.br"
  }
];

function normalizeProcessNumber(value) {
  return String(value || "").replace(/\D/g, "");
}

function settingsWithDefaults(settings = {}) {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    expectedProcessNumber: normalizeProcessNumber(settings.expectedProcessNumber),
    jobId: String(settings.jobId || "").trim()
  };
}

async function getSettings() {
  const stored = await chrome.storage.local.get(["operatorSettings"]);
  return settingsWithDefaults(stored.operatorSettings || {});
}

async function saveSettings(partialSettings = {}) {
  const current = await getSettings();
  const next = settingsWithDefaults({ ...current, ...partialSettings });
  await chrome.storage.local.set({ operatorSettings: next });
  return next;
}

function environmentByName(name) {
  return JUSTRA_ENVIRONMENTS.find((environment) => environment.name === name) || JUSTRA_ENVIRONMENTS[1];
}

function importUrlForSettings(settings) {
  return `${environmentByName(settings.environmentName).baseUrl}${JUSTRA_IMPORT_PATH}`;
}

async function importIntoJustra(payload) {
  const settings = await getSettings();
  const environment = environmentByName(settings.environmentName);
  const importUrl = importUrlForSettings(settings);
  const response = await fetch(importUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
    credentials: "omit"
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    data = { error: text || error.message };
  }
  if (!response.ok) {
    throw new Error(data.error || `${environment.label} respondeu HTTP ${response.status}`);
  }
  return {
    ...data,
    import_environment: environment.name,
    import_environment_label: environment.label,
    import_url: importUrl
  };
}

function activePjeTab() {
  return chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => tabs[0] || null);
}

function isPjeTab(tab) {
  return Boolean(tab && tab.url && tab.url.startsWith("https://pje.trt2.jus.br/"));
}

async function ensureContentScript(tab) {
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "JUSTRA_PJE_PING" });
    return;
  } catch (_error) {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  }
}

async function captureActiveTabNow() {
  const tab = await activePjeTab();
  if (!isPjeTab(tab)) {
    throw new Error("abra uma página do PJe TRT2 antes de capturar");
  }
  await ensureContentScript(tab);
  return chrome.tabs.sendMessage(tab.id, { type: "JUSTRA_OPERATOR_CAPTURE_NOW" });
}

chrome.runtime.onInstalled.addListener(async () => {
  await saveSettings({});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) {
    return false;
  }

  if (message.type === "JUSTRA_OPERATOR_GET_SETTINGS") {
    getSettings()
      .then((settings) => sendResponse({ ok: true, settings, environments: JUSTRA_ENVIRONMENTS }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "JUSTRA_OPERATOR_SAVE_SETTINGS") {
    saveSettings(message.settings || {})
      .then((settings) => sendResponse({ ok: true, settings, environments: JUSTRA_ENVIRONMENTS }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "JUSTRA_OPERATOR_IMPORT_PJE") {
    importIntoJustra(message.payload)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "JUSTRA_OPERATOR_CAPTURE_ACTIVE_TAB") {
    captureActiveTabNow()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});
