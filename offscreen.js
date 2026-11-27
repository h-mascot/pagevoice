/**
 * offscreen.js — PageVoice Offscreen Document (v2)
 *
 * Handles ALL audio playback:
 *   - Edge TTS  (free, StreamElements fetch + Bing fallback, default)
 *   - OpenAI TTS (API key, REST)
 *   - ElevenLabs  (API key, REST)
 *   - Browser Local TTS (SpeechSynthesis)
 *
 * Also handles PDF text extraction (issue #5) with the vendored pdf.js
 * (vendor/pdfjs, pinned 3.11.174), lazy-loaded here on first import so
 * ordinary playback never pays the parse cost.
 *
 * Lives as a persistent hidden HTML page so audio continues when popup closes.
 * Communicates exclusively with background.js via chrome.runtime.sendMessage.
 */

const DEFAULT_ELEVENLABS_KEY = "";
// KOKORO_BASE_URL + probe helpers live in lib/pv-kokoro.js (loaded first
// by offscreen.html); the 60s TTS request timeout stays here — synthesis
// of a large chunk legitimately takes seconds, unlike the fast probe.
const KOKORO_REQUEST_TIMEOUT_MS = 60000;

// ─── Playback state ───────────────────────────────────────────────────────────

let currentAudio    = null;
let isStopped       = false;
let isPaused        = false;
let currentState    = "stopped";
let currentStatus   = "";
let playbackSpeed   = 1;
let localHighlightTimer = null;

// ─── PDF import — vendored pdf.js, lazy-loaded (issue #5) ────────────────────
//
// background transfers the PDF bytes here in base64 CHUNKS (pdf-extract-begin
// / pdf-extract-chunk / pdf-extract-end — the same lib/pv-transport.js
// protocol the popup/content senders use, because this hop JSON-serializes
// messages exactly like the sender→background hop: an ArrayBuffer payload
// does not survive it, which is how v2.2.1's { buffer } transfer died);
// extraction logic itself is lib/pv-pdf.js (unit-tested in
// Node against the same vendored files). Load order matters: the worker
// script must define globalThis.pdfjsWorker BEFORE pdf.min.js evaluates —
// pdf.js then runs its worker on the main thread of this document, so no
// `new Worker` and no workerSrc fetch ever happen (MV3-safe; see
// vendor/pdfjs/VENDOR.md). ~1.5 MB of parse only happens on first import.

let _pdfJsLoad = null;

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = chrome.runtime.getURL(src);
    el.onload = () => resolve();
    el.onerror = () => reject(new Error("Failed to load " + src));
    document.head.appendChild(el);
  });
}

function ensurePdfJs() {
  if (window.pdfjsLib && window.pdfjsWorker) return Promise.resolve(window.pdfjsLib);
  if (!_pdfJsLoad) {
    _pdfJsLoad = (async () => {
      try {
        await loadScriptOnce("vendor/pdfjs/legacy/build/pdf.worker.min.js");
        await loadScriptOnce("vendor/pdfjs/legacy/build/pdf.min.js");
        if (!window.pdfjsLib || !window.pdfjsWorker) {
          throw new Error("pdf.js globals missing after script load");
        }
        return window.pdfjsLib;
      } catch (err) {
        _pdfJsLoad = null; // allow a retry on the next import (script load
                           // failure included — a cached rejected promise
                           // would brick every later import until reload)
        throw err;
      }
    })();
  }
  return _pdfJsLoad;
}

// In-flight extraction sessions (issue #20 chunked transport):
// id → { session, timer }. A 60 s idle GC drops sessions whose sender
// (the background import flow) died before pdf-extract-end.
const _pdfExtractSessions = new Map();
let _pdfExtractSeq = 0;
const PDF_EXTRACT_SESSION_MS = 60_000;

async function extractPdfOffscreen(data) {
  let lib;
  try {
    lib = await ensurePdfJs();
  } catch (_) {
    return { ok: false, code: "load-failed", error: PDF_ERRORS["load-failed"] };
  }
  return extractPdfText(lib, data, {
    onProgress: (page, total) => {
      // Best-effort progress for the popup (it may already be closed —
      // background completes the import either way).
      chrome.runtime.sendMessage({
        target:  "popup",
        type:    "pdfImportProgress",
        payload: { page, total },
      }).catch(() => {});
    },
  });
}

