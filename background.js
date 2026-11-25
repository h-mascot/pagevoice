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
 *   offscreen → background: highlightUpdate { engine, sentence, word } (issue #4)
 *   background → offscreen: play | pause | resume | stop
 *   background → popup:     stateUpdate | queueUpdate
 *   background → content:   playerUpdate { state, chunk, totalChunks }
 *                           highlightUpdate { engine, sentence, word }
 *
 * Listening queue (issue #3): the queue lives in chrome.storage.local
 * (key QUEUE_STORAGE_KEY, schema-versioned by lib/pv-queue.js). Queue logic
 * is pure and unit-tested in lib/pv-queue.test.js; this file only wires it
 * to storage, messages, and playback.
 */

importScripts("lib/pv-queue.js");

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

      // ── Start playback ───────────────────────────────────────────────────
      case "play": {
        // Plain page playback is not queue playback — drop the queue cursor
        // so a natural finish does not auto-advance into the queue.
        if (!message.payload?.queueItemId) {
          await setQueueCurrent(null);
        }
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
        // Save the queue resume position before tearing playback down.
        if (_queueCurrentId) {
          await persistQueuePosition(_queueCurrentId, resumeIndexFromReportedChunk(_state.chunk));
        }
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
