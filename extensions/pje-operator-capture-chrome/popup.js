const statusElement = document.getElementById("status");
const enabledElement = document.getElementById("enabled");
const environmentElement = document.getElementById("environmentName");
const expectedProcessElement = document.getElementById("expectedProcessNumber");
const jobIdElement = document.getElementById("jobId");

function setStatus(message) {
  statusElement.textContent = message;
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response || !response.ok) {
        reject(new Error((response && response.error) || "erro desconhecido"));
        return;
      }
      resolve(response);
    });
  });
}

function normalizeProcessNumber(value) {
  return String(value || "").replace(/\D/g, "");
}

function formatProcessNumber(value) {
  const digits = normalizeProcessNumber(value);
  if (digits.length !== 20) {
    return value || "";
  }
  return `${digits.slice(0, 7)}-${digits.slice(7, 9)}.${digits.slice(9, 13)}.${digits.slice(13, 14)}.${digits.slice(14, 16)}.${digits.slice(16, 20)}`;
}

function renderEnvironmentOptions(environments, selectedName) {
  environmentElement.innerHTML = "";
  environments.forEach((environment) => {
    const option = document.createElement("option");
    option.value = environment.name;
    option.textContent = environment.label;
    option.selected = environment.name === selectedName;
    environmentElement.appendChild(option);
  });
}

function renderSettings(settings, environments) {
  enabledElement.checked = Boolean(settings.enabled && settings.autoCapture);
  renderEnvironmentOptions(environments, settings.environmentName);
  expectedProcessElement.value = formatProcessNumber(settings.expectedProcessNumber || "");
  jobIdElement.value = settings.jobId || "";
}

async function loadSettings() {
  const response = await sendMessage({ type: "JUSTRA_OPERATOR_GET_SETTINGS" });
  renderSettings(response.settings, response.environments);
  setStatus("Pronto. Resolva o CAPTCHA; a página liberada será enviada automaticamente.");
}

async function saveSettings() {
  const settings = {
    enabled: enabledElement.checked,
    autoCapture: enabledElement.checked,
    environmentName: environmentElement.value,
    expectedProcessNumber: normalizeProcessNumber(expectedProcessElement.value),
    jobId: jobIdElement.value.trim()
  };
  const response = await sendMessage({ type: "JUSTRA_OPERATOR_SAVE_SETTINGS", settings });
  renderSettings(response.settings, response.environments);
  setStatus("Configuração salva.");
}

document.getElementById("save").addEventListener("click", async () => {
  try {
    setStatus("Salvando...");
    await saveSettings();
  } catch (error) {
    setStatus(`Não consegui salvar: ${error.message}`);
  }
});

document.getElementById("captureNow").addEventListener("click", async () => {
  try {
    setStatus("Capturando aba ativa...");
    await saveSettings();
    const response = await sendMessage({ type: "JUSTRA_OPERATOR_CAPTURE_ACTIVE_TAB" });
    const data = response.data || {};
    if (!data.ok) {
      throw new Error(data.error || "captura não concluída");
    }
    setStatus(`Enviado. Import ID: ${data.import_id || "registrado"}.`);
  } catch (error) {
    setStatus(`Não consegui capturar: ${error.message}`);
  }
});

loadSettings().catch((error) => {
  setStatus(`Falha ao carregar: ${error.message}`);
});
