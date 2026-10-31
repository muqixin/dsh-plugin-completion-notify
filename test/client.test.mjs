// Headless harness for lib/client.js, run by `npm test`.
//
// The bundle is a browser module that registers itself on
// window.__ModuleLoader__ and then talks to Cordis services, so this test
// supplies just enough of a DOM, Notification, Web Audio, and Client context to
// drive every alert path without a browser.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

// ── minimal DOM ─────────────────────────────────────────────────────────────
const index = new Map();
class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.attrs = {};
    this.listeners = {};
    this.textContent = "";
    this.id = "";
    this.className = "";
    this.classList = {
      add: (name) => this.classList.names.add(name),
      remove: (name) => this.classList.names.delete(name),
      contains: (name) => this.classList.names.has(name),
      names: new Set(),
    };
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parentNode = this;
      this.children.push(node);
      if (node.id) index.set(node.id, node);
    }
  }
  appendChild(node) {
    this.append(node);
    return node;
  }
  removeChild(node) {
    const at = this.children.indexOf(node);
    if (at >= 0) this.children.splice(at, 1);
    node.parentNode = null;
    return node;
  }
  setAttribute(name, value) {
    this.attrs[name] = value;
  }
  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }
  attachShadow() {
    this.shadowRoot = new Element("#shadow");
    return this.shadowRoot;
  }
  dispatch(type, extra = {}) {
    for (const listener of this.listeners[type] ?? []) listener({ preventDefault() {}, stopPropagation() {}, ...extra });
  }
}

globalThis.document = {
  body: new Element("body"),
  createElement: (tag) => new Element(tag),
  getElementById: (id) => index.get(id) ?? null,
  visibilityState: "visible",
  hasFocus: () => true,
  addEventListener() {},
  removeEventListener() {},
};

// ── Web Audio ───────────────────────────────────────────────────────────────
const tones = [];
class AudioParam {
  setValueAtTime() { return this; }
  exponentialRampToValueAtTime() { return this; }
}
class AudioContext {
  constructor() {
    this.state = "running";
    this.currentTime = 0;
    this.destination = {};
  }
  resume() { return Promise.resolve(); }
  createOscillator() {
    const oscillator = {
      type: "sine",
      frequency: { value: 0 },
      connect: (target) => target,
      start: () => tones.push(oscillator.frequency.value),
      stop: () => {},
    };
    return oscillator;
  }
  createGain() {
    return { gain: new AudioParam(), connect: (target) => target };
  }
}

// ── module loader, Notification, storage ────────────────────────────────────
const registrations = [];
globalThis.window = {
  __ModuleLoader__: { load: (registration) => registrations.push(registration) },
  focus() {},
  addEventListener() {},
  removeEventListener() {},
  AudioContext,
};

const raised = [];
class FakeNotification {
  static permission = "granted";
  constructor(title, options) {
    this.title = title;
    this.options = options;
    this.closed = false;
    raised.push(this);
  }
  close() {
    this.closed = true;
  }
}
globalThis.Notification = FakeNotification;

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
};

globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });

new Function(source)();

// ── Client context double ───────────────────────────────────────────────────
const sessions = {
  "sess-1": { id: "sess-1", title: "修复登录超时", displayTitle: "修复登录超时", running: false },
  "sess-2": { id: "sess-2", title: "迁移构建脚本", displayTitle: "迁移构建脚本", running: false },
  "sess-3": { id: "sess-3", title: "重构导出流程", displayTitle: "重构导出流程", running: false },
  "sess-4": { id: "sess-4", title: "被用户停止", displayTitle: "被用户停止", running: false },
};

