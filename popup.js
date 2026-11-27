/**
 * popup.js — PageVoice Popup UI (v2)
 *
 * Responsibilities: settings, view routing, transport commands.
 * NO audio code here — all playback runs in offscreen.js via background.js.
 *
 * Views:
 *   #player-view  — default, shows transport controls + article info
 *   #queue-view   — listening queue (issue #3): reorder, remove, play
 *   #settings-view — gear icon opens this; back arrow returns to player
 */

const DEFAULT_ELEVENLABS_KEY = "";

// ─── Curated voice tables ─────────────────────────────────────────────────────

const EDGE_VOICES = [
  { value: "en-GB-SoniaNeural",   label: "Amy (British Female)" },
  { value: "en-GB-RyanNeural",    label: "Brian (British Male)" },
  { value: "en-US-JennyNeural",   label: "Joanna (US Female)" },
  { value: "en-US-GuyNeural",     label: "Matthew (US Male)" },
  { value: "en-US-AriaNeural",    label: "Joanna (US Female, Conversational)" },
  { value: "en-AU-NatashaNeural", label: "Nicole (AU Female)" },
  { value: "en-AU-WilliamNeural", label: "Russell (AU Male)" },
];

// Kokoro's voice list is NOT hardcoded here anymore (issue #7): it comes
// from the running server's /v1/voices when reachable (see
// refreshKokoroStatus) and falls back to lib/pv-kokoro.js's curated
// defaults otherwise — resolveKokoroVoiceOptions handles both.

const OPENAI_VOICES = [
  { value: "nova",    label: "Nova (Female, Warm)" },
  { value: "alloy",  label: "Alloy (Neutral)" },
  { value: "echo",   label: "Echo (Male)" },
  { value: "fable",  label: "Fable (Male, Expressive)" },
  { value: "onyx",   label: "Onyx (Male, Deep)" },
  { value: "shimmer", label: "Shimmer (Female, Clear)" },
];

const ELEVENLABS_VOICES = [
  { value: "21m00Tcm4TlvDq8ikWAM", label: "Rachel (Female, Calm)" },
  { value: "EXAVITQu4vr4xnSDxMaL", label: "Sarah (Female, Soft)" },
  { value: "AZnzlk1XvdvUeBnXmlld", label: "Domi (Female, Strong)" },
  { value: "pNInz6obpgDQGcFmaJgB", label: "Adam (Male, Deep)" },
  { value: "TxGEqnHWrfWFTfGW9XjX", label: "Josh (Male, Young)" },
  { value: "VR6AewLTigWG4xSOukaG", label: "Arnold (Male, Crisp)" },
];

// Patterns to match system voice names to friendly labels
// Each entry: { patterns (any match), label, category }
const LOCAL_VOICE_PREFS = [
  // en-GB
  { patterns: ["google uk english female"],          label: "Emma (British Female)",  cat: "en-GB-F" },
  { patterns: ["google uk english male"],            label: "Daniel (British Male)",  cat: "en-GB-M" },
  { patterns: ["microsoft libby"],                   label: "Libby (British Female)", cat: "en-GB-F" },
  { patterns: ["microsoft ryan"],                    label: "Ryan (British Male)",    cat: "en-GB-M" },
  { patterns: ["microsoft hazel"],                   label: "Hazel (British Female)", cat: "en-GB-F" },
  { patterns: ["^daniel$"],                          label: "Daniel (British Male)",  cat: "en-GB-M" },
  { patterns: ["^kate$"],                            label: "Kate (British Female)",  cat: "en-GB-F" },
  // en-US
  { patterns: ["microsoft aria"],                    label: "Aria (US Female)",       cat: "en-US-F" },
  { patterns: ["microsoft jenny"],                   label: "Jenny (US Female)",      cat: "en-US-F" },
  { patterns: ["microsoft guy"],                     label: "Guy (US Male)",          cat: "en-US-M" },
  { patterns: ["google us english"],                 label: "Emily (US Female)",      cat: "en-US-F" },
  { patterns: ["^samantha$"],                        label: "Samantha (US Female)",   cat: "en-US-F" },
  { patterns: ["^alex$"],                            label: "Alex (US Male)",         cat: "en-US-M" },
  { patterns: ["^zira$"],                            label: "Zira (US Female)",       cat: "en-US-F" },
  { patterns: ["^david$"],                           label: "David (US Male)",        cat: "en-US-M" },
  { patterns: ["^mark$"],                            label: "Mark (US Male)",         cat: "en-US-M" },
  // en-AU
  { patterns: ["google australian english"],         label: "Grace (AU Female)",      cat: "en-AU-F" },
  { patterns: ["microsoft natasha"],                 label: "Natasha (AU Female)",    cat: "en-AU-F" },
  { patterns: ["microsoft william"],                 label: "William (AU Male)",      cat: "en-AU-M" },
  { patterns: ["^karen$"],                           label: "Karen (AU Female)",      cat: "en-AU-F" },
  { patterns: ["^lee$"],                             label: "Lee (AU Male)",          cat: "en-AU-M" },
];

