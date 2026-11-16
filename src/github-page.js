// Loads review threads through the same endpoints github.com's own UI uses.
// Runs in the content script, so requests are same-origin and carry the
// user's GitHub session: private repos work without any token.
//
// These endpoints are undocumented. All knowledge of their shape lives in
// this file so a GitHub change only needs fixing here.
(() => {
  const CACHE_MS = 30_000;
  const cache = new Map(); // url -> { at, promise }

  class PageDataError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  async function request(url, kind) {
    const res = await fetch(url, {
      credentials: "same-origin",
      headers:
        kind === "json"
          ? { Accept: "application/json", "X-Requested-With": "XMLHttpRequest", "GitHub-Verified-Fetch": "true" }
          : { Accept: "text/html" },
    });
    if (!res.ok) {
      const hint = res.status === 404 ? " Are you signed in to GitHub in this browser?" : "";
      throw new PageDataError(`GitHub returned ${res.status} for ${new URL(url, location.origin).pathname}.${hint}`, res.status);
    }
    return kind === "json" ? res.json() : res.text();
  }

  function cached(url, kind, { fresh = false } = {}) {
    const hit = cache.get(url);
    if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
    const promise = request(url, kind);
    cache.set(url, { at: Date.now(), promise });
    promise.catch(() => cache.delete(url));
    return promise;
  }

  // ---------- parsing (pure) ----------

  function findThread(threadsJson, commentId) {
    const id = Number(commentId);
    for (const t of threadsJson?.threads ?? []) {
      const comments = t.commentsData?.comments ?? [];
      if (comments.some((c) => c.databaseId === id)) return t;
    }
    return null;
  }

  function threadComments(thread) {
    return (thread.commentsData?.comments ?? [])
      .filter((c) => !c.isHidden)
      .map((c) => ({
        id: c.databaseId,
        author: c.author?.login ?? "ghost",
        body: c.body ?? "",
        url: c.url,
      }));
  }

  // Copilot comments carry their file path in the suggestion payload.
  function pathFromThreadData(thread) {
    for (const c of thread.commentsData?.comments ?? []) {
      const p = c.automatedComment?.suggestion?.diffEntries?.[0]?.path;
      if (p) return p;
    }
    return null;
  }

  // The thread fragment holds a diff table ending at the commented line:
  // <tr><td data-line-number=old/><td data-line-number=new/><td class="blob-code blob-code-{addition|deletion|context|hunk}">
  function parseHunk(doc) {
    const rows = [...doc.querySelectorAll("table.diff-table tr")];
    const lines = [];
    let last = null;
    for (const tr of rows) {
      const code = tr.querySelector("td.blob-code");
      if (!code) continue;
      const text = (code.querySelector(".blob-code-inner") ?? code).textContent.replace(/\n$/, "");
      const nums = [...tr.querySelectorAll("td.blob-num")].map((td) => td.getAttribute("data-line-number"));
      if (code.classList.contains("blob-code-hunk")) {
        lines.push(text.trim());
        continue;
      }
      const type = code.classList.contains("blob-code-addition")
        ? "+"
        : code.classList.contains("blob-code-deletion")
          ? "-"
          : " ";
      lines.push(type + text);
      const n = type === "-" ? nums[0] : nums[1] ?? nums[0];
      if (n) last = { line: Number(n), side: type === "-" ? "LEFT" : "RIGHT" };
    }
    return { diffHunk: lines.join("\n"), line: last?.line ?? null, side: last?.side ?? null };
  }

  // ---------- DOM context ----------

  function pathFromDom(el) {
    const thread = el?.closest?.("review-thread-collapsible");
    const headerLink = thread && [...thread.children].map((c) => c.querySelector(":scope > span a.text-mono, :scope a.text-mono")).find(Boolean);
    if (headerLink?.textContent.trim()) return headerLink.textContent.trim();
    const tagged = el?.closest?.("[data-tagsearch-path]")?.getAttribute("data-tagsearch-path");
    if (tagged) return tagged;
    const file = el?.closest?.(".file, [data-file-path], [data-path]");
    return (
      file?.getAttribute("data-file-path") ||
      file?.getAttribute("data-path") ||
      file?.querySelector(".file-header [data-path]")?.getAttribute("data-path") ||
      null
    );
  }

  function outdatedFromDom(el) {
    const thread = el?.closest?.("review-thread-collapsible");
    if (!thread) return false;
    const header = thread.firstElementChild;
    return [...(header?.querySelectorAll(".Label") ?? [])].some((l) => /outdated/i.test(l.textContent));
  }

  // ---------- public ----------

  async function loadThread({ owner, repo, number, commentId, contextEl }) {
    const base = `/${owner}/${repo}/pull/${number}`;
    const [header, threadsFirst] = await Promise.all([
      cached(`${base}/page_data/header`, "json").catch(() => null),
      cached(`${base}/page_data/threads`, "json"),
    ]);
    let thread = findThread(threadsFirst, commentId);
    if (!thread) {
      // Posted after the cached copy: refetch once.
      thread = findThread(await cached(`${base}/page_data/threads`, "json", { fresh: true }), commentId);
    }
    if (!thread) throw new PageDataError("Could not find this comment in the pull request's review threads.", 404);

    const subjectType = String(thread.subjectType || "LINE").toLowerCase();
    let hunk = { diffHunk: "", line: null, side: null };
    if (subjectType !== "file") {
      try {
        const html = await cached(`${base}/threads/${thread.id}?rendering_on_files_tab=false`, "html");
        hunk = parseHunk(new DOMParser().parseFromString(html, "text/html"));
      } catch {
        // The code excerpt is optional; the comment text is what matters.
      }
    }

    const pr = header?.pullRequest ?? {};
    return {
      owner,
      repo,
      number: Number(number),
      prTitle: pr.title ?? document.querySelector(".js-issue-title, [data-testid='issue-title']")?.textContent.trim(),
      headRef: pr.headBranch,
      baseRef: pr.baseBranch,
      path: pathFromDom(contextEl) ?? pathFromThreadData(thread),
      subjectType,
      line: hunk.line,
      outdated: outdatedFromDom(contextEl),
      diffHunk: hunk.diffHunk,
      focusId: Number(commentId),
      comments: threadComments(thread),
    };
  }

  globalThis.GHPage = { loadThread, findThread, threadComments, parseHunk, pathFromDom, PageDataError };
})();
