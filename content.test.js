const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

test("later sentences in one text node keep their original offsets", () => {
  const context = {
    window: { addEventListener() {} },
    document: {
      addEventListener() {},
      createElement() { return new Element(); },
    },
    chrome: {
      runtime: { onMessage: { addListener() {} } },
      storage: { onChanged: { addListener() {} } },
    },
    console: { log() {} },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve("./content.js"), "utf8"), context);

  const text = "First sentence. Second sentence. Third sentence.";
  const parent = new Element();
  const node = new Text(text);
  parent.appendChild(node);
  const walk = { map: Array.from(text, (_, offset) => ({ node, offset })) };
  const spans = new Map();
  const cursors = new Map();
  const parts = ["First sentence.", "Second sentence.", "Third sentence."];
  let start = 0;
  parts.forEach((part, index) => {
    context.wrapWalkRange(walk, start, start + part.length, index, spans, cursors);
    start += part.length + 1;
  });

  assert.deepEqual(parts.map((_, i) => spans.get(i)?.map((span) => span.textContent).join("")), parts);
  assert.equal(parent.textContent, text);
});

class Element {
  constructor() { this.children = []; this.dataset = {}; }
  get textContent() { return this.children.map((child) => child.textContent).join(""); }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    this.children.push(child);
    child.parentNode = this;
  }
  insertBefore(child, next) {
    if (child.parentNode) child.parentNode.removeChild(child);
    this.children.splice(this.children.indexOf(next), 0, child);
    child.parentNode = this;
  }
  removeChild(child) {
    this.children.splice(this.children.indexOf(child), 1);
    child.parentNode = null;
  }
}

class Text {
  constructor(value) { this.value = value; this.parentNode = null; }
  get textContent() { return this.value; }
  splitText(offset) {
    if (offset < 0 || offset > this.value.length) throw new Error("bad offset");
    const tail = new Text(this.value.slice(offset));
    this.value = this.value.slice(0, offset);
    const parent = this.parentNode;
    parent.children.splice(parent.children.indexOf(this) + 1, 0, tail);
    tail.parentNode = parent;
    return tail;
  }
}
