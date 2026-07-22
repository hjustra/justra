const JUSTRA_IMPORT_PATH = "/api/pje-extension/import";
const JUSTRA_SESSION_CONFIRM_PATH = "/api/pje-extension/session/confirm";
const DEFAULT_ENVIRONMENT_NAME = "production";

const JUSTRA_ENVIRONMENTS = [
  {
    name: "production",
    label: "Justra produção",
    baseUrl: "https://justra.com.br"
  },
  {
    name: "staging",
    label: "Justra staging",
    baseUrl: "https://staging.justra.com.br"
  }
];

function importUrlForEnvironment(environment) {
  return `${environment.baseUrl}${JUSTRA_IMPORT_PATH}`;
}

function sessionConfirmUrlForEnvironment(environment) {
  return `${environment.baseUrl}${JUSTRA_SESSION_CONFIRM_PATH}`;
}

function environmentFromUrl(url) {
  const value = String(url || "");
  return JUSTRA_ENVIRONMENTS.find((environment) => value === environment.baseUrl || value.startsWith(`${environment.baseUrl}/`)) || null;
}

function environmentFromPayload(payload) {
  const page = payload && typeof payload.page === "object" ? payload.page : {};
  return environmentFromUrl(page.referrer) || environmentFromUrl(page.source_app_url);
}

async function environmentFromOpenJustraTab() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({
      url: JUSTRA_ENVIRONMENTS.map((environment) => `${environment.baseUrl}/*`)
    });
  } catch (_error) {
    return null;
  }

  const candidates = tabs
    .map((tab) => ({ tab, environment: environmentFromUrl(tab.url) }))
    .filter((candidate) => candidate.environment);

  if (!candidates.length) {
    return null;
  }

  candidates.sort((left, right) => {
    if (left.tab.active !== right.tab.active) {
      return left.tab.active ? -1 : 1;
    }
    return Number(right.tab.lastAccessed || 0) - Number(left.tab.lastAccessed || 0);
  });

  return candidates[0].environment;
}

async function resolveImportEnvironment(payload) {
  return (
    environmentFromPayload(payload) ||
    await environmentFromOpenJustraTab() ||
    JUSTRA_ENVIRONMENTS.find((environment) => environment.name === DEFAULT_ENVIRONMENT_NAME) ||
    JUSTRA_ENVIRONMENTS[0]
  );
}

async function importIntoJustra(payload) {
  const environment = await resolveImportEnvironment(payload);
  const importUrl = importUrlForEnvironment(environment);
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

async function confirmPjeSession(payload) {
  const explicitEnvironment = environmentFromUrl(payload && payload.justra_origin);
  const environment = explicitEnvironment || await resolveImportEnvironment(payload);
  const confirmUrl = sessionConfirmUrlForEnvironment(environment);
  const response = await fetch(confirmUrl, {
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
    confirm_url: confirmUrl
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) {
    return false;
  }

  if (message.type === "JUSTRA_IMPORT_PJE") {
    importIntoJustra(message.payload)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "JUSTRA_CONFIRM_PJE_SESSION") {
    confirmPjeSession(message.payload)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});