// ─── Message Router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== "offscreen") return false;

  (async () => {
    switch (message.type) {

      case "play": {
        isStopped = false;
        isPaused  = false;
        localPlaybackId++;
        resetHighlight(); // a fresh play re-emits highlight events from the top
        const { text, engine, voice, speed, apiKey } = message.payload;
        playbackSpeed = Number(speed) || 1;
        // Listening-queue resume: 0-based index of the first chunk to play.
        const startChunk = Number.isFinite(message.payload?.startChunk)
          ? message.payload.startChunk
          : 0;

        // Fire-and-forget — state updates are pushed to background
        switch (engine) {
          case "edge":       speakWithEdgeTTS(text, voice, speed, startChunk);       break;
          case "openai":     speakWithOpenAI(text, voice, speed, apiKey, startChunk); break;
          case "elevenlabs": speakWithElevenLabs(text, voice, speed, apiKey, startChunk); break;
          case "kokoro":     speakWithKokoro(text, voice, speed, startChunk);        break;
          default:           speakWithLocalTTS(text, voice, speed, startChunk);      break;
        }
        sendResponse({ ok: true });
        break;
      }

      case "pause": {
        isPaused = true;
        if (currentAudio) { currentAudio.pause(); }
        else if (typeof speechSynthesis !== "undefined") { speechSynthesis.pause(); }
        reportState("paused", "Paused");
        sendResponse({ ok: true });
        break;
      }

      case "resume": {
        isPaused = false;
        if (currentAudio) { currentAudio.play().catch(() => {}); }
        else if (typeof speechSynthesis !== "undefined") { speechSynthesis.resume(); }
        reportState("playing", currentStatus);
        sendResponse({ ok: true });
        break;
      }

      case "stop": {
        isStopped = true;
        localPlaybackId++;
        if (localHighlightTimer) clearInterval(localHighlightTimer);
        localHighlightTimer = null;
        if (currentAudio) { currentAudio.pause(); currentAudio = null; }
        if (typeof speechSynthesis !== "undefined") { speechSynthesis.cancel(); }
        sendResponse({ ok: true });
        break;
      }

      case "setSpeed": {
        const rate = Number(message.payload?.speed);
        if (Number.isFinite(rate) && rate >= 0.5 && rate <= 3) {
          playbackSpeed = rate;
          if (currentAudio) currentAudio.playbackRate = rate;
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false });
        }
        break;
      }

      // ── PDF text extraction (issue #5; chunked transport issue #20) ────
      // background transfers the bytes in base64 chunks over the same
      // begin/chunk/end protocol the popup/content senders use (this hop
      // JSON-serializes messages the same way — an ArrayBuffer does not
      // survive it). Assembled bytes are byte-verified before extraction.
      // Per-page progress is pushed separately as pdfImportProgress → popup.
      case "pdf-extract-begin": {
        if (!isValidPdfTransportBegin(message.payload)) {
          sendResponse({ ok: false, code: "invalid", error: "No PDF data received." });
          break;
        }
        const id = `pdf-extract-${++_pdfExtractSeq}-${Date.now()}`;
        const s = makePdfTransportSession();
        s.expectedTotal = message.payload.totalBytes;
        s.expectedCount = message.payload.chunkCount;
        _pdfExtractSessions.set(id, {
          session: s,
          timer: setTimeout(() => _pdfExtractSessions.delete(id), PDF_EXTRACT_SESSION_MS),
        });
        sendResponse({ ok: true, sessionId: id });
        break;
      }
      case "pdf-extract-chunk": {
        const entry = _pdfExtractSessions.get(message.payload?.sessionId);
        if (!entry) {
          sendResponse({ ok: false, error: "extraction session expired" });
          break;
        }
        if (!pdfSessionAddChunk(entry.session, message.payload)) {
          clearTimeout(entry.timer);
          _pdfExtractSessions.delete(message.payload.sessionId); // bad chunk — drop the session
          sendResponse({ ok: false, error: "bad chunk" });
          break;
        }
        sendResponse({ ok: true, received: entry.session.received });
        break;
      }
      case "pdf-extract-end": {
        const entry = _pdfExtractSessions.get(message.payload?.sessionId);
        if (!entry) {
          sendResponse({ ok: false, code: "invalid", error: "No PDF data received." });
          break;
        }
        clearTimeout(entry.timer);
        _pdfExtractSessions.delete(message.payload.sessionId);
        const bytes = pdfSessionAssemble(
          entry.session,
          entry.session.expectedTotal,
          entry.session.expectedCount
        );
        if (!bytes) {
          sendResponse({ ok: false, code: "invalid", error: "No PDF data received." });
          break;
        }
        sendResponse(await extractPdfOffscreen(bytes));
        break;
      }

      default:
        sendResponse({ ok: false, error: "Unknown message type" });
    }
  })();

  return true;
});

// ─── State Reporter ───────────────────────────────────────────────────────────

function reportState(state, statusText, extra = {}) {
  currentState  = state;
  currentStatus = statusText;
  chrome.runtime.sendMessage({
    target: "background",
    type:   "stateUpdate",
    payload: { state, statusText, ...extra },
  }).catch(() => {});
}

