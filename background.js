/**
 * background.js — PageVoice Service Worker (v2)
 *
 * Responsibilities:
 *  1. Maintain authoritative playback state in chrome.storage.session.
 *  2. Manage offscreen document lifecycle.
 *  3. Route messages: popup ↔ offscreen ↔ content-script (floating player).
 *
 * Message protocol (all messages carry `target`):
 *   popup     → background: getState | play | pause | resume | stop
 *               | kokoroStatus (issue #7 probe: "Check again" + status line)
 *   offscreen → background: stateUpdate { state, statusText, chunk, totalChunks, engine }
 *   offscreen → background: highlightUpdate { engine, sentence, word } (issue #4)
 *   background → offscreen: play | pause | resume | stop
 *   background → popup:     stateUpdate | queueUpdate
 *   background → content:   playerUpdate { state, chunk, totalChunks }
 *                           highlightUpdate { engine, sentence, word }
 *
 * Keyboard shortcuts + read-from-here (issue #6): chrome.commands
 * (play-pause, stop, save-to-queue) and the "Read from here" context menu
 * drive the same playback functions as the popup's messages, so hotkeys
 * work with the popup closed. background → content: getReadFromHere →
 * { ok, text, title, startChunk } (startChunk is computed against the
 * ACTIVE engine's chunking — see lib/pv-shortcuts.js).
 *
 * Listening queue (issue #3): the queue lives in chrome.storage.local
 * (key QUEUE_STORAGE_KEY, schema-versioned by lib/pv-queue.js). Queue logic
 * is pure and unit-tested in lib/pv-queue.test.js; this file only wires it
 * to storage, messages, and playback.
 *
 * PDF import (issue #5): the popup picks the file and sends the bytes to
 * "pdfImport"; background owns the whole import (so it completes even if
 * the popup closes), extraction happens in the offscreen document via
 * "pdf-extract" (vendored pdf.js), and the text joins the listening queue
 * like any article. lib/pv-pdf.js is the pure, unit-tested core.
 */

importScripts("lib/pv-queue.js");
importScripts("lib/pv-pdf.js");
importScripts("lib/pv-kokoro.js");

const OFFSCREEN_URL = chrome.runtime.getURL("offscreen.html");

// ─── State ─────────────────────────────────────────────────────────────────────

let _state = { state: "stopped", statusText: "", chunk: 0, totalChunks: 0, engine: "edge" };
let _activeTabId = null;
let _queueCurrentId = null; // queue item currently playing (null = none)

async function loadState() {
  const stored = await chrome.storage.session
    .get(["playbackState", "activeTabId", "queueCurrentId"])
    .catch(() => ({}));
  if (stored.playbackState) _state = stored.playbackState;
  if (typeof stored.activeTabId === "number") _activeTabId = stored.activeTabId;
  if (typeof stored.queueCurrentId === "string") _queueCurrentId = stored.queueCurrentId;
  return _state;
}

async function saveState(patch) {
  _state = { ..._state, ...patch };
  await chrome.storage.session.set({ playbackState: _state }).catch(() => {});
  return _state;
}

async function saveActiveTabId(tabId) {
  _activeTabId = typeof tabId === "number" ? tabId : null;
  await chrome.storage.session.set({ activeTabId: _activeTabId }).catch(() => {});
}

async function setQueueCurrent(id) {
  _queueCurrentId = typeof id === "string" ? id : null;
  await chrome.storage.session.set({ queueCurrentId: _queueCurrentId }).catch(() => {});
  return _queueCurrentId;
}

// ─── Offscreen Helpers ─────────────────────────────────────────────────────────

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [OFFSCREEN_URL],
  }).catch(() => []);
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["AUDIO_PLAYBACK"],
    justification: "Persistent TTS audio that survives popup close",
  });
  await sleep(150);
}

async function closeOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    await chrome.offscreen.closeDocument().catch(() => {});
  }
}

// ─── Listening Queue (issue #3) ────────────────────────────────────────────────