function getCuratedLocalVoices(voices) {
  const selected = [];
  const usedCats = new Set();

  // Pass 1: match by preference patterns (prioritised)
  for (const pref of LOCAL_VOICE_PREFS) {
    if (usedCats.has(pref.cat)) continue;
    for (const pattern of pref.patterns) {
      const re = new RegExp(pattern, "i");
      const match = voices.find((v) => re.test(v.name));
      if (match) {
        selected.push({ value: match.name, label: pref.label });
        usedCats.add(pref.cat);
        break;
      }
    }
  }

  // Pass 2: fill empty categories from any available en-* voices
  const locales = ["en-GB", "en-US", "en-AU"];
  const fallbackCats = [
    { cat: "en-GB-F", lang: "en-GB", genderHint: ["female", "f-"] },
    { cat: "en-GB-M", lang: "en-GB", genderHint: ["male"] },
    { cat: "en-US-F", lang: "en-US", genderHint: ["female", "f-"] },
    { cat: "en-US-M", lang: "en-US", genderHint: ["male"] },
    { cat: "en-AU-F", lang: "en-AU", genderHint: ["female", "f-"] },
    { cat: "en-AU-M", lang: "en-AU", genderHint: ["male"] },
  ];

  for (const fb of fallbackCats) {
    if (usedCats.has(fb.cat)) continue;
    const v = voices.find(
      (v) => v.lang.startsWith(fb.lang) &&
             fb.genderHint.some((h) => v.name.toLowerCase().includes(h))
    );
    if (v) {
      const isF = fb.cat.endsWith("F");
      const regionLabel = fb.lang === "en-GB" ? "British" : fb.lang === "en-AU" ? "Australian" : "US";
      selected.push({ value: v.name, label: `${v.name} (${regionLabel} ${isF ? "Female" : "Male"})` });
      usedCats.add(fb.cat);
    }
  }

  // Pass 3: if still nothing useful, pick any English voice
  if (selected.length === 0) {
    const enVoices = voices.filter((v) => v.lang.startsWith("en"));
    enVoices.slice(0, 6).forEach((v) => {
      selected.push({ value: v.name, label: `${v.name} (${v.lang})` });
    });
  }

  return selected;
}

// ─── DOM Refs ─────────────────────────────────────────────────────────────────

const playerView    = document.getElementById("player-view");
const settingsView  = document.getElementById("settings-view");
const queueView     = document.getElementById("queue-view");
const settingsBtn   = document.getElementById("settingsBtn");
const backBtn       = document.getElementById("backBtn");
const queueBtn      = document.getElementById("queueBtn");
const queueBackBtn  = document.getElementById("queueBackBtn");
const queueList     = document.getElementById("queueList");
const queueEmpty    = document.getElementById("queueEmpty");
const queueCount    = document.getElementById("queueCount");
const saveQueueBtn  = document.getElementById("saveQueueBtn");
const pdfImportBtn  = document.getElementById("pdfImportBtn");
const pdfFileInput  = document.getElementById("pdfFileInput");
const pdfImportStatus = document.getElementById("pdfImportStatus");
const kokoroStatusLine = document.getElementById("kokoroStatusLine");
const kokoroCheckBtn   = document.getElementById("kokoroCheckBtn");
const kokoroSetupLink  = document.getElementById("kokoroSetupLink");
const kokoroLive       = document.getElementById("kokoroLive");

const playBtn       = document.getElementById("playBtn");
const pauseBtn      = document.getElementById("pauseBtn");
const stopBtn       = document.getElementById("stopBtn");
const statusEl      = document.getElementById("status");
const articleTitle  = document.getElementById("articleTitle");
const progressInfo  = document.getElementById("progressInfo");
const engineLabel   = document.getElementById("engineLabel");