// ─── Highlight reporting (issue #4) ──────────────────────────────────────────
//
// Word/sentence highlight events are high-frequency and deliberately do NOT
// flow through reportState (they would flood chrome.storage.session). They
// go straight to background.js, which forwards them to the active tab's
// content script. Payload: { engine, sentence, word } where `sentence` is
// the 0-based GLOBAL sentence index (over the whole article, as segmented
// by splitIntoSentences on the same text content.js extracted) and `word`
// is the 0-based word index inside that sentence. Events are deduped by
// (engine, sentence, word); the key resets on every new play message so a
// replay re-emits from the top.

let _lastHighlightKey = "";

function resetHighlight() {
  _lastHighlightKey = "";
}

function reportHighlight(engine, chunk, localSentence, word) {
  const base = typeof chunk?.sentenceStart === "number" ? chunk.sentenceStart : null;
  if (base === null) return;
  const sentence = base + Math.max(0, Math.floor(localSentence || 0));
  const key = `${engine}:${sentence}:${word}`;
  if (key === _lastHighlightKey) return;
  _lastHighlightKey = key;
  chrome.runtime.sendMessage({
    target: "background",
    type:   "highlightUpdate",
    payload: { engine, sentence, word },
  }).catch(() => {});
}

// Build the onTime(mediaTimeSec, durationSec) callback for an audio chunk.
// Word events (Edge TTS Bing path) give exact word timing; otherwise the
// position is estimated proportionally from the audio element's media
// position. Both are anchored to MEDIA time (currentTime), so highlighting
// stays in sync at any playbackRate (0.5x–3x) — currentTime reaches a
// word's media offset at the same media position regardless of rate.
//
// Issue #15: the event → word mapping is POSITION-based, not ordinal-based.
// Bing WordBoundary events do not map 1:1 to whitespace tokens (numbers
// expand: "1,000" → "one" + "thousand"), so counting events shifted the
// ordinal for the rest of the chunk. Each event's spoken text is matched
// into the chunk text (monotone cursor); the matched offset then resolves
// to sentence + word. Unmatched events inherit the last matched offset.
// The fraction path (no metadata) estimates the word from the media
// fraction — per-sentence kokoro chunks keep that estimate inside the
// sentence actually playing.
function makeHighlightTracker(engine, chunk, wordEvents) {
  const sentences = splitIntoSentences(chunk.text);
  const starts = sentenceStartOffsets(sentences);
  const eventOffsets = Array.isArray(wordEvents) && wordEvents.length > 0
    ? mapWordEventsToCharOffsets(chunk.text, wordEvents)
    : null;
  return (mediaTimeSec, durationSec) => {
    if (isStopped) return;
    let sw = null;
    if (eventOffsets) {
      const ordinal = wordOrdinalAtMediaTime(wordEvents, mediaTimeSec);
      const off = ordinal >= 0 && ordinal < eventOffsets.length ? eventOffsets[ordinal] : -1;
      sw = off >= 0 ? charOffsetToSentenceWord(sentences, starts, off) : null;
    } else if (Number.isFinite(durationSec) && durationSec > 0) {
      const fraction = Math.min(1, Math.max(0, mediaTimeSec / durationSec));
      sw = wordOrdinalToSentenceWord(sentences, wordOrdinalFromFraction(chunk.text, fraction));
    } else {
      return; // duration not known yet — wait for the next timeupdate
    }
    if (sw) reportHighlight(engine, chunk, sw.sentence, sw.word);
  };
}

// ─── Shared audio player ──────────────────────────────────────────────────────

// onTime, when provided, receives (mediaTimeSec, durationSec) on every
// audio timeupdate — used by the highlighting trackers (issue #4).
function playAudioBlob(blob, playbackRate = 1.0, onTime = null) {
  return new Promise((resolve, reject) => {
    if (isStopped) { resolve(); return; }
    const url      = URL.createObjectURL(blob);
    const audio    = new Audio(url);
    const safeRate = clampAudioRate(playbackRate);

    audio.defaultPlaybackRate = safeRate;
    audio.playbackRate        = safeRate;
    currentAudio = audio;

    const cleanup = () => {
      audio.ontimeupdate = null;
      URL.revokeObjectURL(url);
      currentAudio = null;
    };

    if (onTime) {
      audio.ontimeupdate = () => {
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          try { onTime(audio.currentTime, audio.duration); } catch (_) {}
        }
      };
    }

    audio.onended = () => {
      cleanup();
      resolve();
    };
    audio.onerror = () => {
      cleanup();
      reject(new Error("Audio playback error"));
    };
    audio.play().catch((error) => {
      cleanup();
      reject(error);
    });
  });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readResponseError(res) {
  const fallback = [res.statusText, `HTTP ${res.status}`].filter(Boolean).join(": ");

  try {
    const raw = (await res.text()).trim();
    if (!raw) return fallback;

    try {
      const data = JSON.parse(raw);
      const code = [
        data?.error?.code,
        data?.error?.type,
        data?.detail?.status,
        data?.code,
      ].find((value) => typeof value === "string" && value.trim());
      const message = [
        data?.error?.message,
        data?.detail?.message,
        data?.message,
        typeof data?.detail === "string" ? data.detail : "",
      ].find((value) => typeof value === "string" && value.trim());

      if (code && message && !message.toLowerCase().includes(code.toLowerCase())) {
        return `${code}: ${message}`;
      }
      return message || code || raw;
    } catch {
      return raw;
    }
  } catch {
    return fallback;
  }
}

