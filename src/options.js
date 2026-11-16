const $ = (id) => document.getElementById(id);
const DEFAULTS = { instruction: "", t3Provider: "", t3Model: "", cursorWorkspaces: "" };

async function load() {
  const settings = await chrome.storage.sync.get(DEFAULTS);
  for (const k of Object.keys(DEFAULTS)) $(k).value = settings[k];
  $("instruction").placeholder = globalThis.AAB.DEFAULT_INSTRUCTION;
}

async function save() {
  const status = $("status");
  await chrome.storage.sync.set(Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, $(k).value])));
  status.textContent = "Saved.";
  status.className = "ok";
}

$("save").addEventListener("click", save);
load();