async function loadQueue() {
  const stored = await chrome.storage.local.get(QUEUE_STORAGE_KEY).catch(() => ({}));
  return normalizeQueue(stored[QUEUE_STORAGE_KEY]);
}

async function saveQueue(queue) {
  await chrome.storage.local.set({ [QUEUE_STORAGE_KEY]: queue }).catch(() => {});
  return queue;
}

async function broadcastQueue() {
  const queue = await loadQueue();
  chrome.runtime.sendMessage({
    target: "popup",
    type:   "queueUpdate",
    payload: { queue, currentId: _queueCurrentId },
  }).catch(() => {});
}

// Convert the offscreen's 1-based reported chunk to the 0-based resume index.
// Mid-chunk pause resumes at the chunk that was playing, not the next one.
function resumeIndexFromReportedChunk(reportedChunk) {
  return Math.max(0, (reportedChunk || 1) - 1);
}

// Returns true when the queue actually changed (position differs / item gone).
async function persistQueuePosition(itemId, position) {
  const queue = await loadQueue();
  const next  = setQueuePosition(queue, itemId, position);
  if (next === queue) return false; // no-op: same position or missing item
  await saveQueue(next);
  await broadcastQueue();
  return true;
}

async function extractFromTab(tabId) {
  if (typeof tabId !== "number") return null;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (_) {}
  await sleep(200);
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { action: "getArticleData" }, (response) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(response);
    });
  });
}

async function addCurrentToQueue(tabId) {
  const [tab, data] = await Promise.all([
    chrome.tabs.get(tabId).catch(() => null),
    extractFromTab(tabId),
  ]);
  if (!data || !data.text) {
    return { ok: false, error: "Could not extract text — try refreshing the page." };
  }

  const queue = await loadQueue();
  const { queue: next, item: added } = addToQueue(queue, {
    title: data.title || tab?.title || "Article",
    url:   tab?.url || "",
    text:  data.text,
  });
  if (!added) return { ok: false, error: "No readable text on this page." };

  await saveQueue(next);
  await broadcastQueue();
  return { ok: true, item: added };
}

// ─── PDF import (issue #5) ────────────────────────────────────────────────────
//
// The popup picks the file and hands the raw bytes here; background owns the
// whole import so it completes even if the popup closes mid-extract. Text
// extraction runs in the offscreen document (pdf.js vendored, lazy-loaded
// there); the result joins the listening queue like any article and plays
// through the standard chunking pipeline.

async function extractPdfInOffscreen(buffer) {
  await ensureOffscreenDocument();
  return chrome.runtime
    .sendMessage({ target: "offscreen", type: "pdf-extract", payload: { buffer } })
    .catch(() => null); // offscreen crashed / channel gone → handled below
}

async function importPdfToQueue(payload) {
  const buffer = payload?.buffer;
  const name   = typeof payload?.name === "string" ? payload.name : "";

  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) {
    return { ok: false, error: "No PDF data received — pick the file again." };
  }
  const sizeCheck = validatePdfSize(buffer.byteLength); // fast 50 MB guard before any work
  if (!sizeCheck.ok) {
    return { ok: false, code: sizeCheck.code, error: PDF_ERRORS[sizeCheck.code] };
  }

  const result = await extractPdfInOffscreen(buffer);
  if (!result) {
    return { ok: false, code: "load-failed", error: PDF_ERRORS["load-failed"] };
  }
  if (!result.ok) {
    return { ok: false, code: result.code, error: result.error };
  }

  const title = titleFromFilename(name);
  const queue = await loadQueue();
  const { queue: next, item } = addToQueue(queue, {
    title,
    url:   `pdf:${name || title}`,
    text:  result.text,
  });
  if (!item) {
    return { ok: false, code: "no-text", error: PDF_ERRORS["no-text"] };
  }

  await saveQueue(next);
  await broadcastQueue();
  return { ok: true, item: { id: item.id, title: item.title }, pages: result.pages };
}

