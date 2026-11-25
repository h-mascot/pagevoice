/**
 * lib/pv-queue.js — PageVoice listening-queue pure logic
 *
 * Side-effect-free helpers for the persistent listening queue (issue #3):
 * schema normalisation, item construction, add/remove/reorder, resume
 * position, and next-item selection. Kept in a separate file so it can be
 * unit-tested with `node --test` (colocated pv-queue.test.js) per
 * TESTING.md — chrome.storage wiring stays in background.js.
 *
 * Storage shape (chrome.storage.local, key QUEUE_STORAGE_KEY):
 *   { schema: 1, items: [ { id, title, url, text, position, added_at } ] }
 * `position` is the 0-based chunk index to resume playback from. The schema
 * field is versioned so Phase 4 sync can migrate.
 *
 * Loading (no build step, MV3-safe): background.js importScripts()s this
 * file, so top-level declarations become globals there. The Node export
 * block at the bottom is inert in the service worker.
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const QUEUE_STORAGE_KEY = "pvQueue";
const QUEUE_SCHEMA_VERSION = 1;

// ─── Normalisation (defensive parsing of what storage hands back) ───────────

function emptyQueue() {
  return { schema: QUEUE_SCHEMA_VERSION, items: [] };
}

function normalizeQueueItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id !== "string" || !raw.id) return null;
  if (typeof raw.text !== "string" || !raw.text.trim()) return null;

  return {
    id:       raw.id,
    title:    (typeof raw.title === "string" && raw.title.trim()) || "Untitled",
    url:      typeof raw.url === "string" ? raw.url : "",
    text:     raw.text,
    position: normalizePosition(raw.position),
    added_at: Number.isFinite(raw.added_at) ? raw.added_at : Date.now(),
  };
}

function normalizePosition(position) {
  if (!Number.isFinite(position) || position < 0) return 0;
  return Math.floor(position);
}

function normalizeQueue(raw) {
  if (!raw || typeof raw !== "object") return emptyQueue();
  const items = Array.isArray(raw.items)
    ? raw.items.map(normalizeQueueItem).filter(Boolean)
    : [];
  const schema = Number.isFinite(raw.schema) ? raw.schema : QUEUE_SCHEMA_VERSION;
  return { schema, items };
}

// ─── Item construction ───────────────────────────────────────────────────────

// Deterministic given opts; unique against existingIds. opts.now is the
// timestamp, opts.rand() the randomness source (both injectable for tests).
function makeQueueItemId(existingIds = [], opts = {}) {
  const now  = Number.isFinite(opts.now) ? opts.now : Date.now();
  const rand = typeof opts.rand === "function" ? opts.rand : Math.random;
  const taken = new Set(existingIds);

  let id = `q_${now.toString(36)}_${rand().toString(36).slice(2, 8)}`;
  let counter = 0;
  while (taken.has(id)) {
    counter += 1;
    id = `q_${now.toString(36)}_${counter.toString(36)}_${rand().toString(36).slice(2, 8)}`;
  }
  return id;
}

// Returns a queue item, or null when there is no readable text.
function makeQueueItem(fields, opts = {}) {
  const text = typeof fields?.text === "string" ? fields.text.trim() : "";
  if (!text) return null;

  const existingIds = Array.isArray(opts.existingIds) ? opts.existingIds : [];
  return {
    id:       makeQueueItemId(existingIds, opts),
    title:    (typeof fields.title === "string" && fields.title.trim()) || "Untitled",
    url:      typeof fields.url === "string" ? fields.url : "",
    text,
    position: 0,
    added_at: Number.isFinite(opts.now) ? opts.now : Date.now(),
  };
}

// ─── Queue operations (all immutable: return new queues, never mutate) ──────

// Returns { queue, item } — item is null when fields has no readable text.
function addToQueue(queue, fields, opts = {}) {
  const base = normalizeQueue(queue);
  const item = makeQueueItem(fields, { ...opts, existingIds: base.items.map((i) => i.id) });
  if (!item) return { queue: base, item: null };
  return { queue: { schema: base.schema, items: [...base.items, item] }, item };
}

function removeFromQueue(queue, id) {
  const base = normalizeQueue(queue);
  const items = base.items.filter((i) => i.id !== id);
  if (items.length === base.items.length) return queue; // no-op → caller's reference
  return { schema: base.schema, items };
}

// dir: -1 (up) | +1 (down). Anything else is a no-op. Clamped at the ends.
// No-op → the caller's reference back.
function moveQueueItem(queue, id, dir) {
  const base = normalizeQueue(queue);
  if (dir !== -1 && dir !== 1) return queue;
  const idx = base.items.findIndex((i) => i.id === id);
  if (idx === -1) return queue;
  const target = Math.min(base.items.length - 1, Math.max(0, idx + dir));
  if (target === idx) return queue; // clamped at the boundary

  const items = [...base.items];
  const [moved] = items.splice(idx, 1);
  items.splice(target, 0, moved);
  return { schema: base.schema, items };
}

// Returns the SAME reference when nothing changed (lets callers skip writes).
function setQueuePosition(queue, id, position) {
  const base = normalizeQueue(queue);
  const idx = base.items.findIndex((i) => i.id === id);
  if (idx === -1) return queue;
  const pos = normalizePosition(position);
  if (base.items[idx].position === pos) return queue;

  const items = base.items.map((i) => (i.id === id ? { ...i, position: pos } : i));
  return { schema: base.schema, items };
}

// ─── Lookups ─────────────────────────────────────────────────────────────────

function getQueueItem(queue, id) {
  return normalizeQueue(queue).items.find((i) => i.id === id) || null;
}

function indexOfQueueItem(queue, id) {
  return normalizeQueue(queue).items.findIndex((i) => i.id === id);
}

// The item AFTER currentId, in queue order — null at the end or when the
// current item is gone. Auto-advance stops at the queue's end (no looping).
function nextQueueItem(queue, currentId) {
  const base = normalizeQueue(queue);
  const idx = base.items.findIndex((i) => i.id === currentId);
  if (idx === -1) return null;
  return base.items[idx + 1] || null;
}

function firstQueueItem(queue) {
  return normalizeQueue(queue).items[0] || null;
}

// ─── Node test-runner export (inert in the service worker) ─────────────────

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    QUEUE_STORAGE_KEY,
    QUEUE_SCHEMA_VERSION,
    emptyQueue,
    normalizeQueueItem,
    normalizePosition,
    normalizeQueue,
    makeQueueItemId,
    makeQueueItem,
    addToQueue,
    removeFromQueue,
    moveQueueItem,
    setQueuePosition,
    getQueueItem,
    indexOfQueueItem,
    nextQueueItem,
    firstQueueItem,
  };
}
