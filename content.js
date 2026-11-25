/**
 * content.js — PageVoice Content Script (v2)
 *
 * Responsibilities:
 *  1. Extract article text and page title on request.
 *  2. Inject / update / remove the floating mini-player.
 *
 * Wrapped in IIFE to prevent redeclaration errors when injected
 * both via manifest content_scripts and chrome.scripting.executeScript.
 */

if (!window.__pagevoice_loaded__) {
window.__pagevoice_loaded__ = true;

// ─── Article Extraction ───────────────────────────────────────────────────────

// Returns { text, title, elements }: `elements` are the DOM nodes the text
// was extracted from (paragraph list, matched container, or body) — the
// word-highlighting pass (issue #4) walks exactly these so its sentence
// segmentation matches what the TTS engines read.
function extractArticleData() {
  const paragraphPairs = Array.from(document.querySelectorAll("p"))
    .map((p) => ({ el: p, text: p.innerText.trim() }))
    .filter(({ text }) => text.length > 30);

  const paragraphs = paragraphPairs.map(({ text }) => text);
  let text = null;
  let elements = [];

  if (paragraphs.length >= 3) {
    text = paragraphs.join("\n\n");
    elements = paragraphPairs.map(({ el }) => el);
  } else {
    const selectors = [
      "article",
      '[role="article"]',
      ".article-content",
      ".post-content",
      ".entry-content",
      ".post-body",
      ".content-body",
      "main",
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        const t = el.innerText.trim();
        if (t.length > 200) { text = t; elements = [el]; break; }
      }
    }

    if (!text) {
      const body = document.body.innerText;
      if (body.length > 200) {
        text = body.substring(0, 50000);
        elements = [document.body];
      }
    }
  }

  let title = "";
  const ogTitle = document.querySelector('meta[property="og:title"]');
  if (ogTitle) {
    title = ogTitle.content.trim();
  } else {
    const h1 = document.querySelector("article h1, main h1, h1");
    title = h1 ? h1.innerText.trim() : document.title.trim();
  }

  return { text, title, elements };
}

// ─── Message Listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getArticleData") {
    const data = extractArticleData();
    sendResponse(data);
    return true;
  }

  if (request.action === "getArticleText") {
    const { text } = extractArticleData();
    sendResponse({ text });
    return true;
  }

  if (request.target === "content" && request.type === "playerUpdate") {
    handlePlayerUpdate(request.payload);
    return true;
  }

  if (request.target === "content" && request.type === "highlightUpdate") {
    applyHighlight(request.payload);
    return true;
  }
});

// Turning highlighting off mid-playback clears it immediately (opt-out).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !changes.highlightEnabled) return;
  if (!changes.highlightEnabled.newValue) clearHighlight();
});

// ─── Word Highlighting (issue #4) ────────────────────────────────────────────
//
// Sentences of the page are wrapped in <span class="pv-s" data-pv-si="N">
// at TEXT-NODE granularity — text nodes are split with splitText() and the
// fragment is wrapped in a span; no element is ever restructured, so page
// layout is untouched. N is the GLOBAL sentence index (the same
// splitIntoSentences stream the TTS engines chunk), which is what makes
// offscreen's highlight events land on the right sentence.
//
// The active sentence additionally re-wraps its text into
// <span class="pv-w" data-pv-wi="M"> word spans; the original text is kept
// on the fragment span (dataset.pvText) and restored on deactivation.

let highlight = null;         // { spansBySentence, activeSentence, activeWord, wordSpans }
let highlightPending = null;  // last highlightUpdate awaiting setup

const PV_HIGHLIGHT_BLOCK_SELECTOR =
  "p,div,li,section,article,aside,blockquote,h1,h2,h3,h4,h5,h6,td,th,pre,dt,dd,figcaption";

async function setupHighlight() {
  if (highlight) return; // already active for this page
  // Guard: pure modules must be loaded (they precede content.js in the
  // manifest content_scripts list; older programmatic injections without
  // them simply skip highlighting).
  if (typeof splitIntoSentences !== "function" ||
      typeof normalizeWhitespace !== "function" ||
      typeof alignCharStreams !== "function" ||
      typeof sentenceStartOffsets !== "function" ||
      typeof sentenceIndexAtOffset !== "function") {
    return;
  }

  try {
    const settings = await chrome.storage.sync.get(["highlightEnabled"]).catch(() => ({}));
    if (!settings || !settings.highlightEnabled) return; // opt-in, off by default

    const data = extractArticleData();
    if (!data || !data.text || !Array.isArray(data.elements) || data.elements.length === 0) return;

    const session = buildHighlightSession(data.text, data.elements);
    if (!session) return;
    highlight = session;

    if (highlightPending) {
      const pending = highlightPending;
      highlightPending = null;
      applyHighlight(pending);
    }
  } catch (_) { /* highlighting must never break playback */ }
}