// ─── Kokoro server probe (issue #7) ────────────────────────────────────────────
//
// Settings status line + "Check again". Any HTTP response counts as
// reachable (an older kokoro_server.py without /v1/voices answers 404);
// only connection errors and probe timeouts are "not running". The voice
// list is parsed best-effort by lib/pv-kokoro.js. Playback-side fallback
// lives in offscreen.js (same library).
async function probeKokoro() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), KOKORO_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(kokoroVoicesUrl(), { method: "GET", signal: controller.signal });
    let voices = null;
    try { voices = parseKokoroVoices(await res.text()); } catch (_) { /* best-effort */ }
    return { reachable: true, voices, checkedAt: Date.now() };
  } catch (err) {
    return { reachable: false, failure: classifyKokoroFailure(err), checkedAt: Date.now() };
  } finally {
    clearTimeout(timer);
  }
}

// Build the play payload from the user's saved settings (queue playback
// can start with no popup open, so background assembles it itself).
async function queuePlayPayload(item) {
  const settings = await chrome.storage.sync
    .get(["engine", "voice", "speed", "openaiKey", "elevenLabsKey"])
    .catch(() => ({}));
  const engine = settings.engine || "edge";
  return {
    text:        item.text,
    engine,
    voice:       settings.voice || "",
    speed:       parseFloat(settings.speed) || 1.0,
    apiKey:      engine === "elevenlabs" ? (settings.elevenLabsKey || "") : (settings.openaiKey || ""),
    queueItemId: item.id,
    startChunk:  item.position || 0, // resume at saved position
  };
}

async function playQueueItem(itemId) {
  const queue = await loadQueue();
  const item  = getQueueItem(queue, itemId);
  if (!item) return false;

  // Stop any in-flight playback so the new item starts clean (offscreen
  // "stop" leaves the document alive; the 250ms gap lets in-flight loops
  // observe isStopped before the new play resets it).
  if (await hasOffscreenDocument()) {
    chrome.runtime.sendMessage({ target: "offscreen", type: "stop" }).catch(() => {});
    await sleep(250);
  }

  const payload = await queuePlayPayload(item);
  await setQueueCurrent(item.id);
  await saveActiveTabId(null); // queue playback is not tied to a page's player
  await saveState({
    state: "playing", statusText: `Playing: ${item.title}`,
    chunk: 0, totalChunks: 0, engine: payload.engine,
  });
  await ensureOffscreenDocument();
  chrome.runtime.sendMessage({ target: "offscreen", type: "play", payload }).catch(() => {});
  await broadcastQueue();
  return true;
}

// Auto-advance: the current item finished naturally — start the next one.
// Returns true when a next item started, false at the queue's end.
async function advanceQueueAfterFinish() {
  const currentId = _queueCurrentId;
  if (!currentId) return false;

  const queue = await loadQueue();
  const next  = nextQueueItem(queue, currentId);
  if (!next) {
    await setQueueCurrent(null);
    await broadcastQueue();
    return false;
  }
  return playQueueItem(next.id);
}

// ─── Playback control (issue #6: shared by popup, commands, context menu) ────

// The popup's play/pause/resume/stop messages, the chrome.commands hotkeys,
// and the "Read from here" context menu all funnel through these four
// functions so every entry point behaves identically (queue-cursor drop,
// offscreen lifecycle, mini-player notification included).

async function startPlayback(payload) {
  // Plain page playback is not queue playback — drop the queue cursor
  // so a natural finish does not auto-advance into the queue.
  if (!payload?.queueItemId) {
    await setQueueCurrent(null);
  }
  if (typeof payload?.tabId === "number") {
    await saveActiveTabId(payload.tabId);
  }
  await saveState({ state: "playing", statusText: "Starting…", engine: payload?.engine || "edge" });
  await ensureOffscreenDocument();
  chrome.runtime.sendMessage({
    target: "offscreen",
    type:   "play",
    payload,
  }).catch(() => {});
  // Notify content script to show mini-player
  await notifyContentScript(_activeTabId, { state: "playing", chunk: 0, totalChunks: 0 });
}