// ─── Edge TTS (StreamElements primary, Bing fallback) ────────────────────────
//
// Primary: https://api.streamelements.com/kappa/v2/speech
// Fallback protocol reference: https://github.com/rany2/edge-tts
// wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1
// ?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&ConnectionId=<UUID>

const EDGE_TOKEN  = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const EDGE_WS_URL = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${EDGE_TOKEN}`;
const STREAMELEMENTS_TTS_URL = "https://api.streamelements.com/kappa/v2/speech";

// Pure logic (StreamElements voice mapping, XML escaping, speed clamps,
// prosody conversion, sentence splitting, text chunking) lives in
// lib/pv-utils.js — loaded by offscreen.html BEFORE this file, so its
// top-level declarations are globals here and unit-testable in Node.

function mkConnectionId() {
  return "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx".replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16)
  );
}

function isoNow() {
  return new Date().toISOString();
}

function edgeConfigMsg() {
  return (
    `X-Timestamp:${isoNow()}\r\n` +
    `Content-Type:application/json; charset=utf-8\r\n` +
    `Path:speech.config\r\n\r\n` +
    JSON.stringify({
      context: {
        synthesis: {
          audio: {
            metadataoptions: {
              sentenceBoundaryEnabled: "false",
              wordBoundaryEnabled:     "true",
            },
            outputFormat: "audio-24khz-48kbitrate-mono-mp3",
          },
        },
      },
    })
  );
}

function edgeSsmlMsg(requestId, voiceName, text, speedRate) {
  // Convert numeric speed (1.0) to Edge TTS prosody rate (+0%, +50%, -25%, etc.)
  const rateStr = speedToProsodyRate(speedRate);
  const ssml = [
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>`,
    `<voice name='${voiceName}'>`,
    `<prosody rate='${rateStr}'>${escapeXml(text)}</prosody>`,
    `</voice></speak>`,
  ].join("");

  return (
    `X-RequestId:${requestId}\r\n` +
    `Content-Type:application/ssml+xml\r\n` +
    `X-Timestamp:${isoNow()}\r\n` +
    `Path:ssml\r\n\r\n` +
    ssml
  );
}

// Voice → Google Translate language code mapping
const EDGE_GTTS_LANG_MAP = {
  "en-GB-SoniaNeural":   "en-GB",
  "en-GB-RyanNeural":    "en-GB",
  "en-US-JennyNeural":   "en-US",
  "en-US-GuyNeural":     "en-US",
  "en-AU-NatashaNeural": "en-AU",
  "en-AU-WilliamNeural": "en-AU",
  "en-US-AriaNeural":    "en-US",
};