// Build the walk text (normalized concatenation of the extracted elements'
// text nodes) with a per-char → { node, offset } map, then align it against
// the extracted text and wrap each walk-sentence fragment in spans tagged
// with its global sentence index.
function buildHighlightSession(text, elements) {
  const sentences = splitIntoSentences(text);
  if (sentences.length === 0) return null;
  const source = normalizeWhitespace(text);
  if (!source) return null;

  const nodes = collectHighlightNodes(elements);
  if (nodes.length === 0) return null;
  const walk = buildWalkMap(nodes);
  if (walk.text.length < 10) return null;

  const alignment = alignCharStreams(source, walk.text);
  const spansBySentence = new Map();
  const starts = sentenceStartOffsets(sentences);

  // Char ranges of walk sentences within walk.text (walk.text is the
  // normalized stream, so sentences joined with " " reproduce it exactly).
  const ranges = [];
  let pos = 0;
  for (const s of splitIntoSentences(walk.text)) {
    const start = pos === 0 ? 0 : pos + 1;
    ranges.push([start, start + s.length]);
    pos = start + s.length;
  }

  for (const [start, end] of ranges) {
    if (start >= end) continue;
    const srcPos = alignment[start] >= 0
      ? alignment[start]
      : nearestAlignedBefore(alignment, start);
    if (srcPos < 0) continue;
    const si = sentenceIndexAtOffset(starts, srcPos);
    if (si < 0) continue;
    wrapWalkRange(walk, start, end, si, spansBySentence);
  }

  return { spansBySentence, activeSentence: -1, activeWord: -1, wordSpans: [] };
}

function nearestAlignedBefore(alignment, idx) {
  for (let k = idx; k >= 0; k--) {
    if (alignment[k] >= 0) return alignment[k];
  }
  return -1;
}

// Visible text nodes under the extraction roots, in document order.
function collectHighlightNodes(elements) {
  const nodes = [];
  const seen = new Set();

  for (const root of elements) {
    if (!root) continue;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest("#__pagevoice_player__")) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEMPLATE" ||
            tag === "NOSCRIPT" || tag === "TEXTAREA") {
          return NodeFilter.FILTER_REJECT;
        }
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let node;
    while ((node = walker.nextNode())) {
      if (!seen.has(node)) {
        seen.add(node);
        nodes.push(node);
      }
    }
  }

  return nodes;
}

// Normalized walk text + per-char map. A separator is inserted between text
// nodes whose closest block-level ancestors differ (paragraph and inline
// element boundaries); whitespace runs collapse to a single space.
function buildWalkMap(nodes) {
  let text = "";
  const map = [];
  let prevBlock = null;

  const emit = (ch, node, offset) => {
    map.push({ node, offset });
    text += ch;
  };

  for (const node of nodes) {
    const parent = node.parentElement;
    const blockKey = parent
      ? (parent.closest(PV_HIGHLIGHT_BLOCK_SELECTOR) || parent)
      : null;

    if (prevBlock && blockKey && blockKey !== prevBlock &&
        !/\s/.test(text.slice(-1))) {
      emit(" ", null, -1);
    }
    prevBlock = blockKey;

    const value = node.nodeValue;
    let inSpace = /\s/.test(text.slice(-1));
    for (let k = 0; k < value.length; k++) {
      const ch = value[k];
      if (/\s/.test(ch)) {
        if (!inSpace) { emit(" ", node, k); inSpace = true; }
      } else {
        emit(ch, node, k);
        inSpace = false;
      }
    }
  }

  // Trim leading separators.
  while (text.length > 0 && text[0] === " ") {
    text = text.slice(1);
    map.shift();
  }

  return { text, map };
}

// Wrap walk-text chars [start, end) in sentence spans tagged with si.
// Groups consecutive chars by text node and splits each node with
// splitText() — layout-safe by construction.
function wrapWalkRange(walk, start, end, si, spansBySentence) {
  const groups = [];
  for (let k = start; k < end; k++) {
    const entry = walk.map[k];
    if (!entry || !entry.node) continue; // separator chars
    const last = groups[groups.length - 1];
    if (last && last.node === entry.node && entry.offset === last.offset + last.len) {
      last.len += 1;
    } else {
      groups.push({ node: entry.node, offset: entry.offset, len: 1 });
    }
  }

  // Per original node: the node currently holding its remaining text and
  // how many original chars were already split off.
  const cursors = new Map();
  const wrapped = [];

  for (const g of groups) {
    try {
      let cursor = cursors.get(g.node);
      if (!cursor) {
        cursor = { node: g.node, base: 0 };
        cursors.set(g.node, cursor);
      }

      const localOffset = g.offset - cursor.base;
      const tail = cursor.node.splitText(localOffset);
      const rest = tail.splitText(g.len);

      const span = document.createElement("span");
      span.className = "pv-s";
      span.dataset.pvSi = String(si);
      const parent = tail.parentNode;
      if (!parent) continue;
      parent.insertBefore(span, tail);
      span.appendChild(tail);

      cursor.node = rest;
      cursor.base = g.offset + g.len;
      wrapped.push(span);
    } catch (_) { /* layout-safe: skip fragment on error */ }
  }

  if (wrapped.length > 0) {
    const list = spansBySentence.get(si) || [];
    list.push(...wrapped);
    spansBySentence.set(si, list);
  }
}

