// Prompt building and deep-link construction. Pure functions, no DOM or
// chrome.* access, so it runs both as a content script and under node tests.
(() => {
  // T3 Code rejects prompts longer than 8,000 characters (checked on the
  // decoded `prompt` parameter). Leave a little headroom.
  const T3_MAX_PROMPT = 7900;
  // Cursor rejects the prompt when 21 + encodeURIComponent(text).length
  // exceeds 10,000.
  const CURSOR_MAX_ENCODED = 9900;

  const DEFAULT_INSTRUCTION =
    "Make the change the reviewer is asking for. If you think the comment is wrong or unclear, explain why instead of changing the code.";

  // Characters both apps drop or refuse: control chars (except \n and \t),
  // format chars such as zero-width joiners and bidi marks, private-use and
  // unassigned code points. Cursor rejects the whole prompt if any remain.
  const UNSAFE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\p{Cf}\p{Co}\p{Cn}]/gu;

  function clean(text) {
    return String(text ?? "")
      .replace(/\r\n?|[\u2028\u2029]/g, "\n")
      .replace(UNSAFE_CHARS, "");
  }

  function sanitize(text) {
    return clean(text).trim();
  }

  // Code keeps its leading whitespace: in a diff, a leading space marks an
  // unchanged line, and blank lines at the edges are real lines.
  function sanitizeCode(text) {
    return clean(text).replace(/^\n+|\n+$/g, "");
  }

  // Mirrors the prompt filter in Cursor's deeplink handler
  // (extensions/cursor-deeplink). Anything matching is refused by Cursor.
  const CURSOR_BLOCKLIST = [
    /\.env(\b|\W)/,
    /read.*\.env.*print/i,
    /cat.*\.ssh\/id_rsa/i,
    /upload.*passwords\.txt/i,
    /dump.*token/i,
    /dump.*password/i,
    /exfiltrate.*credential/i,
    /leak.*secret/i,
    /how.*extract.*credential/i,
  ];

  function cursorBlocked(text) {
    const lower = text.toLowerCase();
    return CURSOR_BLOCKLIST.some((re) => re.test(lower));
  }

  function fenceFor(text) {
    const runs = text.match(/`{3,}/g) || [];
    const longest = runs.reduce((n, r) => Math.max(n, r.length), 2);
    return "`".repeat(longest + 1);
  }

  function describeLocation(t) {
    if (t.subjectType === "file") return "whole file";
    return t.line != null ? `line ${t.line}` : null;
  }

  // The code excerpt ends at the commented line. Keep the @@ header (if any)
  // plus the last `max` lines.
  function trimHunk(hunk, max) {
    if (!hunk) return "";
    const lines = hunk.split("\n");
    const header = lines[0].startsWith("@@") ? lines.shift() : null;
    const keep = Math.max(max, 3);
    if (lines.length <= keep) return hunk;
    const kept = lines.slice(-keep);
    return [header, "…", ...kept].filter((l) => l != null).join("\n");
  }

  function truncate(text, max) {
    if (text.length <= max) return text;
    return text.slice(0, Math.max(0, max)).trimEnd() + "\n… (truncated, see the comment link)";
  }

  /**
   * opts.hunkLines: Infinity | number (0 drops the code block)
   * opts.replies: "all" | "ends" (first comment, focused comment, last reply)
   * opts.bodyMax: max characters per comment body
   */
  function buildPrompt(t, opts = {}) {
    const hunkLines = opts.hunkLines ?? Infinity;
    const replies = opts.replies ?? "all";
    const bodyMax = opts.bodyMax ?? Infinity;
    const instruction = sanitize(opts.instruction) || DEFAULT_INSTRUCTION;

    const out = ["Address this pull request review comment.", ""];
    out.push(`PR: ${t.owner}/${t.repo}#${t.number}${t.prTitle ? ` — ${sanitize(t.prTitle)}` : ""}`);
    if (t.headRef) out.push(`Branch: ${t.headRef}${t.baseRef ? ` (into ${t.baseRef})` : ""}`);
    const where = describeLocation(t);
    if (t.path) out.push(`File: ${t.path}${where ? ` (${where})` : ""}`);
    if (t.outdated) {
      out.push("Note: GitHub marks this comment as outdated, so the code may have changed since it was written.");
    }

    if (t.diffHunk && hunkLines > 0) {
      const hunk = sanitizeCode(trimHunk(t.diffHunk, hunkLines));
      const fence = fenceFor(hunk);
      const source = t.path ? `Code from ${t.path}` : "Code the comment refers to";
      const end = t.line != null ? `, ending at line ${t.line} (the commented line)` : " (the last line is the commented line)";
      out.push("", `${source}${end}:`, `${fence}diff`, hunk, fence);
    }

    let comments = t.comments;
    let omitted = 0;
    if (replies === "ends" && comments.length > 3) {
      const keep = new Set([comments[0].id, t.focusId, comments[comments.length - 1].id]);
      const kept = comments.filter((c) => keep.has(c.id));
      omitted = comments.length - kept.length;
      comments = kept;
    }

    out.push("", comments.length > 1 ? "Review thread (oldest first):" : "Review comment:");
    comments.forEach((c, i) => {
      if (omitted && i === 1) out.push("", `(${omitted} more ${omitted === 1 ? "reply" : "replies"} omitted, see the comment link)`);
      const focus = t.comments.length > 1 && c.id === t.focusId && c.id !== t.comments[0].id ? " ← focus on this one" : "";
      out.push("", `@${c.author}${focus}:`, truncate(sanitize(c.body), bodyMax));
    });

    const focusComment = t.comments.find((c) => c.id === t.focusId) ?? t.comments[0];
    if (focusComment?.url) out.push("", `Comment link: ${focusComment.url}`);
    out.push("", instruction);
    return sanitize(out.join("\n"));
  }

  // Progressively smaller versions of the prompt, fullest first.
  function* candidates(t, opts) {
    yield buildPrompt(t, opts);
    yield buildPrompt(t, { ...opts, hunkLines: 20 });
    yield buildPrompt(t, { ...opts, hunkLines: 6 });
    yield buildPrompt(t, { ...opts, hunkLines: 0 });
    yield buildPrompt(t, { ...opts, hunkLines: 0, replies: "ends" });
    for (const bodyMax of [3000, 1500, 800, 400]) {
      yield buildPrompt(t, { ...opts, hunkLines: 0, replies: "ends", bodyMax });
    }
  }

  const fitsT3 = (p) => p.length <= T3_MAX_PROMPT;
  const fitsCursor = (p) => 21 + encodeURIComponent(p).length <= CURSOR_MAX_ENCODED;

  /**
   * Returns { prompt, full, truncated, blocked }.
   * `blocked` means Cursor's filter would refuse every candidate.
   */
  function promptFor(target, t, opts = {}) {
    const full = buildPrompt(t, opts);
    if (target === "copy") return { prompt: full, full, truncated: false, blocked: false };
    const fits = target === "t3" ? fitsT3 : fitsCursor;
    let sawUnblocked = false;
    for (const p of candidates(t, opts)) {
      const blocked = target === "cursor" && cursorBlocked(p);
      if (!blocked) sawUnblocked = true;
      if (!blocked && fits(p)) return { prompt: p, full, truncated: p !== full, blocked: false };
    }
    return { prompt: null, full, truncated: false, blocked: !sawUnblocked };
  }

  function t3Url(prompt, { owner, repo, provider, model } = {}) {
    const q = [];
    if (owner && repo) q.push(`repo=${encodeURIComponent(`${owner}/${repo}`)}`);
    if (provider) {
      q.push(`provider=${encodeURIComponent(provider)}`);
      if (model) q.push(`model=${encodeURIComponent(model)}`);
    }
    q.push(`prompt=${encodeURIComponent(prompt)}`);
    return `t3code://new?${q.join("&")}`;
  }

  // Cursor's handler receives the query already percent-decoded once, then
  // decodes each value again (turning "+" into a space) and ends a value at
  // the next "&name=". Encoding twice keeps "+", "&" and "%" intact.
  function cursorUrl(prompt, { workspace } = {}) {
    const enc2 = (s) => encodeURIComponent(encodeURIComponent(s));
    const q = [];
    if (workspace) q.push(`workspace=${enc2(workspace)}`);
    q.push(`text=${enc2(prompt)}`);
    return `cursor://anysphere.cursor-deeplink/prompt?${q.join("&")}`;
  }

  // "owner/repo = folder" lines, or "repo = folder". Falls back to the repo name.
  function cursorWorkspace(owner, repo, mapText) {
    const map = new Map();
    for (const raw of String(mapText ?? "").split("\n")) {
      const line = raw.replace(/#.*/, "").trim();
      const m = /^([^=\s]+)\s*=\s*(.+)$/.exec(line);
      if (m) map.set(m[1].toLowerCase(), m[2].trim());
    }
    return map.get(`${owner}/${repo}`.toLowerCase()) ?? map.get(repo.toLowerCase()) ?? repo;
  }

  globalThis.AAB = {
    DEFAULT_INSTRUCTION,
    T3_MAX_PROMPT,
    CURSOR_MAX_ENCODED,
    sanitize,
    cursorBlocked,
    buildPrompt,
    promptFor,
    t3Url,
    cursorUrl,
    cursorWorkspace,
    fitsT3,
    fitsCursor,
  };
})();