const engineRadios  = document.querySelectorAll('input[name="engine"]');
const voiceSelect   = document.getElementById("voiceSelect");
const speedInput    = document.getElementById("speedInput");
const speedValue    = document.getElementById("speedValue");
const highlightToggle = document.getElementById("highlightToggle");

const openaiKeyGroup = document.getElementById("openaiKeyGroup");
const elevenKeyGroup = document.getElementById("elevenKeyGroup");
const openaiKeyInput = document.getElementById("openaiKey");
const elevenKeyInput = document.getElementById("elevenKey");
const openaiSaved    = document.getElementById("openaiSaved");
const elevenSaved    = document.getElementById("elevenSaved");

// ─── Local State ─────────────────────────────────────────────────────────────

let uiState      = "stopped"; // 'stopped' | 'playing' | 'paused'
let currentEngine = "edge";
let activeTabId   = null;
// Last Kokoro server probe (issue #7): { reachable, voices, failure,
// checkedAt } from background's kokoroStatus, or null before the first
// probe completes. Voice list + settings status line both key off it.
let kokoroProbe   = null;

// ─── Initialise ───────────────────────────────────────────────────────────────

chrome.storage.sync.get(
  ["engine", "voice", "speed", "openaiKey", "elevenLabsKey", "highlightEnabled"],
  (data) => {
    currentEngine = data.engine || "edge";
    setEngineRadio(currentEngine);
    updateEngineUI(currentEngine);

    speedInput.value = data.speed || 1.0;
    speedValue.textContent = (data.speed || 1.0) + "x";

    // Word highlighting (issue #4): opt-in, off by default on first upgrade.
    highlightToggle.checked = !!data.highlightEnabled;

    if (data.openaiKey)     openaiKeyInput.value = data.openaiKey;
    if (data.elevenLabsKey) elevenKeyInput.value  = data.elevenLabsKey;

    // Voice list is populated after engine is set
    populateVoices(currentEngine, data.voice || null);

    // Engine label on player view
    engineLabel.textContent = engineDisplayName(currentEngine);
  }
);

// Sync with any in-progress playback
chrome.runtime.sendMessage({ target: "background", type: "getState" }, (res) => {
  if (chrome.runtime.lastError) return;
  if (res?.ok && res.payload) applyState(res.payload);
});

// ─── View Switching ───────────────────────────────────────────────────────────

const VIEWS = [playerView, settingsView, queueView];

function showView(view) {
  VIEWS.forEach((v) => v.classList.remove("active"));
  view.classList.add("active");
}

settingsBtn.addEventListener("click", () => {
  showView(settingsView);
  // Live engine status (issue #7): re-probe every time settings open —
  // a local server can start/stop between popup opens.
  refreshKokoroStatus();
});

backBtn.addEventListener("click", () => {
  showView(playerView);
  // Always refresh engine label when returning to player view
  engineLabel.textContent = engineDisplayName(currentEngine);
});

queueBtn.addEventListener("click", () => {
  showView(queueView);
  renderQueue();
});

queueBackBtn.addEventListener("click", () => {
  showView(playerView);
  engineLabel.textContent = engineDisplayName(currentEngine);
});

// ─── Engine Selection ─────────────────────────────────────────────────────────

engineRadios.forEach((radio) => {
  radio.addEventListener("change", () => {
    // Stop any active playback when switching engines
    if (uiState === "playing" || uiState === "paused") {
      chrome.runtime.sendMessage({ target: "background", type: "stop" });
      setUIState("stopped");
      setStatus("");
    }
    currentEngine = radio.value;
    chrome.storage.sync.set({ engine: currentEngine });
    updateEngineUI(currentEngine);
    populateVoices(currentEngine, null);
    engineLabel.textContent = engineDisplayName(currentEngine);
  });
});

function setEngineRadio(engine) {
  engineRadios.forEach((r) => { r.checked = (r.value === engine); });
}

function updateEngineUI(engine) {
  openaiKeyGroup.style.display = (engine === "openai")      ? "flex" : "none";
  elevenKeyGroup.style.display = (engine === "elevenlabs")  ? "flex" : "none";
}

