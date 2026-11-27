const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { splitIntoSentences } = require("./lib/pv-utils.js");
const { countWords, wordOrdinalFromFraction } = require("./lib/pv-highlight.js");

test("Browser TTS waits for voices and keeps the selected voice across sentences", async () => {
  const spoken = [];
  const messages = [];
  const listeners = new Map();
  let voices = [];
  const selected = { name: "Chosen voice" };
  const synthesis = {
    cancel() {},
    getVoices: () => voices,
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: (name) => listeners.delete(name),
    speak: (utterance) => spoken.push(utterance),
  };
  const context = {
    window: {},
    document: {},
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async (message) => {
      messages.push(message);
      return {};
    } } },
    speechSynthesis: synthesis,
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    splitIntoSentences,
    clampStartIndex: (index) => index,
    wordOrdinalAtRawChar: () => 0,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve("./offscreen.js"), "utf8"), context);

  const playback = context.speakWithLocalTTS("One sentence. Two sentences.", selected.name, 1);
  assert.equal(spoken.length, 0);
  voices = [selected, { name: "Other voice" }];
  listeners.get("voiceschanged")();
  await playback;
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].voice, selected);
  spoken[0].onend();
  assert.equal(spoken.length, 2);
  assert.equal(spoken[1].voice, selected);
  const sentBeforeLateEvent = messages.length;
  spoken[0].onboundary({ name: "word", charIndex: 4 });
  spoken[0].onend();
  assert.equal(messages.length, sentBeforeLateEvent);
  assert.equal(spoken.length, 2);
});

test("Edge TTS keeps the first working provider for later chunks", async () => {
  const context = {
    window: {}, document: {},
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async () => ({}) } },
    buildEngineChunks: () => [
      { text: "First.", sentenceStart: 0 },
      { text: "Second.", sentenceStart: 1 },
    ],
    clampStartIndex: (index) => index,
    splitIntoSentences,
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve("./offscreen.js"), "utf8"), context);
  let bingCalls = 0;
  let googleCalls = 0;
  context.edgeTTSChunkViaBing = async () => { bingCalls++; throw new Error("Bing unavailable"); };
  context.edgeTTSChunkViaGoogle = async () => { googleCalls++; return {}; };
  context.playAudioBlob = async () => {};
  context.makeHighlightTracker = () => () => {};

  await context.speakWithEdgeTTS("First. Second.", "voice", 1);
  assert.equal(bingCalls, 1);
  assert.equal(googleCalls, 2);
});

test("Kokoro reports a later connection loss without changing voices", async () => {
  const states = [];
  const context = {
    window: {}, document: {},
    chrome: { runtime: {
      onMessage: { addListener() {} },
      sendMessage: async (message) => { states.push(message); return {}; },
    } },
    buildEngineChunks: () => [
      { text: "First.", sentenceStart: 0 },
      { text: "Second.", sentenceStart: 1 },
    ],
    clampStartIndex: (index) => index,
    clampKokoroSpeed: (speed) => speed,
    KOKORO_BASE_URL: "http://127.0.0.1:8881",
    classifyKokoroFailure: () => "unreachable",
    shouldFallbackToBrowserLocal: () => true,
    splitIntoSentences,
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve("./offscreen.js"), "utf8"), context);
  context.probeKokoroServer = async () => ({ reachable: true });
  let requests = 0;
  context.fetchWithTimeout = async () => {
    if (++requests === 2) throw new Error("connection lost");
    return { ok: true, blob: async () => ({}) };
  };
  context.playAudioBlob = async () => {};
  context.makeHighlightTracker = () => () => {};
  let browserFallbacks = 0;
  context.speakWithLocalTTS = () => { browserFallbacks++; };

  await context.speakWithKokoro("First. Second.", "af_heart", 1);
  assert.equal(requests, 2);
  assert.equal(browserFallbacks, 0);
  assert.ok(states.some((message) => message.payload?.statusText ===
    "Kokoro connection lost. Press play to retry."));
});

test("Browser TTS moves word progress without boundary events and applies speed to the next sentence", async () => {
  const messages = [];
  const spoken = [];
  let onMessage;
  let tick;
  let now = 0;
  const context = {
    window: {}, document: {},
    chrome: { runtime: {
      onMessage: { addListener: (listener) => { onMessage = listener; } },
      sendMessage: async (message) => { messages.push(message); return {}; },
    } },
    speechSynthesis: {
      cancel() {}, getVoices: () => [{ name: "Emma" }],
      speak: (utterance) => spoken.push(utterance),
    },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    splitIntoSentences,
    clampStartIndex: (index) => index,
    countWords,
    wordOrdinalFromFraction,
    Date: { now: () => now },
    setInterval: (callback) => { tick = callback; return 1; },
    clearInterval() {},
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve("./offscreen.js"), "utf8"), context);
  await context.speakWithLocalTTS("First sentence has several words to read. Second sentence follows.", "Emma", 1);
  spoken[0].onstart();
  now = 1300;
  tick();
  assert.ok(messages.some((message) => message.type === "highlightUpdate" && message.payload.word > 0));

  onMessage({ target: "offscreen", type: "setSpeed", payload: { speed: 2 } }, {}, () => {});
  await Promise.resolve();
  spoken[0].onend();
  assert.equal(spoken[1].rate, 2);
});
