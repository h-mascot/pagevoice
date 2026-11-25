/**
 * lib/pv-queue.test.js — colocated tests for the pure logic in pv-queue.js
 *
 * Run: `npm test` (node --test). Per TESTING.md: pure logic only, real
 * assertions, boundary values (0, 1, max, empty, null), no DOM/storage.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
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
} = require("./pv-queue.js");

// Deterministic fixture helpers (no Date.now / Math.random in tests)
const NOW = 1732500000000;
const opts = { now: NOW, rand: () => 0.5 };
const item = (over = {}) => ({
  id: "q_1",
  title: "Title",
  url: "https://example.com/a",
  text: "Some readable article text.",
  position: 0,
  added_at: NOW,
  ...over,
});

function threeItemQueue() {
  return {
    schema: 1,
    items: [
      item({ id: "a", title: "A", text: "Text A." }),
      item({ id: "b", title: "B", text: "Text B." }),
      item({ id: "c", title: "C", text: "Text C." }),
    ],
  };
}

// ─── constants / emptyQueue ──────────────────────────────────────────────────

describe("queue constants", () => {
  it("pins the storage key and schema version", () => {
    assert.equal(QUEUE_STORAGE_KEY, "pvQueue");
    assert.equal(QUEUE_SCHEMA_VERSION, 1);
  });
});

describe("emptyQueue", () => {
  it("returns a v1 queue with an empty item list", () => {
    assert.deepEqual(emptyQueue(), { schema: 1, items: [] });
  });
});

// ─── normalizeQueueItem / normalizeQueue ────────────────────────────────────

describe("normalizeQueueItem", () => {
  it("rejects null, non-objects, missing id, and empty text", () => {
    assert.equal(normalizeQueueItem(null), null);
    assert.equal(normalizeQueueItem(undefined), null);
    assert.equal(normalizeQueueItem("a"), null);
    assert.equal(normalizeQueueItem(7), null);
    assert.equal(normalizeQueueItem({ text: "hi" }), null); // no id
    assert.equal(normalizeQueueItem(item({ id: "" })), null); // empty id
    assert.equal(normalizeQueueItem(item({ text: "   " })), null); // blank text
    assert.equal(normalizeQueueItem(item({ text: null })), null);
  });

  it("fills defaults for missing title, url, position, added_at", () => {
    const n = normalizeQueueItem({ id: "q_1", text: "Hi." });
    assert.equal(n.title, "Untitled");
    assert.equal(n.url, "");
    assert.equal(n.position, 0);
    assert.equal(typeof n.added_at, "number");
  });

  it("normalises positions: negative → 0, fractional → floor, garbage → 0", () => {
    assert.equal(normalizeQueueItem(item({ position: -3 })).position, 0);
    assert.equal(normalizeQueueItem(item({ position: 4.9 })).position, 4);
    assert.equal(normalizeQueueItem(item({ position: "x" })).position, 0);
    assert.equal(normalizeQueueItem(item({ position: null })).position, 0);
  });
});

describe("normalizeQueue", () => {
  it("returns an empty queue for null, primitives, and garbage", () => {
    assert.deepEqual(normalizeQueue(null), emptyQueue());
    assert.deepEqual(normalizeQueue(undefined), emptyQueue());
    assert.deepEqual(normalizeQueue("nope"), emptyQueue());
    assert.deepEqual(normalizeQueue(42), emptyQueue());
    assert.deepEqual(normalizeQueue({ items: "not-an-array" }), emptyQueue());
  });

  it("keeps valid items and drops invalid ones", () => {
    const raw = {
      schema: 1,
      items: [item({ id: "good" }), { nope: true }, item({ id: "also-good", text: "x" }), null],
    };
    const q = normalizeQueue(raw);
    assert.deepEqual(q.items.map((i) => i.id), ["good", "also-good"]);
  });

  it("defaults the schema field when absent", () => {
    assert.equal(normalizeQueue({ items: [] }).schema, 1);
  });
});

// ─── makeQueueItemId / makeQueueItem ─────────────────────────────────────────

describe("makeQueueItemId", () => {
  it("is deterministic for fixed opts", () => {
    const a = makeQueueItemId([], opts);
    const b = makeQueueItemId([], opts);
    assert.equal(a, b);
    assert.match(a, /^q_[0-9a-z]+_[0-9a-z]+$/);
  });

  it("never collides with existing ids", () => {
    const first = makeQueueItemId([], opts);
    const second = makeQueueItemId([first], opts);
    assert.notEqual(first, second);
    // third round: both taken → still unique
    const third = makeQueueItemId([first, second], opts);
    assert.notEqual(third, first);
    assert.notEqual(third, second);
  });
});

describe("makeQueueItem", () => {
  it("returns null for missing, empty, or whitespace-only text", () => {
    assert.equal(makeQueueItem({}, opts), null);
    assert.equal(makeQueueItem({ text: "" }, opts), null);
    assert.equal(makeQueueItem({ text: "   " }, opts), null);
    assert.equal(makeQueueItem({ text: null }, opts), null);
  });

  it("builds a full item with defaults", () => {
    const it2 = makeQueueItem({ title: "T", url: "u", text: " Body. " }, opts);
    assert.equal(it2.title, "T");
    assert.equal(it2.url, "u");
    assert.equal(it2.text, "Body."); // trimmed
    assert.equal(it2.position, 0);
    assert.equal(it2.added_at, NOW);
    assert.ok(it2.id);
  });

  it("falls back to 'Untitled' for missing/blank titles", () => {
    assert.equal(makeQueueItem({ text: "x" }, opts).title, "Untitled");
    assert.equal(makeQueueItem({ title: "  ", text: "x" }, opts).title, "Untitled");
  });

  it("defaults url to empty string for non-strings", () => {
    assert.equal(makeQueueItem({ text: "x", url: 5 }, opts).url, "");
  });
});

// ─── addToQueue ───────────────────────────────────────────────────────────────

describe("addToQueue", () => {
  it("appends the item and returns it", () => {
    const q0 = emptyQueue();
    const { queue, item: added } = addToQueue(q0, { title: "A", url: "u", text: "Text." }, opts);
    assert.equal(queue.items.length, 1);
    assert.equal(added.title, "A");
    assert.equal(queue.items[0].id, added.id);
  });

  it("does not mutate the input queue", () => {
    const q0 = threeItemQueue();
    const frozen = JSON.parse(JSON.stringify(q0));
    const { queue } = addToQueue(q0, { title: "D", text: "Text D." }, opts);
    assert.deepEqual(q0, frozen);
    assert.equal(queue.items.length, 4);
    assert.notEqual(queue, q0);
  });

  it("returns an unchanged queue and null item when there is no text", () => {
    const q0 = threeItemQueue();
    const { queue, item: added } = addToQueue(q0, { title: "D", text: "" }, opts);
    assert.equal(added, null);
    assert.equal(queue.items.length, 3);
  });

  it("gives each added item a unique id", () => {
    let q = emptyQueue();
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const { queue: nq, item: it2 } = addToQueue(q, { text: `T${i}.` }, opts);
      q = nq;
      ids.push(it2.id);
    }
    assert.equal(new Set(ids).size, 5);
  });
});

// ─── removeFromQueue ──────────────────────────────────────────────────────────

describe("removeFromQueue", () => {
  it("removes only the targeted item", () => {
    const q = removeFromQueue(threeItemQueue(), "b");
    assert.deepEqual(q.items.map((i) => i.id), ["a", "c"]);
  });

  it("is a no-op for unknown ids (caller's reference back)", () => {
    const q0 = threeItemQueue();
    assert.equal(removeFromQueue(q0, "zzz"), q0);
  });

  it("does not mutate the input queue", () => {
    const q0 = threeItemQueue();
    const frozen = JSON.parse(JSON.stringify(q0));
    removeFromQueue(q0, "a");
    assert.deepEqual(q0, frozen);
  });
});

// ─── moveQueueItem ────────────────────────────────────────────────────────────

describe("moveQueueItem", () => {
  it("moves an item up (-1)", () => {
    const q = moveQueueItem(threeItemQueue(), "b", -1);
    assert.deepEqual(q.items.map((i) => i.id), ["b", "a", "c"]);
  });

  it("moves an item down (+1)", () => {
    const q = moveQueueItem(threeItemQueue(), "b", 1);
    assert.deepEqual(q.items.map((i) => i.id), ["a", "c", "b"]);
  });

  it("clamps at the top and bottom boundaries (caller's reference back)", () => {
    const q0 = threeItemQueue();
    assert.equal(moveQueueItem(q0, "a", -1), q0);
    assert.equal(moveQueueItem(q0, "c", 1), q0);
  });

  it("is a no-op for invalid direction or unknown id", () => {
    const q0 = threeItemQueue();
    assert.equal(moveQueueItem(q0, "a", 0), q0);
    assert.equal(moveQueueItem(q0, "a", 2), q0);
    assert.equal(moveQueueItem(q0, "zzz", -1), q0);
  });

  it("does not mutate the input queue", () => {
    const q0 = threeItemQueue();
    const frozen = JSON.parse(JSON.stringify(q0));
    moveQueueItem(q0, "b", -1);
    assert.deepEqual(q0, frozen);
  });
});

// ─── setQueuePosition ─────────────────────────────────────────────────────────

describe("setQueuePosition", () => {
  it("sets the resume position on the targeted item", () => {
    const q = setQueuePosition(threeItemQueue(), "b", 7);
    assert.equal(getQueueItem(q, "b").position, 7);
    assert.equal(getQueueItem(q, "a").position, 0);
  });

  it("clamps negative and normalises fractional positions", () => {
    assert.equal(getQueueItem(setQueuePosition(threeItemQueue(), "a", -5), "a").position, 0);
    assert.equal(getQueueItem(setQueuePosition(threeItemQueue(), "a", 2.7), "a").position, 2);
  });

  it("returns the same reference when nothing changes", () => {
    const q0 = threeItemQueue();
    assert.equal(setQueuePosition(q0, "a", 0), q0); // already 0
    assert.equal(setQueuePosition(q0, "zzz", 3), q0); // unknown item
  });

  it("does not mutate the input queue", () => {
    const q0 = threeItemQueue();
    const frozen = JSON.parse(JSON.stringify(q0));
    setQueuePosition(q0, "b", 9);
    assert.deepEqual(q0, frozen);
  });
});

// ─── lookups ──────────────────────────────────────────────────────────────────

describe("queue lookups", () => {
  it("getQueueItem finds and misses", () => {
    assert.equal(getQueueItem(threeItemQueue(), "b").title, "B");
    assert.equal(getQueueItem(threeItemQueue(), "zzz"), null);
    assert.equal(getQueueItem(null, "b"), null);
  });

  it("indexOfQueueItem returns the index or -1", () => {
    assert.equal(indexOfQueueItem(threeItemQueue(), "c"), 2);
    assert.equal(indexOfQueueItem(threeItemQueue(), "zzz"), -1);
  });

  it("firstQueueItem returns the first item or null when empty", () => {
    assert.equal(firstQueueItem(threeItemQueue()).id, "a");
    assert.equal(firstQueueItem(emptyQueue()), null);
  });
});

// ─── nextQueueItem (auto-advance) ─────────────────────────────────────────────

describe("nextQueueItem", () => {
  it("returns the item after the current one", () => {
    assert.equal(nextQueueItem(threeItemQueue(), "a").id, "b");
    assert.equal(nextQueueItem(threeItemQueue(), "b").id, "c");
  });

  it("returns null at the end of the queue (no looping)", () => {
    assert.equal(nextQueueItem(threeItemQueue(), "c"), null);
  });

  it("returns null for an unknown current item", () => {
    assert.equal(nextQueueItem(threeItemQueue(), "zzz"), null);
  });

  it("returns null for an empty queue", () => {
    assert.equal(nextQueueItem(emptyQueue(), "a"), null);
  });
});

// ─── position persistence round-trip (the resume-at-saved-position path) ─────

describe("queue position round-trip", () => {
  it("add → set position → read back survives normalisation", () => {
    let { queue } = addToQueue(emptyQueue(), { title: "A", url: "u", text: "Text A." }, opts);
    queue = setQueuePosition(queue, queue.items[0].id, 12);
    // What storage would hand back after a JSON round-trip:
    const reloaded = normalizeQueue(JSON.parse(JSON.stringify(queue)));
    assert.equal(getQueueItem(reloaded, queue.items[0].id).position, 12);
  });
});
