const STORAGE_KEY = "livecue.config";

const DEFAULT_CONFIG = {
  visionProvider: "ark",
  visionBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  visionApiKey: "",
  visionModel: "doubao-seed-2-0-lite-260215",
  asrProvider: "volcengine",
  asrApiKey: "",
  asrRelayUrl: "http://127.0.0.1:17395/asr",
  skillAgentProvider: "ark",
  skillAgentBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  skillAgentApiKey: "",
  skillAgentModel: "doubao-seed-2-0-lite-260215"
};

const fields = [...document.querySelectorAll("input, select")];
const statusEl = document.querySelector("#status");
const checksEl = document.querySelector("#checks");
const relayCommandEl = document.querySelector("#relay-command");

load();

document.querySelector("#save").addEventListener("click", async () => {
  const config = readForm();
  await saveConfig(config);
  showStatus("Settings saved.");
});

document.querySelector("#save-test").addEventListener("click", async () => {
  const config = readForm();
  await saveConfig(config);
  setAllChecksPending("Checking...");
  showStatus("Running provider checks...");
  const response = await chrome.runtime.sendMessage({
    type: "LIVE_CUE_TEST_CONFIG",
    config
  }).catch((error) => ({ ok: false, error: { message: error.message } }));
  if (!response?.checks) {
    setAllChecksFailed(response?.error?.message || "Checks failed.");
    showStatus("Checks failed.");
    return;
  }
  renderChecks(response.checks);
  showStatus(response.ok ? "All checks passed." : "Some checks need attention.");
});

document.querySelector("#clear").addEventListener("click", async () => {
  await saveConfig(DEFAULT_CONFIG);
  writeForm(DEFAULT_CONFIG);
  resetChecks();
  showStatus("Settings reset.");
});

document.querySelector("#copy-relay-command").addEventListener("click", async () => {
  const command = relayCommandEl.textContent.trim();
  await navigator.clipboard.writeText(command).catch(() => null);
  showStatus("Relay command copied. Paste it into Terminal and press Enter.");
});

document.querySelector("#open-tiktok").addEventListener("click", async () => {
  await chrome.tabs.create({ url: "https://www.tiktok.com/live" });
});

async function load() {
  const { [STORAGE_KEY]: config } = await chrome.storage.local.get(STORAGE_KEY);
  const merged = normalizeConfig({ ...DEFAULT_CONFIG, ...(config || {}) });
  if (JSON.stringify(merged) !== JSON.stringify({ ...DEFAULT_CONFIG, ...(config || {}) })) {
    await chrome.storage.local.set({ [STORAGE_KEY]: merged });
  }
  writeForm(merged);
}

async function saveConfig(config) {
  const normalized = normalizeConfig({ ...DEFAULT_CONFIG, ...config });
  await chrome.storage.local.set({ [STORAGE_KEY]: normalized });
  writeForm(normalized);
  return normalized;
}

function normalizeConfig(config) {
  const normalized = { ...config };
  if (normalized.visionProvider === "doubao") normalized.visionProvider = "ark";
  if (normalized.skillAgentProvider === "doubao") normalized.skillAgentProvider = "ark";
  if (normalized.asrProvider === "doubao") normalized.asrProvider = "volcengine";
  if (normalized.skillAgentModel === "doubao-seed-1-6-250615") normalized.skillAgentModel = DEFAULT_CONFIG.skillAgentModel;
  if (normalized.asrRelayUrl === "http://127.0.0.1:17394/asr") normalized.asrRelayUrl = DEFAULT_CONFIG.asrRelayUrl;
  normalized.visionBaseUrl = (normalized.visionBaseUrl || DEFAULT_CONFIG.visionBaseUrl).replace(/\/+$/, "");
  normalized.skillAgentBaseUrl = (normalized.skillAgentBaseUrl || DEFAULT_CONFIG.skillAgentBaseUrl).replace(/\/+$/, "");
  return normalized;
}

function readForm() {
  return Object.fromEntries(fields.map((field) => [field.name, field.value.trim()]));
}

function writeForm(config) {
  for (const field of fields) {
    field.value = config[field.name] || "";
  }
}

function renderChecks(checks) {
  for (const [name, result] of Object.entries(checks)) {
    const item = checksEl.querySelector(`[data-check="${name}"]`);
    if (!item) continue;
    item.classList.remove("pending", "ok", "failed");
    item.classList.add(result.ok ? "ok" : "failed");
    item.querySelector("em").textContent = readableCheckMessage(name, result);
  }
}

function readableCheckMessage(name, result) {
  if (result.ok) return result.message || "Ready";
  if (name === "asrRelay") return "Start the local ASR helper, then run checks again.";
  return result.message || "Needs attention";
}

function setAllChecksPending(message) {
  checksEl.querySelectorAll("li").forEach((item) => {
    item.classList.remove("ok", "failed");
    item.classList.add("pending");
    item.querySelector("em").textContent = message;
  });
}

function setAllChecksFailed(message) {
  checksEl.querySelectorAll("li").forEach((item) => {
    item.classList.remove("ok", "pending");
    item.classList.add("failed");
    item.querySelector("em").textContent = message;
  });
}

function resetChecks() {
  checksEl.querySelectorAll("li").forEach((item) => {
    item.classList.remove("ok", "pending", "failed");
    item.querySelector("em").textContent = "Not checked yet";
  });
}

function showStatus(text) {
  statusEl.textContent = text;
}