// Synthesise via Google Translate TTS (free, no auth, ~200 char limit per request)
// For longer text, we split into small chunks and concatenate the blobs
async function edgeTTSChunkViaGoogle(voiceName, text) {
  const lang = EDGE_GTTS_LANG_MAP[voiceName] || "en-GB";
  // Split text into ~180 char sentence-aware chunks for Google's limit
  const miniChunks = [];
  const sentences = splitIntoSentences(text);
  let current = "";
  for (const s of sentences) {
    const next = current ? `${current} ${s}` : s;
    if (next.length > 180) {
      if (current) miniChunks.push(current.trim());
      current = s;
    } else {
      current = next;
    }
  }
  if (current.trim()) miniChunks.push(current.trim());

  const audioBlobs = [];
  for (const chunk of miniChunks) {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${encodeURIComponent(lang)}&client=tw-ob&q=${encodeURIComponent(chunk)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Google TTS ${res.status}`);
    audioBlobs.push(await res.blob());
  }

  // Concatenate all blobs
  return new Blob(audioBlobs, { type: "audio/mpeg" });
}

// Synthesise a single chunk via Edge TTS WebSocket; resolves with
// { blob, wordEvents } where wordEvents are the WordBoundary metadata
// events: [{ offset (100ns ticks from audio start), duration, text }],
// used for exact word-level highlighting (issue #4). Engines without
// metadata pass wordEvents: [] and fall back to proportional estimation.
function edgeTTSChunkViaBing(voiceName, text, speedRate) {
  return new Promise((resolve, reject) => {
    const connectionId = mkConnectionId();
    const requestId    = mkConnectionId();
    const wsUrl        = `${EDGE_WS_URL}&ConnectionId=${connectionId}`;

    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      return reject(err);
    }

    ws.binaryType = "arraybuffer";

    const audioChunks = [];
    const wordEvents  = [];
    let   turnDone    = false;
    const timeout     = setTimeout(() => {
      ws.close();
      reject(new Error("Edge TTS timeout"));
    }, 30000);

    ws.onopen = () => {
      ws.send(edgeConfigMsg());
      ws.send(edgeSsmlMsg(requestId, voiceName, text, speedRate));
    };

    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        // Text frame — turn.end closes the turn; audio.metadata carries
        // word boundary timing (wordBoundaryEnabled: "true" above).
        if (event.data.includes("Path:turn.end")) {
          turnDone = true;
          ws.close();
        } else if (event.data.includes("Path:audio.metadata")) {
          try {
            const headerEnd = event.data.indexOf("\r\n\r\n");
            const body = headerEnd === -1 ? "" : event.data.slice(headerEnd + 4);
            const meta = JSON.parse(body);
            for (const m of meta?.Metadata || []) {
              if (m?.Type === "WordBoundary" && Number.isFinite(m?.Data?.Offset)) {
                wordEvents.push({
                  offset:   m.Data.Offset,
                  duration: m.Data.Duration || 0,
                  text:     m.Data?.text?.Text || "",
                });
              }
            }
          } catch (_) { /* malformed metadata frame — ignore */ }
        }
      } else {
        // Binary frame — audio data
        // Format: [2-byte header length][header text][audio bytes]
        const buf        = event.data;
        const view       = new DataView(buf);
        const headerLen  = view.getUint16(0); // big-endian
        const header     = new TextDecoder().decode(new Uint8Array(buf, 2, headerLen));

        if (header.includes("Path:audio")) {
          const audioData = buf.slice(2 + headerLen);
          audioChunks.push(audioData);
        }
      }
    };

    ws.onclose = () => {
      clearTimeout(timeout);
      if (audioChunks.length === 0 && !turnDone) {
        reject(new Error("Edge TTS: no audio received"));
        return;
      }
      // Merge ArrayBuffers into a single Blob
      const blob = new Blob(audioChunks, { type: "audio/mpeg" });
      resolve({ blob, wordEvents });
    };

    ws.onerror = (err) => {
      clearTimeout(timeout);
      reject(new Error("Edge TTS WebSocket error"));
    };
  });
}

async function speakWithEdgeTTS(text, voiceName, speed, startChunk = 0) {
  const voice  = voiceName || "en-GB-SoniaNeural";
  const chunks = buildEngineChunks(text, "edge"); // single source shared with read-from-here (issue #15)
  const startAt = clampStartIndex(startChunk, chunks.length);
  let provider = null;

  for (let i = startAt; i < chunks.length; i++) {
    if (isStopped) return;
    while (isPaused && !isStopped) { await sleep(100); }
    if (isStopped) return;

    reportState("playing", `Fetching audio… ${i + 1}/${chunks.length}`, {
      chunk: i + 1, totalChunks: chunks.length, engine: "edge",
    });
    reportHighlight("edge", chunks[i], 0, 0);

    try {
      // Try Bing WebSocket first (best quality, word-boundary metadata)
      if (provider === "google") throw new Error("Continue with Google TTS");
      const { blob, wordEvents } = await edgeTTSChunkViaBing(voice, chunks[i].text, 1);
      if (isStopped) return;
      provider = "bing";
      reportState("playing", `Playing… ${i + 1}/${chunks.length}`, {
        chunk: i + 1, totalChunks: chunks.length, engine: "edge",
      });
      await playAudioBlob(blob, playbackSpeed, makeHighlightTracker("edge", chunks[i], wordEvents));
      while (isPaused && !isStopped) { await sleep(100); }
    } catch (bingErr) {
      if (provider === "bing") {
        reportState("stopped", "Edge TTS connection lost. Press play to retry.");
        return;
      }
      try {
        // Fallback: Google Translate TTS (free, no auth) — no word metadata,
        // so highlighting falls back to proportional estimation.
        const blob = await edgeTTSChunkViaGoogle(voice, chunks[i].text);
        if (isStopped) return;
        provider = "google";
        await playAudioBlob(blob, playbackSpeed, makeHighlightTracker("edge", chunks[i], null));
        while (isPaused && !isStopped) { await sleep(100); }
      } catch (googleErr) {
        if (provider === "google") {
          reportState("stopped", "Google TTS connection lost. Press play to retry.");
          return;
        }
        // Last resort: Browser Local TTS
        if (!isStopped) {
          reportState("playing", "Network TTS unavailable, using Browser TTS…", {
            chunk: i + 1,
            totalChunks: chunks.length,
            engine: "local",
          });
          speakWithLocalTTS(
            chunks.slice(i).map((c) => c.text).join(" "),
            null, playbackSpeed, 0, chunks[i].sentenceStart
          );
        }
        return;
      }
    }
  }

  if (!isStopped) {
    reportState("stopped", "Finished ✓");
  }
}

// ─── OpenAI TTS ───────────────────────────────────────────────────────────────

async function speakWithOpenAI(text, voice, speed, apiKey, startChunk = 0) {
  if (!apiKey || !apiKey.trim()) {
    reportState("stopped", "OpenAI API key required — add it in Settings");
    return;
  }

  const effectiveVoice = voice || "nova";
  const chunks         = buildEngineChunks(text, "openai"); // single source (issue #15)
  const startAt        = clampStartIndex(startChunk, chunks.length);

  for (let i = startAt; i < chunks.length; i++) {
    if (isStopped) return;
    while (isPaused && !isStopped) { await sleep(100); }
    if (isStopped) return;

    reportState("playing", `Fetching audio… ${i + 1}/${chunks.length}`, {
      chunk: i + 1, totalChunks: chunks.length, engine: "openai",
    });
    reportHighlight("openai", chunks[i], 0, 0);

    try {
      const res = await fetch("https://api.openai.com/v1/audio/speech", {
        method:  "POST",
        headers: {
          "Authorization": `Bearer ${apiKey.trim()}`,
          "Content-Type":  "application/json",
        },
        body: JSON.stringify({
          model: "tts-1",
          input: chunks[i].text,
          voice: effectiveVoice,
          speed: 1,
        }),
      });

      if (!res.ok) {
        const msg = await readResponseError(res);
        throw new Error(`OpenAI API ${res.status}: ${msg}`);
      }

      const blob = await res.blob();
      if (isStopped) return;

      reportState("playing", `Playing… ${i + 1}/${chunks.length}`, {
        chunk: i + 1, totalChunks: chunks.length, engine: "openai",
      });

      await playAudioBlob(blob, playbackSpeed, makeHighlightTracker("openai", chunks[i], null));

      while (isPaused && !isStopped) { await sleep(100); }
    } catch (err) {
      if (!isStopped) {
        reportState("stopped", `OpenAI TTS error: ${err.message}`);
      }
      return;
    }
  }

  if (!isStopped) {
    reportState("stopped", "Finished ✓");
  }
}

// ─── ElevenLabs TTS ───────────────────────────────────────────────────────────

async function speakWithElevenLabs(text, voice, speed, apiKey, startChunk = 0) {
  const effectiveKey   = (apiKey && apiKey.trim()) || DEFAULT_ELEVENLABS_KEY;
  const effectiveVoice = voice || "21m00Tcm4TlvDq8ikWAM"; // Rachel
  const chunks         = buildEngineChunks(text, "elevenlabs"); // single source (issue #15)
  const startAt        = clampStartIndex(startChunk, chunks.length);

  if (!effectiveKey) {
    reportState("stopped", "ElevenLabs API key required — add it in Settings");
    return;
  }

  for (let i = startAt; i < chunks.length; i++) {
    if (isStopped) return;
    while (isPaused && !isStopped) { await sleep(100); }
    if (isStopped) return;

    reportState("playing", `Fetching audio… ${i + 1}/${chunks.length}`, {
      chunk: i + 1, totalChunks: chunks.length, engine: "elevenlabs",
    });
    reportHighlight("elevenlabs", chunks[i], 0, 0);

    try {
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${effectiveVoice}`,
        {
          method:  "POST",
          headers: {
            Accept:           "audio/mpeg",
            "Content-Type":   "application/json",
            "xi-api-key":     effectiveKey,
          },
          body: JSON.stringify({
            text:           chunks[i].text,
            model_id:       "eleven_monolingual_v1",
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
          }),
        }
      );

      if (!res.ok) {
        const msg = await readResponseError(res);
        throw new Error(`ElevenLabs API ${res.status}: ${msg}`);
      }

      const blob = await res.blob();
      if (isStopped) return;

      reportState("playing", `Playing… ${i + 1}/${chunks.length}`, {
        chunk: i + 1, totalChunks: chunks.length, engine: "elevenlabs",
      });

      await playAudioBlob(blob, playbackSpeed, makeHighlightTracker("elevenlabs", chunks[i], null));

      while (isPaused && !isStopped) { await sleep(100); }
    } catch (err) {
      if (!isStopped) {
        reportState("stopped", `ElevenLabs error: ${err.message}`);
      }
      return;
    }
  }

  if (!isStopped) {
    reportState("stopped", "Finished ✓");
  }
}

