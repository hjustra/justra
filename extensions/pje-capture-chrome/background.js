const JUSTRA_LOCAL_IMPORT_URL = "http://127.0.0.1:8787/api/pje-extension/import";

async function importIntoJustra(payload) {
  const response = await fetch(JUSTRA_LOCAL_IMPORT_URL, {
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
    throw new Error(data.error || `Justra respondeu HTTP ${response.status}`);
  }
  return data;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "JUSTRA_IMPORT_PJE") {
    return false;
  }

  importIntoJustra(message.payload)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});
