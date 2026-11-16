const test = require("node:test");
const assert = require("node:assert/strict");
require("../src/prompt.js");
const AAB = globalThis.AAB;

// --- How each app reads the link back (copied from their bundles) ---

// T3 Code: promptLinkAppPath keeps url.search, then URLSearchParams.get.
function t3Decode(url) {
  const u = new URL(url);
  assert.equal(u.protocol, "t3code:");
  assert.equal(u.host, "new");
  return Object.fromEntries(new URLSearchParams(u.search));
}

// Cursor: VS Code's URI.parse percent-decodes the query once, then the
// deeplink extension's Ws()/Ks() split on "&name=" and decode again.
function vscodePercentDecode(s) {
  return s.replace(/(%[0-9A-Za-z][0-9A-Za-z])+/g, (m) => {
    try {
      return decodeURIComponent(m);
    } catch {
      return m.length > 3 ? m.substr(0, 3) + vscodePercentDecode(m.substr(3)) : m;
    }
  });
}
function cursorParam(query, name) {
  const re = /&[a-zA-Z][a-zA-Z0-9_-]*=/;
  const key = `${name}=`;
  let from = 0;
  while (from <= query.length) {
    const at = query.indexOf(key, from);
    if (at === -1) return null;
    if (at !== 0 && query[at - 1] !== "&") {
      from = at + key.length;
      continue;
    }
    const start = at + key.length;
    let end = query.length;
    const m = query.substring(start).match(re);
    if (m && typeof m.index === "number") end = start + m.index;
    const raw = query.substring(start, end).replace(/\+/g, " ");
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}
const CURSOR_TEXT_OK = /^(?!.*(?:\p{Cf}|\u007F))[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Z}\r\n\t !-~]+$/su;
function cursorDecode(url) {
  const prefix = "cursor://anysphere.cursor-deeplink/prompt?";
  assert.ok(url.startsWith(prefix));
  const query = vscodePercentDecode(url.slice(prefix.length));
  const text = cursorParam(query, "text");
  assert.ok(text, "Cursor would report a missing text parameter");
  assert.ok(CURSOR_TEXT_OK.test(text), "Cursor would reject the text as invalid");
  assert.ok(21 + encodeURIComponent(text).length <= 10000, "Cursor would reject the length");
  return { text, workspace: cursorParam(query, "workspace") };
}

// --- Fixtures ---

function thread(overrides = {}) {
  return {
    owner: "acme",
    repo: "web",
    number: 42,
    prTitle: "Speed up search",
    headRef: "feat/search",
    baseRef: "main",
    path: "src/search.ts",
    subjectType: "line",
    line: 52,
    outdated: false,
    diffHunk: "@@ -40,6 +40,13 @@ export function search(q) {\n" + Array.from({ length: 13 }, (_, i) => `+  const x${i} = ${i};`).join("\n"),
    focusId: 1,
    comments: [
      { id: 1, author: "alice", body: "Use a Map here instead of an object.", url: "https://github.com/acme/web/pull/42#discussion_r1" },
      { id: 2, author: "bob", body: "Good call, but keys can be numbers.", url: "https://github.com/acme/web/pull/42#discussion_r2" },
    ],
    ...overrides,
  };
}

const TRICKY = "a+b & c=1 &text=evil 100% done; `x` café 👍🏽 family 👨‍👩‍👧 ​zero-width‮ bidi";

// --- Tests ---