// ─── Highlight application ────────────────────────────────────────────────────

function applyHighlight(payload) {
  if (!highlight) {
    highlightPending = payload || null;
    return;
  }
  if (!payload || typeof payload.sentence !== "number") return;

  const si = payload.sentence;
  const wi = Math.max(0, Math.floor(payload.word || 0));

  if (si === highlight.activeSentence && wi === highlight.activeWord) return;

  if (si !== highlight.activeSentence) {
    deactivateSentence(highlight);
    activateSentence(highlight, si);
  }
  if (highlight.activeSentence === si) {
    setWordHighlight(highlight, wi);
  }
}

function activateSentence(h, si) {
  const spans = h.spansBySentence.get(si);

  if (!spans || spans.length === 0) {
    h.activeSentence = si;
    h.activeWord = -1;
    h.wordSpans = [];
    return;
  }

  // Re-wrap the sentence's fragments into word spans (word index counted
  // across the whole sentence, matching offscreen's word ordinal).
  const wordSpans = [];
  for (const span of spans) {
    const original = span.textContent;
    span.dataset.pvText = original;
    span.textContent = "";
    for (const part of original.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        span.appendChild(document.createTextNode(part));
        continue;
      }
      const w = document.createElement("span");
      w.className = "pv-w";
      w.dataset.pvWi = String(wordSpans.length);
      w.textContent = part;
      span.appendChild(w);
      wordSpans.push(w);
    }
    span.classList.add("pv-active");
  }

  h.activeSentence = si;
  h.activeWord = -1;
  h.wordSpans = wordSpans;
  scrollSentenceIntoView(spans);
}

function deactivateSentence(h) {
  if (h.activeSentence < 0) return;
  const spans = h.spansBySentence.get(h.activeSentence) || [];
  for (const span of spans) {
    span.classList.remove("pv-active");
    if (span.dataset.pvText !== undefined) {
      span.textContent = span.dataset.pvText;
      delete span.dataset.pvText;
    }
  }
  h.activeSentence = -1;
  h.activeWord = -1;
  h.wordSpans = [];
}

function setWordHighlight(h, wi) {
  if (!h.wordSpans || h.wordSpans.length === 0) return;
  const idx = Math.min(wi, h.wordSpans.length - 1);
  if (idx === h.activeWord) return;
  if (h.activeWord >= 0 && h.wordSpans[h.activeWord]) {
    h.wordSpans[h.activeWord].classList.remove("pv-word-active");
  }
  const span = h.wordSpans[idx];
  if (span) span.classList.add("pv-word-active");
  h.activeWord = idx;
}