function mount(permission, { bindings = {}, projections } = {}) {
  FakeNotification.permission = permission;
  const plugin = registrations.at(-1).factory(() => {
    throw new Error("the bundle must not require another module");
  });
  const opened = [];
  const handlers = new Map();
  const disposers = [];
  const status = { value: new Map(), listeners: new Set() };
  const ctx = {
    effect(effect, label) {
      disposers.push({ label, fn: effect() });
    },
    remote: {
      $on(event, handler) {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      },
      session: {
        async projections({ sessionId }) {
          if (projections !== undefined) return projections(sessionId);
          if (sessionId === "sess-3") return { ok: true, value: { values: { title: "重构导出流程", turnOutline: [{ prompt: "重构导出流程", response: "" }] } } };
          return {
            ok: true,
            value: {
              values: {
                title: sessionId === "sess-2" ? "迁移构建脚本" : "修复登录超时",
                turnOutline: [{ prompt: "修复登录超时", response: "已定位为 token 刷新竞态，并补了回归测试。" }],
              },
            },
          };
        },
      },
    },
    sessions: {
      list: { getSnapshot: () => ({ byId: sessions }) },
      binding: (id) => bindings[id],
    },
    uiSession: {
      sessionStatus: {
        getSnapshot: () => status.value,
        subscribe(listener) {
          status.listeners.add(listener);
          return () => status.listeners.delete(listener);
        },
      },
    },
    uiWorkspace: { openSession: (id) => opened.push(id) },
  };
  plugin.apply(ctx);
  return {
    opened,
    handlers,
    disposers,
    emit: (id, running) => handlers.get("api-session/status")(id, running),
    setStatus(map) {
      status.value = map;
      for (const listener of status.listeners) listener();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
const turnEnd = (reason) => ({ eventSource: { getSnapshot: () => ({ entries: [{ type: "event", event: { type: "turn/end", data: { turn: 1, reason } } }] }) } });
const approvalOf = (answers) => ({
  kind: "approval",
  key: "call-1",
  sessionId: "sess-2",
  toolName: "shell",
  reason: "运行 rm -rf build 需要授权",
  answerable: true,
  async answer(outcome) {
    answers.push(outcome);
  },
});

test("a finished turn alerts with the session title and summary", async () => {
  raised.length = 0;
  storage.clear();
  const run = mount("granted");
  assert.equal(raised.length, 1, "welcome notification");
  const base = raised.length;
  run.emit("sess-1", true);
  run.emit("sess-1", false);
  await settle();
  assert.equal(raised.length, base + 1);
  const note = raised.at(-1);
  assert.equal(note.title, "修复登录超时");
  assert.match(note.options.body, /token/);
  assert.deepEqual(tones.slice(-4), [880, 1760, 1318.51, 2637], "two notes with octave overtones");
  note.onclick();
  assert.deepEqual(run.opened, ["sess-1"]);
  for (const disposer of run.disposers) disposer.fn();
});

test("an interrupted turn says so, but a user stop is silent", async () => {
  raised.length = 0;
  storage.clear();
  const run = mount("granted", {
    bindings: {
      "sess-4": turnEnd({ kind: "aborted", reason: { kind: "user" } })
    }
  });
  const base = raised.length;

  run.emit("sess-3", true);
  run.emit("sess-3", false);
  await settle();
  assert.equal(raised.length, base + 1, "empty reply on a prompted turn counts as an interruption");
  assert.match(raised.at(-1).options.body, /已中断/);

  const stopped = raised.length;
  run.emit("sess-4", true);
  run.emit("sess-4", false);
  await settle();
  assert.equal(raised.length, stopped, "a stop the person pressed must not alert");
  for (const disposer of run.disposers) disposer.fn();
});

test("a system-side abort still alerts", async () => {
  raised.length = 0;
  storage.clear();
  const run = mount("granted", {
    bindings: {
      "sess-4": turnEnd({ kind: "aborted", reason: { kind: "hook", reason: "timeout" } })
    }
  });
  const base = raised.length;
  run.emit("sess-4", true);
  run.emit("sess-4", false);
  await settle();
  assert.equal(raised.length, base + 1);
  for (const disposer of run.disposers) disposer.fn();
});

test("an approval asks once, carries actions, and withdraws when settled", async () => {
  raised.length = 0;
  storage.clear();
  const answers = [];
  const run = mount("granted");
  const base = raised.length;
  const request = approvalOf(answers);

  run.setStatus(new Map([["sess-2", { running: true, pendingInteraction: request, completionUnread: false }]]));
  assert.equal(raised.length, base + 1);
  const note = raised.at(-1);
  assert.equal(note.title, "需要授权");
  assert.match(note.options.body, /rm -rf build/);
  assert.equal(note.options.requireInteraction, true);
  assert.deepEqual(note.options.actions.map((action) => action.id), ["approve", "reject"]);

  await note.onaction({ action: "approve" });
  assert.deepEqual(answers, ["allowed-once"]);
  assert.equal(note.closed, true);

  run.setStatus(new Map());
  assert.equal(note.closed, true);

  // The same request repeated must not re-notify.
  const after = raised.length;
  run.setStatus(new Map([["sess-2", { running: true, pendingInteraction: request, completionUnread: false }]]));
  assert.equal(raised.length, after + 1, "a settled-then-returning request is a new alert");
  for (const disposer of run.disposers) disposer.fn();
});

test("a question alerts once and opens the session on click", async () => {
  raised.length = 0;
  storage.clear();
  const run = mount("granted");
  const base = raised.length;
  const request = {
    kind: "question",
    key: "ask-1",
    sessionId: "sess-1",
    questions: [{ id: "q1", question: "要发布到 npm 还是只发 GitHub？" }],
    answerable: true,
  };

  run.setStatus(new Map([["sess-1", { running: true, pendingInteraction: request, completionUnread: false }]]));
  assert.equal(raised.length, base + 1);
  const note = raised.at(-1);
  assert.equal(note.title, "需要回答");
  assert.match(note.options.body, /npm/);
  note.onclick();
  assert.deepEqual(run.opened, ["sess-1"]);

  run.setStatus(new Map([["sess-1", { running: true, pendingInteraction: request, completionUnread: false }]]));
  assert.equal(raised.length, base + 1, "no duplicate for an unchanged request");
  for (const disposer of run.disposers) disposer.fn();
});

test("without notification permission the in-page card takes over", async () => {
  raised.length = 0;
  storage.clear();
  const run = mount("denied");
  run.emit("sess-1", true);
  run.emit("sess-1", false);
  await settle();
  assert.equal(raised.length, 0);
  const host = document.getElementById("dsh-completion-notify-stack");
  assert.notEqual(host, null);
  const stack = host.shadowRoot.children.find((child) => child.className === "stack");
  assert.ok(stack.children.length >= 1);
  for (const disposer of run.disposers) disposer.fn();
  assert.equal(document.body.children.some((child) => child.id === "dsh-completion-notify-stack"), false);
});