// ─── Browser Local TTS ────────────────────────────────────────────────────────

// sentenceBase: the GLOBAL sentence index of the first sentence in `text`
// (non-zero only when this is the network-unavailable fallback inside
// speakWithEdgeTTS, where playback resumes mid-article). Sentence-level
// highlight is exact (one utterance = one sentence); word-level uses
// utterance.onboundary where the platform fires it.
let localPlaybackId = 0;

function localVoicesReady() {
  const voices = speechSynthesis.getVoices();
  if (voices.length) return Promise.resolve(voices);
  return new Promise((resolve) => {
    const ready = () => {
      const loaded = speechSynthesis.getVoices();
      if (loaded.length) finish(loaded);
    };
    const finish = (loaded) => {
      clearTimeout(timer);
      speechSynthesis.removeEventListener("voiceschanged", ready);
      resolve(loaded);
    };
    const timer = setTimeout(() => finish(speechSynthesis.getVoices()), 2000);
    speechSynthesis.addEventListener("voiceschanged", ready);
    ready();
  });
}

async function speakWithLocalTTS(text, voiceName, speed, startChunk = 0, sentenceBase = 0) {
  if (typeof speechSynthesis === "undefined") {
    reportState("stopped", "Speech synthesis unavailable");
    return;
  }

  speechSynthesis.cancel();
  playbackSpeed = Number(speed) || playbackSpeed;
  if (localHighlightTimer) clearInterval(localHighlightTimer);
  localHighlightTimer = null;
  const playbackId = ++localPlaybackId;
  const voices = await localVoicesReady();
  if (isStopped || playbackId !== localPlaybackId) return;
  const selectedVoice = voices.find((v) => v.name === voiceName) ||
    voices.find((v) => v.default) || voices[0] || null;

  const sentences = splitIntoSentences(text);
  const startAt   = clampStartIndex(startChunk, sentences.length);
  let   index     = startAt;

  reportState("playing", "Reading…", {
    chunk: Math.min(startAt + 1, Math.max(1, sentences.length)),
    totalChunks: sentences.length, engine: "local",
  });

  function speakNext() {
    if (isStopped) return;
    if (index >= sentences.length) {
      reportState("stopped", "Finished ✓");
      return;
    }

    const sentenceIndex = index;
    const utterance  = new SpeechSynthesisUtterance(sentences[sentenceIndex]);
    utterance.rate   = playbackSpeed;

    if (selectedVoice) utterance.voice = selectedVoice;

    reportHighlight("local", { sentenceStart: sentenceBase }, sentenceIndex, 0);

    let elapsedMs = 0;
    let lastTick = 0;
    let lastBoundaryAt = 0;
    let timer = null;
    utterance.onstart = () => {
      lastTick = Date.now();
      lastBoundaryAt = lastTick;
      const sentence = sentences[sentenceIndex];
      const estimatedMs = Math.max(600, countWords(sentence) * 350 / utterance.rate);
      timer = setInterval(() => {
        const now = Date.now();
        if (isStopped || playbackId !== localPlaybackId || sentenceIndex !== index) {
          clearInterval(timer);
          if (localHighlightTimer === timer) localHighlightTimer = null;
          return;
        }
        if (!isPaused) elapsedMs += now - lastTick;
        lastTick = now;
        if (isPaused || now - lastBoundaryAt < Math.max(350, 700 / utterance.rate)) return;
        const fraction = Math.min(0.99, elapsedMs / estimatedMs);
        reportHighlight("local", { sentenceStart: sentenceBase }, sentenceIndex,
          wordOrdinalFromFraction(sentence, fraction));
      }, 100);
      localHighlightTimer = timer;
    };

    utterance.onboundary = (e) => {
      if (isStopped || playbackId !== localPlaybackId || sentenceIndex !== index) return;
      if (e.name && e.name !== "word") return;
      if (typeof e.charIndex !== "number") return;
      // charIndex is into the RAW sentence string (original whitespace
      // runs). Counting on the raw text is correct by construction; the
      // normalized-position path shifts forward past multi-whitespace and
      // the highlight runs ahead of the audio (issue #15).
      const ordinal = wordOrdinalAtRawChar(sentences[sentenceIndex], e.charIndex);
      lastBoundaryAt = Date.now();
      reportHighlight("local", { sentenceStart: sentenceBase }, sentenceIndex, ordinal);
    };

    utterance.onend = () => {
      if (timer) clearInterval(timer);
      if (localHighlightTimer === timer) localHighlightTimer = null;
      if (isStopped || playbackId !== localPlaybackId || sentenceIndex !== index) return;
      index++;
      if (!isStopped) {
        reportState("playing", `Reading…`, {
          chunk: Math.min(index + 1, sentences.length),
          totalChunks: sentences.length,
          engine: "local",
        });
        speakNext();
      }
    };

    utterance.onerror = (e) => {
      if (timer) clearInterval(timer);
      if (localHighlightTimer === timer) localHighlightTimer = null;
      if (!isStopped && e.error !== "interrupted") {
        reportState("stopped", `Speech error: ${e.error}`);
      }
    };

    speechSynthesis.speak(utterance);
  }

  speakNext();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function speakWithKokoro(text, voice, speedRate, startChunk = 0) {
  const effectiveVoice = voice || "af_heart"; // default Kokoro voice
  // Sentence-level chunks (issue #15): Kokoro audio has no word metadata,
  // so the tracker estimates the word from the audio fraction — per-
  // sentence chunks keep the estimate inside the sentence actually playing.
  const chunks = buildEngineChunks(text, "kokoro");
  const startAt = clampStartIndex(startChunk, chunks.length);

  // Empty text: nothing to synthesize — same finish contract as every
  // other engine (and no probe).
  if (chunks.length === 0) {
    reportState("stopped", "Finished ✓");
    return;
  }

  // Pre-playback probe (issue #7): fail fast with a clear fallback when
  // the server is down, instead of making the operator wait out the
  // 60s TTS timeout to learn the same thing.
  const probe = await probeKokoroServer();
  if (isStopped) return;
  if (!probe.reachable && shouldFallbackToBrowserLocal(probe.failure)) {
    fallbackFromChunk(startAt, probe.failure);
    return;
  }
  if (!probe.reachable) {
    reportState("stopped", `Kokoro server at ${KOKORO_BASE_URL} is misbehaving (${probe.failure})`);
    return;
  }

  for (let i = startAt; i < chunks.length; i++) {
    if (isStopped) return;
    while (isPaused && !isStopped) { await sleep(100); }
    if (isStopped) return;

    reportState("playing", `Fetching Kokoro audio… ${i + 1}/${chunks.length}`, {
      chunk: i + 1, totalChunks: chunks.length, engine: "kokoro",
    });
    reportHighlight("kokoro", chunks[i], 0, 0);

    try {
      const res = await fetchWithTimeout(`${KOKORO_BASE_URL}/v1/text-to-speech/${effectiveVoice}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: chunks[i].text, speed: 1 }),
      }, KOKORO_REQUEST_TIMEOUT_MS);

      if (!res.ok) {
        throw new Error(`Kokoro API ${res.status}: ${res.statusText}`);
      }

      const blob = await res.blob();
      if (isStopped) return;

      reportState("playing", `Playing… ${i + 1}/${chunks.length}`, {
        chunk: i + 1, totalChunks: chunks.length, engine: "kokoro",
      });

      await playAudioBlob(blob, playbackSpeed, makeHighlightTracker("kokoro", chunks[i], null));
      if (isStopped) return;
    } catch (err) {
      if (isStopped) return;

      // Server died mid-playback (or first request after a racing
      // shutdown): same contract as Edge TTS's network fallback — resume
      // Browser Local playback from the failing chunk's first sentence
      // with a non-blocking notice. HTTP-level errors stay honest errors.
      const failure = classifyKokoroFailure(err);
      if (shouldFallbackToBrowserLocal(failure)) {
        if (i === startAt) fallbackFromChunk(i, failure);
        else reportState("stopped", "Kokoro connection lost. Press play to retry.");
        return;
      }

      const message = err?.message && /timed out/i.test(err.message)
          ? `Kokoro request timed out after ${Math.round(KOKORO_REQUEST_TIMEOUT_MS / 1000)}s`
        : `Kokoro error: ${err.message}`;
      reportState("stopped", message);
      return;
    }
  }

  if (!isStopped) {
    reportState("stopped", "Finished ✓");
  }

  // Browser-Local fallback: plays the remaining Kokoro chunks' text,
  // sentence-anchored so word highlighting stays at the right page
  // offsets (sentenceBase = global index of the first sentence in the
  // slice). Mirrors the Edge TTS fallback contract.
  async function fallbackFromChunk(i, failure) {
    reportState("playing", kokoroFallbackNotice(failure), {
      chunk: i + 1, totalChunks: chunks.length, engine: "local", fallback: true,
    });
    speakWithLocalTTS(
      chunks.slice(i).map((c) => c.text).join(" "),
      null, speedRate, 0, chunks[i].sentenceStart
    );
  }
}

// Liveness probe: any HTTP response (even a 404 from an older server
// without /v1/voices) means the process is alive — only connection
// errors and probe timeouts count as unreachable. The voice list is
// parsed best-effort; playback never depends on it.
async function probeKokoroServer() {
  try {
    const res = await fetchWithTimeout(kokoroVoicesUrl(), { method: "GET" }, KOKORO_PROBE_TIMEOUT_MS);
    let voices = null;
    try { voices = parseKokoroVoices(await res.text()); } catch (_) { /* best-effort */ }
    return { reachable: true, voices };
  } catch (err) {
    return { reachable: false, failure: classifyKokoroFailure(err) };
  }
}