async function pausePlayback() {
  await saveState({ state: "paused", statusText: "Paused" });
  chrome.runtime.sendMessage({ target: "offscreen", type: "pause" }).catch(() => {});
  await notifyContentScript(_activeTabId, { state: "paused", chunk: _state.chunk, totalChunks: _state.totalChunks });
}

async function resumePlayback() {
  await saveState({ state: "playing", statusText: _state.statusText });
  chrome.runtime.sendMessage({ target: "offscreen", type: "resume" }).catch(() => {});
  await notifyContentScript(_activeTabId, { state: "playing", chunk: _state.chunk, totalChunks: _state.totalChunks });
}

async function stopPlayback() {
  // Save the queue resume position before tearing playback down.
  if (_queueCurrentId) {
    await persistQueuePosition(_queueCurrentId, resumeIndexFromReportedChunk(_state.chunk));
  }
  await saveState({ state: "stopped", statusText: "", chunk: 0, totalChunks: 0 });
  chrome.runtime.sendMessage({ target: "offscreen", type: "stop" }).catch(() => {});
  await notifyContentScript(_activeTabId, { state: "stopped" });
  await sleep(250);
  await closeOffscreenDocument();
}

// ─── Content Script Notifications ─────────────────────────────────────────────

async function notifyContentScript(tabId, payload, type = "playerUpdate") {
  let targetTabId = tabId;

  if (typeof targetTabId !== "number") {
    const stored = await chrome.storage.session.get("activeTabId").catch(() => ({}));
    targetTabId = stored.activeTabId;
  }

  if (typeof targetTabId !== "number") return;

  _activeTabId = targetTabId;
  chrome.tabs.sendMessage(targetTabId, { target: "content", type, payload }).catch(() => {});
}