function engineDisplayName(engine) {
  return {
    edge: "Edge TTS",
    local: "Browser TTS",
    openai: "OpenAI TTS",
    elevenlabs: "ElevenLabs",
    kokoro: "Kokoro TTS",
  }[engine] || engine;
}

// ─── Voice Population ─────────────────────────────────────────────────────────

function populateVoices(engine, savedVoice) {
  voiceSelect.innerHTML = "";

  if (engine === "edge") {
    EDGE_VOICES.forEach(({ value, label }) => addOption(voiceSelect, value, label));
    restoreVoice(savedVoice || "en-GB-SoniaNeural");

  } else if (engine === "openai") {
    OPENAI_VOICES.forEach(({ value, label }) => addOption(voiceSelect, value, label));
    restoreVoice(savedVoice || "nova");

  } else if (engine === "elevenlabs") {
    ELEVENLABS_VOICES.forEach(({ value, label }) => addOption(voiceSelect, value, label));
    restoreVoice(savedVoice || "21m00Tcm4TlvDq8ikWAM");

  } else if (engine === "kokoro") {
    // Server list when the last probe found it; curated defaults otherwise
    // (issue #7). Server labels are derived from the id prefix in
    // lib/pv-kokoro.js, so unseen voices still label correctly.
    const options = resolveKokoroVoiceOptions(kokoroProbe?.voices);
    options.forEach(({ value, label }) => addOption(voiceSelect, value, label));
    restoreVoice(savedVoice || "bf_alice");

  } else if (engine === "local") {
    loadLocalVoices(savedVoice);
  }
}

function addOption(select, value, label) {
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = label;
  select.appendChild(opt);
}

function restoreVoice(voiceName) {
  if (voiceName) voiceSelect.value = voiceName;
  if (!voiceSelect.value && voiceSelect.options.length > 0) {
    voiceSelect.selectedIndex = 0;
  }
}

function loadLocalVoices(savedVoice) {
  const doLoad = () => {
    const voices = speechSynthesis.getVoices();
    if (voices.length === 0) return; // not ready yet
    const curated = getCuratedLocalVoices(voices);
    voiceSelect.innerHTML = "";
    if (curated.length === 0) {
      addOption(voiceSelect, "", "Default Voice");
    } else {
      curated.forEach(({ value, label }) => addOption(voiceSelect, value, label));
    }
    restoreVoice(savedVoice);
    voiceSelect.dispatchEvent(new Event("change")); // persist if needed
  };

  if (speechSynthesis.getVoices().length > 0) {
    doLoad();
  } else {
    speechSynthesis.onvoiceschanged = doLoad;
  }
}

voiceSelect.addEventListener("change", () => {
  chrome.storage.sync.set({ voice: voiceSelect.value });
});

// ─── Kokoro Local Server status (issue #7) ────────────────────────────────────
//
// The probe itself runs in background's service worker (message
// "kokoroStatus") so closing the popup mid-probe aborts nothing. Pure
// copy/parse helpers come from lib/pv-kokoro.js. When the server is
// unreachable the setup guide link appears; when reachable, the engine
// entry gets a live ✓ badge and the voice picker uses the server's list.

async function refreshKokoroStatus() {
  kokoroStatusLine.textContent = "Checking…";
  kokoroStatusLine.classList.remove("status-ok", "status-err");
  try {
    const res = await chrome.runtime.sendMessage({ target: "background", type: "kokoroStatus" });
    kokoroProbe = res?.ok ? res.payload : null;
  } catch (_) {
    kokoroProbe = null; // background unreachable — leave defaults in play
  }
  renderKokoroStatus();
  // Re-populate so the picker reflects the server list (or defaults).
  if (currentEngine === "kokoro") {
    populateVoices("kokoro", voiceSelect.value || null);
  }
}

function renderKokoroStatus() {
  const p = kokoroProbe;
  kokoroStatusLine.textContent = kokoroStatusText(p);
  const reachable = !!(p && p.reachable);
  kokoroStatusLine.classList.toggle("status-ok", reachable);
  kokoroStatusLine.classList.toggle("status-err", !reachable && !!p);
  // Setup guide is linked exactly when the server is unreachable.
  kokoroSetupLink.hidden = reachable;
  kokoroLive.hidden = !reachable;
}

kokoroCheckBtn.addEventListener("click", () => {
  refreshKokoroStatus();
});

