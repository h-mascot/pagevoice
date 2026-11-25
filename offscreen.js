/**
 * offscreen.js — PageVoice Offscreen Document (v2)
 *
 * Handles ALL audio playback:
 *   - Edge TTS  (free, StreamElements fetch + Bing fallback, default)
 *   - OpenAI TTS (API key, REST)
 *   - ElevenLabs  (API key, REST)
 *   - Browser Local TTS (SpeechSynthesis)
 *
 * Lives as a persistent hidden HTML page so audio continues when popup closes.
 * Communicates exclusively with background.js via chrome.runtime.sendMessage.
 */

const DEFAULT_ELEVENLABS_KEY = "";
const KOKORO_BASE_URL = "http://127.0.0.1:8881";
const KOKORO_REQUEST_TIMEOUT_MS = 60000;

// ─── Playback state ───────────────────────────────────────────────────────────

let currentAudio    = null;
let isStopped       = false;
let isPaused        = false;
let currentState    = "stopped";
let currentStatus   = "";

// ─── Message Router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== "offscreen") return false;

  (async () => {
    switch (message.type) {

      case "play": {
        isStopped = false;
        isPaused  = false;
        resetHighlight(); // a fresh play re-emits highlight events from the top
        const { text, engine, voice, speed, apiKey } = message.payload;
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
        if (currentAudio) { currentAudio.pause(); currentAudio = null; }
        if (typeof speechSynthesis !== "undefined") { speechSynthesis.cancel(); }
        sendResponse({ ok: true });
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
function makeHighlightTracker(engine, chunk, wordEvents) {
  const sentences = splitIntoSentences(chunk.text);
  return (mediaTimeSec, durationSec) => {
    if (isStopped) return;
    let ordinal;
    if (Array.isArray(wordEvents) && wordEvents.length > 0) {
      ordinal = wordOrdinalAtMediaTime(wordEvents, mediaTimeSec);
    } else if (Number.isFinite(durationSec) && durationSec > 0) {
      const fraction = Math.min(1, Math.max(0, mediaTimeSec / durationSec));
      ordinal = wordOrdinalFromFraction(chunk.text, fraction);
    } else {
      return; // duration not known yet — wait for the next timeupdate
    }
    const sw = wordOrdinalToSentenceWord(sentences, ordinal);
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
  const spd    = speed || 1.0;
  const chunks = buildTextChunks(text, 900); // Edge TTS works best with ~800-1000 char chunks
  const startAt = clampStartIndex(startChunk, chunks.length);

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
      const { blob, wordEvents } = await edgeTTSChunkViaBing(voice, chunks[i].text, spd);
      if (isStopped) return;
      reportState("playing", `Playing… ${i + 1}/${chunks.length}`, {
        chunk: i + 1, totalChunks: chunks.length, engine: "edge",
      });
      await playAudioBlob(blob, 1.0, makeHighlightTracker("edge", chunks[i], wordEvents));
      while (isPaused && !isStopped) { await sleep(100); }
    } catch (bingErr) {
      try {
        // Fallback: Google Translate TTS (free, no auth) — no word metadata,
        // so highlighting falls back to proportional estimation.
        const blob = await edgeTTSChunkViaGoogle(voice, chunks[i].text);
        if (isStopped) return;
        await playAudioBlob(blob, spd, makeHighlightTracker("edge", chunks[i], null));
        while (isPaused && !isStopped) { await sleep(100); }
      } catch (googleErr) {
        // Last resort: Browser Local TTS
        if (!isStopped) {
          reportState("playing", "Network TTS unavailable, using Browser TTS…", {
            chunk: i + 1,
            totalChunks: chunks.length,
            engine: "local",
          });
          speakWithLocalTTS(
            chunks.slice(i).map((c) => c.text).join(" "),
            null, spd, 0, chunks[i].sentenceStart
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
  const chunks         = buildTextChunks(text, 4000);
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
          speed: clampAudioRate(speed),
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

      await playAudioBlob(blob, 1.0, makeHighlightTracker("openai", chunks[i], null));

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
  const chunks         = buildTextChunks(text, 2500);
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

      await playAudioBlob(blob, speed || 1.0, makeHighlightTracker("elevenlabs", chunks[i], null));

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
function speakWithLocalTTS(text, voiceName, speed, startChunk = 0, sentenceBase = 0) {
  if (typeof speechSynthesis === "undefined") {
    reportState("stopped", "Speech synthesis unavailable");
    return;
  }

  speechSynthesis.cancel();

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

    const utterance  = new SpeechSynthesisUtterance(sentences[index]);
    utterance.rate   = speed || 1.0;

    if (voiceName) {
      const voices = speechSynthesis.getVoices();
      const match  = voices.find((v) => v.name === voiceName);
      if (match) utterance.voice = match;
    }

    reportHighlight("local", { sentenceStart: sentenceBase }, index, 0);

    utterance.onboundary = (e) => {
      if (isStopped) return;
      if (e.name && e.name !== "word") return;
      if (typeof e.charIndex !== "number") return;
      const ordinal = wordOrdinalAtChar(sentences[index], e.charIndex);
      reportHighlight("local", { sentenceStart: sentenceBase }, index, ordinal);
    };

    utterance.onend = () => {
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
  const chunks = buildTextChunks(text, 2500); // 2500 chars per chunk is fine
  const safeSpeed = clampKokoroSpeed(speedRate);
  const startAt = clampStartIndex(startChunk, chunks.length);

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
        body: JSON.stringify({ text: chunks[i].text, speed: safeSpeed }),
      }, KOKORO_REQUEST_TIMEOUT_MS);

      if (!res.ok) {
        throw new Error(`Kokoro API ${res.status}: ${res.statusText}`);
      }

      const blob = await res.blob();
      if (isStopped) return;

      reportState("playing", `Playing… ${i + 1}/${chunks.length}`, {
        chunk: i + 1, totalChunks: chunks.length, engine: "kokoro",
      });

      await playAudioBlob(blob, speedRate, makeHighlightTracker("kokoro", chunks[i], null));
      if (isStopped) return;
    } catch (err) {
      if (isStopped) return;
      const message = err?.message && /Failed to fetch/i.test(err.message)
        ? `Kokoro server unavailable at ${KOKORO_BASE_URL} — start kokoro_server.py first`
        : err?.message && /timed out/i.test(err.message)
          ? `Kokoro request timed out after ${Math.round(KOKORO_REQUEST_TIMEOUT_MS / 1000)}s`
        : `Kokoro error: ${err.message}`;
      reportState("stopped", message);
      return;
    }
  }

  if (!isStopped) {
    reportState("stopped", "Finished");
  }
}