// ─── Message Router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== "background") return false;

  (async () => {
    switch (message.type) {

      // ── Get current state ────────────────────────────────────────────────
      case "getState": {
        const st = await loadState();
        // If state says active but no offscreen exists, it's stale
        if (st.state !== "stopped" && !(await hasOffscreenDocument())) {
          await saveState({ state: "stopped", statusText: "", chunk: 0, totalChunks: 0 });
        }
        sendResponse({ ok: true, payload: await loadState() });
        break;
      }

      // ── Playback control (shared with commands + context menu, issue #6) ─
      case "play":   { await startPlayback(message.payload); sendResponse({ ok: true }); break; }
      case "pause":  { await pausePlayback();                sendResponse({ ok: true }); break; }
      case "resume": { await resumePlayback();               sendResponse({ ok: true }); break; }
      case "stop":   { await stopPlayback();                 sendResponse({ ok: true }); break; }

      // ── Read-from-here from the in-page hint bubble (issue #16) ─────────
      // The content script's clickable hint sends this; sender.tab is the
      // page it came from — same handler as the command and context menu.
      case "readFromHereShortcut": {
        if (sender?.tab && typeof sender.tab.id === "number") {
          await handleReadFromHere(sender.tab);
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: "No tab context." });
        }
        break;
      }

      // ── State update from offscreen ──────────────────────────────────────
      case "stateUpdate": {
        const updated = await saveState(message.payload);
        let advanced = false;

        // Queue bookkeeping: persist the resume position on pause/stop, and
        // auto-advance to the next queue item after a natural finish.
        if (_queueCurrentId) {
          const finished = /finished/i.test(updated.statusText || "");
          if (updated.state === "paused") {
            await persistQueuePosition(_queueCurrentId, resumeIndexFromReportedChunk(updated.chunk));
          } else if (updated.state === "stopped") {
            await persistQueuePosition(
              _queueCurrentId,
              finished ? 0 : resumeIndexFromReportedChunk(updated.chunk)
            );
            if (finished) advanced = await advanceQueueAfterFinish();
          }
        }

        if (updated.state === "stopped" && !advanced) {
          await sleep(100);
          await closeOffscreenDocument();
        }

        // After an advance, forward the new playback state (the offscreen
        // document is reused — it must not be closed).
        const finalState = advanced ? await loadState() : updated;

        // Forward to popup (if open)
        chrome.runtime.sendMessage({
          target: "popup",
          type: "stateUpdate",
          payload: finalState,
        }).catch(() => {});

        // Forward to content script (floating player)
        await notifyContentScript(_activeTabId, {
          state:       finalState.state,
          chunk:       finalState.chunk || 0,
          totalChunks: finalState.totalChunks || 0,
        });

        sendResponse({ ok: true });
        break;
      }

      // ── Word/sentence highlight cursor (issue #4) ────────────────────────
      // High-frequency progress from offscreen: forwarded to the active
      // tab's content script ONLY — never persisted into playback state.
      // Queue playback has no active tab, so it is simply not forwarded.
      case "highlightUpdate": {
        let tabId = _activeTabId;
        if (typeof tabId !== "number") {
          const stored = await chrome.storage.session.get("activeTabId").catch(() => ({}));
          if (typeof stored.activeTabId === "number") {
            tabId = stored.activeTabId;
            _activeTabId = tabId;
          }
        }
        if (typeof tabId === "number") {
          chrome.tabs.sendMessage(tabId, {
            target: "content",
            type:   "highlightUpdate",
            payload: message.payload,
          }).catch(() => {});
        }
        sendResponse({ ok: true });
        break;
      }

      // ── Listening queue (issue #3) ───────────────────────────────────────
      case "queueGet": {
        const queue = await loadQueue();
        sendResponse({ ok: true, payload: { queue, currentId: _queueCurrentId } });
        break;
      }

      case "queueAddCurrent": {
        let tabId = typeof message.payload?.tabId === "number"
          ? message.payload.tabId
          : (typeof sender?.tab?.id === "number" ? sender.tab.id : null);
        if (typeof tabId !== "number") {
          const [tab] = await chrome.tabs
            .query({ active: true, lastFocusedWindow: true })
            .catch(() => []);
          tabId = typeof tab?.id === "number" ? tab.id : null;
        }
        if (typeof tabId !== "number") {
          sendResponse({ ok: false, error: "No active tab to save." });
          break;
        }
        sendResponse(await addCurrentToQueue(tabId));
        break;
      }

      case "queueRemove": {
        const id = message.payload?.id;
        const queue = await loadQueue();
        await saveQueue(removeFromQueue(queue, id));
        if (id === _queueCurrentId) await setQueueCurrent(null);
        await broadcastQueue();
        sendResponse({ ok: true });
        break;
      }

      case "queueMove": {
        const queue = await loadQueue();
        await saveQueue(moveQueueItem(queue, message.payload?.id, message.payload?.dir));
        await broadcastQueue();
        sendResponse({ ok: true });
        break;
      }

      case "queuePlay": {
        const started = await playQueueItem(message.payload?.id);
        sendResponse({ ok: started, error: started ? undefined : "Queue item not found." });
        break;
      }

      // ── PDF import (issue #5) ────────────────────────────────────────────
      // payload: { buffer: ArrayBuffer, name: string }. Response: the queue
      // item (success) or operator-facing error copy (see lib/pv-pdf.js).
      case "pdfImport": {
        sendResponse(await importPdfToQueue(message.payload));
        break;
      }

      // ── Kokoro server status (issue #7) ─────────────────────────────────
      // Settings "Check again" + status line. Runs in the service worker so
      // the popup can close mid-probe. Response: { ok, payload: { reachable,
      // voices, failure, checkedAt } } — pure logic in lib/pv-kokoro.js.
      case "kokoroStatus": {
        sendResponse({ ok: true, payload: await probeKokoro() });
        break;
      }

      default:
        sendResponse({ ok: false, error: "Unknown message type: " + message.type });
    }
  })();

  return true; // keep channel open for async sendResponse
});

// ─── Keyboard shortcuts + read-from-here (issue #6) ───────────────────────────
//
// chrome.commands (manifest "commands") and the context menu drive the SAME
// playback functions as the popup's messages, so hotkeys work with the
// popup closed. "Read from here" asks the tab's content script where the
// anchor (the user's selection, or the paragraph they right-clicked) sits
// in the article, then starts playback from the chunk covering that
// sentence — computed against the active engine's chunking by the content
// script (lib/pv-shortcuts.js), threaded through offscreen's startChunk.