// ─── Speed ────────────────────────────────────────────────────────────────────

speedInput.addEventListener("input", () => {
  speedValue.textContent = parseFloat(speedInput.value) + "x";
  chrome.runtime.sendMessage({
    target: "background", type: "setSpeed", payload: { speed: parseFloat(speedInput.value) },
  }).catch(() => {});
});

// ─── Word Highlighting toggle (issue #4) ──────────────────────────────────────

highlightToggle.addEventListener("change", () => {
  // Opt-in setting. Content scripts listen for storage.onChanged and clear
  // an active highlight immediately when this is switched off.
  chrome.storage.sync.set({ highlightEnabled: highlightToggle.checked });
});

// ─── API Keys ─────────────────────────────────────────────────────────────────

// Handle both typing and pasting for key inputs
function bindKeyInput(input, storageKey, savedIndicator) {
  const save = () => {
    chrome.storage.sync.set({ [storageKey]: input.value }, () => flashSaved(savedIndicator));
  };
  input.addEventListener("input", save);
  input.addEventListener("paste", (e) => {
    // Let the paste happen, then save after the value updates
    setTimeout(save, 0);
  });
  // Also handle Ctrl+V / Cmd+V explicitly in case paste event is swallowed
  input.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "v") {
      setTimeout(save, 50);
    }
  });
}

bindKeyInput(openaiKeyInput, "openaiKey", openaiSaved);
bindKeyInput(elevenKeyInput, "elevenLabsKey", elevenSaved);

function flashSaved(indicator) {
  indicator.classList.add("show");
  setTimeout(() => indicator.classList.remove("show"), 2000);
}

// ─── Transport Controls ───────────────────────────────────────────────────────

playBtn.addEventListener("click", async () => {
  if (uiState === "paused") {
    chrome.runtime.sendMessage({ target: "background", type: "resume" });
    setUIState("playing");
    return;
  }

  setUIState("playing");
  setStatus("Extracting article…");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = tab.id;

    // Ensure content script is injected
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    } catch (_) {}

    await sleep(200);

    chrome.tabs.sendMessage(tab.id, { action: "getArticleData" }, (response) => {
      if (chrome.runtime.lastError || !response?.text) {
        setStatus("Could not extract text — try refreshing the page.", true);
        setUIState("stopped");
        return;
      }

      articleTitle.textContent = response.title || tab.title || "Article";

      const elevenKey = elevenKeyInput.value.trim() || DEFAULT_ELEVENLABS_KEY;
      const openaiKey  = openaiKeyInput.value.trim();

      const payload = {
        text:      response.text,
        engine:    currentEngine,
        voice:     voiceSelect.value,
        speed:     parseFloat(speedInput.value) || 1.0,
        apiKey:    currentEngine === "elevenlabs" ? elevenKey : openaiKey,
        tabId:     tab.id,
      };

      chrome.runtime.sendMessage({ target: "background", type: "play", payload });
    });
  } catch (err) {
    setStatus("Error: " + err.message, true);
    setUIState("stopped");
  }
});

pauseBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ target: "background", type: "pause" });
  setUIState("paused");
});

stopBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ target: "background", type: "stop" });
  setUIState("stopped");
  setStatus("");
  progressInfo.textContent = "";
});

// ─── Listening Queue (issue #3) ───────────────────────────────────────────────

let queueData = null; // { queue, currentId } — kept for the badge + re-render

function fetchQueue() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ target: "background", type: "queueGet" }, (res) => {
      if (chrome.runtime.lastError || !res?.ok) return resolve(null);
      resolve(res.payload);
    });
  });
}

function updateQueueBadge() {
  const count = queueData?.queue?.items?.length || 0;
  queueCount.textContent = count > 0 ? String(count) : "";
  queueBtn.title = count > 0 ? `Listening queue (${count} item${count === 1 ? "" : "s"})` : "Listening queue";
}