test("prompt contains the comment text, file, lines and thread", () => {
  const p = AAB.buildPrompt(thread());
  assert.match(p, /File: src\/search\.ts \(line 52\)/);
  assert.match(p, /@alice:\nUse a Map here instead of an object\./);
  assert.match(p, /@bob:\nGood call/);
  assert.match(p, /Code from src\/search\.ts, ending at line 52 \(the commented line\):\n```diff\n@@ -40,6 \+40,13 @@/);
  const noPath = AAB.buildPrompt(thread({ path: null, line: null }));
  assert.match(noPath, /Code the comment refers to \(the last line is the commented line\):/);
  assert.match(p, /Comment link: https:\/\/github\.com\/acme\/web\/pull\/42#discussion_r1/);
  assert.ok(p.endsWith(AAB.DEFAULT_INSTRUCTION));
});

test("custom instruction replaces the default", () => {
  const p = AAB.buildPrompt(thread(), { instruction: "Fix it and add a test." });
  assert.ok(p.endsWith("Fix it and add a test."));
});

test("outdated and file-level comments are described", () => {
  const out = AAB.buildPrompt(thread({ outdated: true }));
  assert.match(out, /File: src\/search\.ts \(line 52\)/);
  assert.match(out, /outdated/);
  const file = AAB.buildPrompt(thread({ subjectType: "file", line: null, diffHunk: null }));
  assert.match(file, /\(whole file\)/);
});

test("diff keeps leading context markers and blank context lines", () => {
  const p = AAB.buildPrompt(thread({ diffHunk: " \n context line\n+added", line: 3 }));
  assert.match(p, /```diff\n \n context line\n\+added\n```/);
});

test("code fence survives backticks inside the hunk", () => {
  const p = AAB.buildPrompt(thread({ diffHunk: "@@ -1 +1 @@\n+const s = ```;" }));
  assert.match(p, /````diff/);
});

test("T3 Code link round-trips tricky text and carries repo/provider/model", () => {
  const t = thread({ comments: [{ id: 1, author: "alice", body: TRICKY, url: "u" }] });
  const { prompt } = AAB.promptFor("t3", t);
  const params = t3Decode(AAB.t3Url(prompt, { owner: "acme", repo: "web", provider: "claude", model: "claude-opus-5-5" }));
  assert.equal(params.prompt, prompt);
  assert.equal(params.repo, "acme/web");
  assert.equal(params.provider, "claude");
  assert.equal(params.model, "claude-opus-5-5");
  assert.match(prompt, /a\+b & c=1 &text=evil 100% done/);
  assert.doesNotMatch(prompt, /[​‮‍]/);
});

test("Cursor link round-trips '+', '&name=', '%' and passes Cursor's validation", () => {
  const t = thread({ comments: [{ id: 1, author: "alice", body: TRICKY, url: "u" }] });
  const { prompt } = AAB.promptFor("cursor", t);
  const decoded = cursorDecode(AAB.cursorUrl(prompt, { workspace: "my web+app" }));
  assert.equal(decoded.text, prompt);
  assert.equal(decoded.workspace, "my web+app");
});

test("single encoding would have broken Cursor (regression guard)", () => {
  const text = "a+b &text=x";
  const naive = `cursor://anysphere.cursor-deeplink/prompt?text=${encodeURIComponent(text)}`;
  const query = vscodePercentDecode(naive.split("?")[1]);
  assert.notEqual(cursorParam(query, "text"), text);
});

test("long threads are shortened to fit each app's limit", () => {
  const huge = "x".repeat(6000);
  const many = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, author: `u${i}`, body: `${i} ${huge}`, url: `u${i}` }));
  const t = thread({ comments: many, focusId: 5, diffHunk: "@@ -1,400 +1,400 @@\n" + "+line\n".repeat(400) });

  const t3 = AAB.promptFor("t3", t);
  assert.ok(t3.prompt && t3.truncated);
  assert.ok(AAB.fitsT3(t3.prompt));
  assert.match(t3.prompt, /@u0:/, "keeps the first comment");
  assert.match(t3.prompt, /@u4 ← focus on this one:/, "keeps the focused comment");
  assert.match(t3.prompt, /replies omitted/);
  t3Decode(AAB.t3Url(t3.prompt, {}));

  const cur = AAB.promptFor("cursor", t);
  assert.ok(cur.prompt && cur.truncated);
  cursorDecode(AAB.cursorUrl(cur.prompt, {}));

  const copy = AAB.promptFor("copy", t);
  assert.equal(copy.prompt, copy.full);
  assert.ok(copy.prompt.length > 40000, "copy keeps everything");
});

test("non-ASCII text is measured after encoding for Cursor", () => {
  const t = thread({ comments: [{ id: 1, author: "a", body: "日本語".repeat(1500), url: "u" }] });
  const cur = AAB.promptFor("cursor", t);
  assert.ok(cur.prompt);
  cursorDecode(AAB.cursorUrl(cur.prompt, {}));
});

test("Cursor blocklist: drops the code block if only the code mentions .env", () => {
  const t = thread({ diffHunk: "@@ -1 +1 @@\n+const k = process.env.API_KEY;" });
  const r = AAB.promptFor("cursor", t);
  assert.ok(r.prompt);
  assert.doesNotMatch(r.prompt, /process\.env/);
  assert.ok(AAB.promptFor("t3", t).prompt.includes("process.env"), "T3 Code keeps it");
});

test("Cursor blocklist: refuses when the comment itself mentions .env", () => {
  const t = thread({ comments: [{ id: 1, author: "a", body: "Read this from .env instead", url: "u" }] });
  const r = AAB.promptFor("cursor", t);
  assert.equal(r.prompt, null);
  assert.equal(r.blocked, true);
  assert.ok(r.full.includes(".env"));
});

test("Cursor workspace mapping", () => {
  const map = "# comment\nacme/web = web-frontend\nother = other-dir";
  assert.equal(AAB.cursorWorkspace("acme", "web", map), "web-frontend");
  assert.equal(AAB.cursorWorkspace("ACME", "Web", map), "web-frontend");
  assert.equal(AAB.cursorWorkspace("x", "other", map), "other-dir");
  assert.equal(AAB.cursorWorkspace("x", "unmapped", map), "unmapped");
});