async function activeTab() {
  const [tab] = await chrome.tabs
    .query({ active: true, lastFocusedWindow: true })
    .catch(() => []);
  return typeof tab?.id === "number" ? tab : null;
}

// Build a page-playback payload from the user's saved settings. Playback
// started outside the popup (command / context menu) has no popup to build
// it, exactly like queue playback — background assembles it itself.
async function pagePlayPayload(tab, data, startChunk) {
  const settings = await chrome.storage.sync
    .get(["engine", "voice", "speed", "openaiKey", "elevenLabsKey"])
    .catch(() => ({}));
  const engine = settings.engine || "edge";
  return {
    text:        data.text,
    engine,
    voice:       settings.voice || "",
    speed:       parseFloat(settings.speed) || 1.0,
    apiKey:      engine === "elevenlabs" ? (settings.elevenLabsKey || "") : (settings.openaiKey || ""),
    tabId:       tab.id,
    startChunk:  typeof startChunk === "number" ? startChunk : 0,
  };
}

// play-pause hotkey: toggle playback; from a stopped state, start reading
// the current page's article (from the top, or the given chunk).
async function handlePlayPauseCommand() {
  const st = await loadState();
  // If state says active but no offscreen exists, it's stale → stopped.
  if (st.state !== "stopped" && !(await hasOffscreenDocument())) {
    await saveState({ state: "stopped", statusText: "", chunk: 0, totalChunks: 0 });
    st.state = "stopped";
  }
  if (st.state === "playing") return pausePlayback();
  if (st.state === "paused")  return resumePlayback();
  return playCurrentTab();
}

async function playCurrentTab(startChunk) {
  const tab = await activeTab();
  if (!tab) return;
  const data = await extractFromTab(tab.id);
  if (!data || !data.text) return;
  await startPlayback(await pagePlayPayload(tab, data, startChunk));
}

chrome.commands.onCommand.addListener((command) => {
  (async () => {
    switch (command) {
      case "play-pause":    await handlePlayPauseCommand(); break;
      case "stop":          await stopPlayback();           break;
      case "save-to-queue": {
        const tab = await activeTab();
        if (tab) await addCurrentToQueue(tab.id);
        break;
      }
      // Issue #16: read-from-here needed a discoverable trigger beyond the
      // right-click context menu. Same handler as the menu + the in-page
      // hint bubble's click — selection first, else the clicked paragraph.
      case "read-from-here": {
        const tab = await activeTab();
        if (tab) await handleReadFromHere(tab);
        break;
      }
      default: break;
    }
  })();
});

// Context menu: "Read from here" (activeTab context — no new broad
// permissions). removeAll + create inside onInstalled is the
// duplicate-safe registration pattern (extension updates re-fire it).
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id:       "pv-read-from-here",
      title:    "Read from here",
      contexts: ["selection", "page"],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info?.menuItemId !== "pv-read-from-here") return;
  handleReadFromHere(tab).catch(() => {});
});

// No anchor / no extractable text → the content script answers ok:false,
// and playback simply does not start. An anchor the article does not
// contain answers startChunk 0 — read from the top, never a wrong jump.
async function handleReadFromHere(tab) {
  if (!tab || typeof tab.id !== "number") return;
  const response = await getReadFromHereFromTab(tab.id);
  if (!response || !response.ok || !response.text) return;
  await startPlayback(await pagePlayPayload(tab, response, response.startChunk));
}

function getReadFromHereFromTab(tabId) {
  return new Promise(async (resolve) => {
    // Same injection pattern as extractFromTab: a no-op when the content
    // script is already on the page (window guard in content.js).
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    } catch (_) {}
    await sleep(200);
    chrome.tabs.sendMessage(tabId, { target: "content", type: "getReadFromHere" }, (response) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(response);
    });
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