async function renderQueue() {
  queueData = await fetchQueue();
  updateQueueBadge();
  queueList.innerHTML = "";

  if (!queueData) {
    queueEmpty.textContent = "Queue unavailable — reopen the popup to retry.";
    queueEmpty.style.display = "block";
    return;
  }

  const { queue, currentId } = queueData;
  queueEmpty.style.display = queue.items.length === 0 ? "block" : "none";
  queueEmpty.innerHTML = "Queue is empty.<br>Open an article and press “＋ Save to queue”.";

  queue.items.forEach((entry, index) => {
    const row = document.createElement("div");
    row.className = "queue-item" + (entry.id === currentId ? " current" : "");
    row.dataset.id = entry.id;
    row.title = "Play this item";

    const info = document.createElement("div");
    info.className = "queue-item-info";

    const title = document.createElement("div");
    title.className = "queue-item-title";
    title.textContent = entry.title || "Untitled";
    info.appendChild(title);

    if (entry.position > 0) {
      const meta = document.createElement("div");
      meta.className = "queue-item-meta";
      meta.textContent = `resumes at part ${entry.position + 1}`;
      info.appendChild(meta);
    }
    if (entry.id === currentId) {
      const now = document.createElement("div");
      now.className = "queue-item-meta";
      now.textContent = "▶ now playing";
      info.appendChild(now);
    }

    const actions = document.createElement("div");
    actions.className = "queue-item-actions";
    actions.appendChild(queueActionBtn("▲", "Move up",   index === 0, () => sendQueueAction("queueMove", { id: entry.id, dir: -1 })));
    actions.appendChild(queueActionBtn("▼", "Move down", index === queue.items.length - 1, () => sendQueueAction("queueMove", { id: entry.id, dir: 1 })));
    actions.appendChild(queueActionBtn("✕", "Remove",    false, () => sendQueueAction("queueRemove", { id: entry.id })));

    row.appendChild(info);
    row.appendChild(actions);

    row.addEventListener("click", (e) => {
      if (e.target.closest(".queue-item-actions")) return;
      playQueueItem(entry.id);
    });

    queueList.appendChild(row);
  });
}

function queueActionBtn(label, title, disabled, onClick) {
  const btn = document.createElement("button");
  btn.className = "queue-btn";
  btn.textContent = label;
  btn.title = title;
  btn.disabled = disabled;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

function sendQueueAction(type, payload) {
  chrome.runtime.sendMessage({ target: "background", type, payload });
}

function playQueueItem(id) {
  chrome.runtime.sendMessage(
    { target: "background", type: "queuePlay", payload: { id } },
    (res) => {
      if (chrome.runtime.lastError) return;
      if (res?.ok) {
        showView(playerView);
        setUIState("playing");
        setStatus("Starting queue playback…");
      } else {
        setStatus(res?.error || "Could not play this item.", true);
      }
    }
  );
}

// ─── PDF import (issue #5) ───────────────────────────────────────────────────
//
// 📄 button or drag-drop → file → size guard → chunked base64 transfer
// (sendPdfImportViaChannel, lib/pv-transport.js) → background
// pdfImportBegin/Chunk/End. An ArrayBuffer payload does NOT survive
// chrome.runtime.sendMessage (JSON-serialized — issue #20, round 2), so the
// bytes travel as base64 chunk strings. Background owns the rest (offscreen
// pdf.js extraction, queue add, broadcastQueue), so the import survives this
// popup closing mid-extract; the only thing living here is UI state:
// progress, success and error lines.

const PDF_MAX_BYTES_POPUP = 50 * 1024 * 1024;

const pdfImport = { importing: false };

function setPdfStatus(text, kind = "") {
  pdfImportStatus.hidden = !text;
  pdfImportStatus.textContent = text || "";
  pdfImportStatus.className = "pdf-import-status" + (kind ? " " + kind : "");
}

function isPdfFile(file) {
  return Boolean(file) &&
    (file.type === "application/pdf" || /\.pdf$/i.test(file.name || ""));
}

async function importPdfFile(file) {
  if (pdfImport.importing) return;
  if (!isPdfFile(file)) {
    setPdfStatus("That doesn't look like a PDF file.", "error");
    return;
  }
  if (file.size > PDF_MAX_BYTES_POPUP) {
    setPdfStatus("PDF is larger than 50 MB — please use a smaller file.", "error");
    return;
  }

  pdfImport.importing = true;
  pdfImportBtn.disabled = true;
  setPdfStatus(`Reading “${file.name}”…`);
  try {
    setPdfStatus("Importing…");
    // Real channel semantics: a null response means the channel itself died
    // (extension reload) — the driver maps that to an honest operator error.
    const send = async (message) => {
      try {
        return await chrome.runtime.sendMessage(message);
      } catch (_) {
        return null;
      }
    };
    const res = await sendPdfImportViaChannel(file, send);
    if (!res || !res.ok) {
      setPdfStatus(
        (res && res.error) || "Import failed — the extension did not respond. Try again.",
        "error"
      );
      return;
    }
    const pages = res.pages || "?";
    setPdfStatus(`Added “${res.item.title}” (${pages} page${pages === 1 ? "" : "s"}) to the queue ✓`, "done");
    renderQueue(); // the queueUpdate broadcast also refreshes; this covers the race
  } catch (_) {
    setPdfStatus("Could not read the file — try again.", "error");
  } finally {
    pdfImport.importing = false;
    pdfImportBtn.disabled = false;
  }
}

pdfImportBtn.addEventListener("click", () => pdfFileInput.click());

pdfFileInput.addEventListener("change", () => {
  const file = pdfFileInput.files && pdfFileInput.files[0];
  pdfFileInput.value = ""; // allow re-picking the same file
  if (file) importPdfFile(file);
});

// Drag-drop target: the whole queue view (dragleave/drop clear the highlight).
["dragenter", "dragover"].forEach((evt) => {
  queueView.addEventListener(evt, (e) => {
    e.preventDefault();
    if (pdfImport.importing) return;
    queueView.classList.add("drop-target");
  });
});
["dragleave", "drop"].forEach((evt) => {
  queueView.addEventListener(evt, (e) => {
    e.preventDefault();
    queueView.classList.remove("drop-target");
  });
});
queueView.addEventListener("drop", (e) => {
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) importPdfFile(file);
});

