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
 *   offscreen → background: stateUpdate { state, statusText, chunk, totalChunks, engine }
 *   background → offscreen: play | pause | resume | stop
 *   background → popup:     stateUpdate
 *   background → content:   playerUpdate { state, chunk, totalChunks }
 */

const OFFSCREEN_URL = chrome.runtime.getURL("offscreen.html");

// ─── State ─────────────────────────────────────────────────────────────────────

let _state = { state: "stopped", statusText: "", chunk: 0, totalChunks: 0, engine: "edge" };
let _activeTabId = null;

async function loadState() {
  const stored = await chrome.storage.session
    .get(["playbackState", "activeTabId"])
    .catch(() => ({}));
  if (stored.playbackState) _state = stored.playbackState;
  if (typeof stored.activeTabId === "number") _activeTabId = stored.activeTabId;
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

// ─── Content Script Notifications ─────────────────────────────────────────────

async function notifyContentScript(tabId, payload) {
  let targetTabId = tabId;

  if (typeof targetTabId !== "number") {
    const stored = await chrome.storage.session.get("activeTabId").catch(() => ({}));
    targetTabId = stored.activeTabId;
  }

  if (typeof targetTabId !== "number") return;

  _activeTabId = targetTabId;
  chrome.tabs.sendMessage(targetTabId, { target: "content", type: "playerUpdate", payload }).catch(() => {});
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

      // ── Start playback ───────────────────────────────────────────────────
      case "play": {
        if (typeof message.payload?.tabId === "number") {
          await saveActiveTabId(message.payload.tabId);
        }
        await saveState({ state: "playing", statusText: "Starting…", engine: message.payload?.engine || "edge" });
        await ensureOffscreenDocument();
        chrome.runtime.sendMessage({
          target: "offscreen",
          type: "play",
          payload: message.payload,
        }).catch(() => {});
        // Notify content script to show mini-player
        await notifyContentScript(_activeTabId, { state: "playing", chunk: 0, totalChunks: 0 });
        sendResponse({ ok: true });
        break;
      }

      // ── Pause ────────────────────────────────────────────────────────────
      case "pause": {
        await saveState({ state: "paused", statusText: "Paused" });
        chrome.runtime.sendMessage({ target: "offscreen", type: "pause" }).catch(() => {});
        await notifyContentScript(_activeTabId, { state: "paused", chunk: _state.chunk, totalChunks: _state.totalChunks });
        sendResponse({ ok: true });
        break;
      }

      // ── Resume ───────────────────────────────────────────────────────────
      case "resume": {
        await saveState({ state: "playing", statusText: _state.statusText });
        chrome.runtime.sendMessage({ target: "offscreen", type: "resume" }).catch(() => {});
        await notifyContentScript(_activeTabId, { state: "playing", chunk: _state.chunk, totalChunks: _state.totalChunks });
        sendResponse({ ok: true });
        break;
      }

      // ── Stop ─────────────────────────────────────────────────────────────
      case "stop": {
        await saveState({ state: "stopped", statusText: "", chunk: 0, totalChunks: 0 });
        chrome.runtime.sendMessage({ target: "offscreen", type: "stop" }).catch(() => {});
        await notifyContentScript(_activeTabId, { state: "stopped" });
        await sleep(250);
        await closeOffscreenDocument();
        sendResponse({ ok: true });
        break;
      }

      // ── State update from offscreen ──────────────────────────────────────
      case "stateUpdate": {
        const updated = await saveState(message.payload);

        if (updated.state === "stopped") {
          await sleep(100);
          await closeOffscreenDocument();
        }

        // Forward to popup (if open)
        chrome.runtime.sendMessage({
          target: "popup",
          type: "stateUpdate",
          payload: updated,
        }).catch(() => {});

        // Forward to content script (floating player)
        await notifyContentScript(_activeTabId, {
          state:       updated.state,
          chunk:       updated.chunk || 0,
          totalChunks: updated.totalChunks || 0,
        });

        sendResponse({ ok: true });
        break;
      }

      default:
        sendResponse({ ok: false, error: "Unknown message type: " + message.type });
    }
  })();

  return true; // keep channel open for async sendResponse
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