// Scroll margin: the sentence is brought into the comfortable reading band
// only when it is outside it (scroll-margin in content-player.css keeps the
// mini-player clear of the target).
function scrollSentenceIntoView(spans) {
  const first = spans[0];
  if (!first || typeof first.getBoundingClientRect !== "function") return;
  const rect = first.getBoundingClientRect();
  const vh = window.innerHeight || 800;
  if (rect.top < vh * 0.15 || rect.bottom > vh * 0.85) {
    try { first.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (_) {}
  }
}

// Full teardown: deactivate, then unwrap every sentence span so the DOM
// returns to its pre-highlight shape.
function clearHighlight() {
  highlightPending = null;
  if (!highlight) return;

  deactivateSentence(highlight);

  const all = new Set();
  highlight.spansBySentence.forEach((list) => list.forEach((s) => all.add(s)));
  for (const span of all) {
    const parent = span.parentNode;
    if (!parent) continue;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
  }

  highlight = null;
}

// ─── Floating Mini-Player ─────────────────────────────────────────────────────

let playerEl      = null;
let isDragging    = false;
let dragOffsetX   = 0;
let dragOffsetY   = 0;
let playerVisible = false;

const PLAYER_ID = "__pagevoice_player__";

function handlePlayerUpdate({ state, chunk, totalChunks }) {
  if (state === "stopped") {
    removePlayer();
    clearHighlight();
    return;
  }
  if (!playerVisible) {
    injectPlayer();
  }
  if (state === "playing" && !highlight) {
    setupHighlight(); // fire-and-forget; events buffer until the session is ready
  }
  updatePlayer(state, chunk, totalChunks);
}

function injectPlayer() {
  if (document.getElementById(PLAYER_ID)) {
    playerEl      = document.getElementById(PLAYER_ID);
    playerVisible = true;
    return;
  }

  playerEl = document.createElement("div");
  playerEl.id = PLAYER_ID;
  playerEl.innerHTML = `
    <div class="pv-drag-handle" title="Drag to move"></div>
    <div class="pv-body">
      <div class="pv-progress"></div>
      <div class="pv-controls">
        <button class="pv-btn pv-play" title="Play/Pause">▶</button>
        <button class="pv-btn pv-stop" title="Stop">⏹</button>
        <button class="pv-btn pv-queue" title="Save to queue">＋</button>
        <button class="pv-btn pv-close" title="Close">✕</button>
      </div>
    </div>
  `;

  document.body.appendChild(playerEl);
  playerVisible = true;

  playerEl.querySelector(".pv-stop").addEventListener("click", (e) => {
    e.stopPropagation();
    chrome.runtime.sendMessage({ target: "background", type: "stop" });
    removePlayer();
  });

  playerEl.querySelector(".pv-queue").addEventListener("click", (e) => {
    e.stopPropagation();
    const btn = playerEl.querySelector(".pv-queue");
    btn.textContent = "…";
    chrome.runtime.sendMessage({ target: "background", type: "queueAddCurrent" }, (res) => {
      if (chrome.runtime.lastError) { resetQueueBtn(btn); return; }
      if (res?.ok) {
        btn.textContent = "✓";
        btn.title = "Saved to queue";
      } else {
        btn.textContent = "✕";
        btn.title = res?.error || "Could not save";
      }
      setTimeout(() => resetQueueBtn(btn), 2000);
    });
  });

  playerEl.querySelector(".pv-close").addEventListener("click", (e) => {
    e.stopPropagation();
    removePlayer();
  });

  playerEl.addEventListener("mousedown", onDragStart);
  document.addEventListener("mousemove", onDragMove);
  document.addEventListener("mouseup",   onDragEnd);
}

function updatePlayer(state, chunk, totalChunks) {
  if (!playerEl) return;

  const playBtn    = playerEl.querySelector(".pv-play");
  const progressEl = playerEl.querySelector(".pv-progress");

  if (state === "paused") {
    playBtn.textContent = "▶";
    playBtn.title       = "Resume";
    playerEl.classList.add("pv-paused");
    playerEl.classList.remove("pv-playing");
    playBtn.onclick = (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ target: "background", type: "resume" });
    };
  } else {
    playBtn.textContent = "⏸";
    playBtn.title       = "Pause";
    playerEl.classList.add("pv-playing");
    playerEl.classList.remove("pv-paused");
    playBtn.onclick = (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ target: "background", type: "pause" });
    };
  }

  if (totalChunks > 1) {
    progressEl.textContent = `${chunk} / ${totalChunks}`;
  } else {
    progressEl.textContent = state === "playing" ? "▶ Reading…" : "⏸ Paused";
  }
}

function removePlayer() {
  if (playerEl) {
    document.removeEventListener("mousemove", onDragMove);
    document.removeEventListener("mouseup",   onDragEnd);
    playerEl.remove();
    playerEl      = null;
    playerVisible = false;
  }
}

function resetQueueBtn(btn) {
  if (!btn) return;
  btn.textContent = "＋";
  btn.title = "Save to queue";
}

// ─── Drag Logic ───────────────────────────────────────────────────────────────

function onDragStart(e) {
  if (e.target.classList.contains("pv-btn")) return;
  isDragging  = true;
  const rect  = playerEl.getBoundingClientRect();
  dragOffsetX = e.clientX - rect.left;
  dragOffsetY = e.clientY - rect.top;
  playerEl.style.transition = "none";
  e.preventDefault();
}

function onDragMove(e) {
  if (!isDragging || !playerEl) return;
  const x = e.clientX - dragOffsetX;
  const y = e.clientY - dragOffsetY;

  const maxX = window.innerWidth  - playerEl.offsetWidth;
  const maxY = window.innerHeight - playerEl.offsetHeight;

  playerEl.style.left   = Math.max(0, Math.min(x, maxX)) + "px";
  playerEl.style.top    = Math.max(0, Math.min(y, maxY)) + "px";
  playerEl.style.right  = "auto";
  playerEl.style.bottom = "auto";
}

function onDragEnd() {
  isDragging = false;
  if (playerEl) playerEl.style.transition = "";
}

console.log("PageVoice content script loaded");

} // end guard