saveQueueBtn.addEventListener("click", () => {
  saveQueueBtn.disabled = true;
  (async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const payload = tab ? { tabId: tab.id } : {};
      chrome.runtime.sendMessage(
        { target: "background", type: "queueAddCurrent", payload },
        (res) => {
          saveQueueBtn.disabled = false;
          if (chrome.runtime.lastError) { setStatus("Could not save — try again.", true); return; }
          if (res?.ok) setStatus("Saved to queue ✓");
          else setStatus(res?.error || "Could not extract text on this page.", true);
        }
      );
    } catch (err) {
      saveQueueBtn.disabled = false;
      setStatus("Error: " + err.message, true);
    }
  })();
});

// Badge count on open
fetchQueue().then((data) => {
  queueData = data;
  updateQueueBadge();
});

// ─── State Updates from Background ───────────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.target !== "popup") return;
  if (message.type === "stateUpdate" && message.payload) {
    applyState(message.payload);
  }
  if (message.type === "queueUpdate" && message.payload) {
    queueData = message.payload;
    updateQueueBadge();
    if (queueView.classList.contains("active")) renderQueue();
  }
  if (message.type === "pdfImportProgress" && message.payload) {
    const { page, total } = message.payload;
    if (pdfImport.importing) {
      setPdfStatus(`Extracting PDF — page ${page} of ${total}…`);
    }
  }
});

function applyState({ state, statusText, chunk, totalChunks, engine }) {
  setUIState(state);
  if (statusText !== undefined) setStatus(statusText, statusLooksLikeError(state, statusText));
  if (chunk !== undefined && totalChunks !== undefined) {
    progressInfo.textContent = totalChunks > 1 ? `${chunk} / ${totalChunks}` : "";
  }
  // Only update engine label from playback state if actively playing/paused
  // Otherwise respect the user's selected engine from settings
  if (engine && (state === "playing" || state === "paused")) {
    engineLabel.textContent = engineDisplayName(engine);
  }
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────

function setUIState(state) {
  uiState = state;
  if (state === "playing") {
    playBtn.disabled = true;
    playBtn.classList.add("active");
    pauseBtn.disabled = false;
    stopBtn.disabled  = false;
  } else if (state === "paused") {
    playBtn.disabled = false;
    playBtn.classList.remove("active");
    pauseBtn.disabled = true;
    stopBtn.disabled  = false;
  } else {
    playBtn.disabled = false;
    playBtn.classList.remove("active");
    pauseBtn.disabled = true;
    stopBtn.disabled  = true;
    progressInfo.textContent = "";
  }
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

function statusLooksLikeError(state, text) {
  if (!text) return false;
  if (state !== "stopped") return false;
  return /(error|required|unavailable|timed out|failed|quota|unauthorized|forbidden|could not)/i.test(text);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
