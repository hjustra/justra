const statusElement = document.getElementById("status");

function setStatus(message) {
  statusElement.textContent = message;
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

function isPjeTab(tab) {
  return Boolean(tab && tab.url && tab.url.startsWith("https://pje.trt2.jus.br/consultaprocessual/"));
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

async function sendToContent(type) {
  const tab = await activeTab();
  if (!isPjeTab(tab)) {
    setStatus("Abra uma consulta processual do PJe TRT2 antes de usar.");
    return null;
  }
  await ensureContentScript(tab);
  return chrome.tabs.sendMessage(tab.id, { type });
}

function resultLabel(result) {
  const processLabel = result.process_number || "processo";
  const captured = result.captured_candidates || 0;
  const total = result.document_candidates || 0;
  return `${processLabel}: ${captured}/${total} documento(s).`;
}

document.getElementById("downloadAllDocuments").addEventListener("click", async () => {
  try {
    setStatus("Capturando documentos para baixar...");
    const result = await sendToContent("JUSTRA_DOWNLOAD_ALL_DOCUMENTS_NOW");
    if (result) {
      setStatus(`Baixado. ${resultLabel(result)}`);
    }
  } catch (error) {
    setStatus(`Não consegui baixar: ${error.message}`);
  }
});

document.getElementById("sendAllDocuments").addEventListener("click", async () => {
  try {
    setStatus("Capturando documentos para enviar...");
    const result = await sendToContent("JUSTRA_SEND_ALL_DOCUMENTS_NOW");
    if (result) {
      setStatus(`Enviado. ${resultLabel(result)}`);
    }
  } catch (error) {
    setStatus(`Não consegui enviar: ${error.message}`);
  }
});
