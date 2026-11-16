// Injects "address in T3 Code / Cursor / copy prompt" buttons into PR review
// comment threads on github.com.
(() => {
  const AAB = globalThis.AAB;
  const GHPage = globalThis.GHPage;

  // Versions up to 0.2 stored a GitHub token; it is no longer used.
  chrome.storage.local.remove("githubToken").catch(() => {});
  const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/;
  const PERMALINK = /#(?:discussion_)?r(\d+)$/;

  const ICONS = {
    t3: chrome.runtime.getURL("icons/t3code.png"),
    cursor: chrome.runtime.getURL("icons/cursor.png"),
  };
  const SVG_COPY =
    '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>';
  const SVG_CHECK =
    '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>';

  const TOOLBAR_CSS = `
    :host { display: inline-flex; align-self: center; flex-shrink: 0; margin-left: 4px; vertical-align: middle; }
    .bar { display: inline-flex; gap: 2px; align-items: center; }
    button {
      all: unset; box-sizing: border-box; cursor: pointer;
      width: 26px; height: 26px; border-radius: 6px;
      display: inline-flex; align-items: center; justify-content: center;
      color: var(--fgColor-muted, #59636e);
      transition: background-color 80ms ease;
    }
    button:hover { background: var(--control-transparent-bgColor-hover, rgba(129, 139, 152, 0.15)); color: var(--fgColor-default, #1f2328); }
    button:active { background: var(--control-transparent-bgColor-active, rgba(129, 139, 152, 0.25)); }
    button:focus-visible { outline: 2px solid var(--focus-outlineColor, #0969da); outline-offset: -2px; }
    button[aria-busy="true"] { opacity: 0.5; cursor: progress; }
    button.done { color: var(--fgColor-success, #1a7f37); }
    img { width: 16px; height: 16px; border-radius: 4px; display: block; }
    svg { fill: currentColor; display: block; }
  `;

  // ---------- PR context ----------

  function prContext() {
    const m = PR_PATH.exec(location.pathname);
    return m ? { owner: m[1], repo: m[2], number: m[3] } : null;
  }

  // ---------- data ----------

  const pending = new Map(); // commentId -> Promise<response>

  async function loadThread(pr, commentId, contextEl) {
    try {
      return { ok: true, data: await GHPage.loadThread({ ...pr, commentId, contextEl }) };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }

  function fetchThread(commentId, contextEl) {
    const pr = prContext();
    if (!pr) return Promise.resolve({ ok: false, error: "Not on a pull request page." });
    const key = `${pr.owner}/${pr.repo}#${pr.number}:${commentId}`;
    let p = pending.get(key);
    if (!p) {
      p = loadThread(pr, commentId, contextEl);
      pending.set(key, p);
      p.then((r) => {
        if (!r.ok) pending.delete(key);
        else setTimeout(() => pending.delete(key), 60_000);
      });
    }
    return p;
  }

  function getSettings() {
    return chrome.storage.sync.get({ instruction: "", t3Provider: "", t3Model: "", cursorWorkspaces: "" });
  }

  // ---------- actions ----------

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    }
  }

  function launch(url) {
    window.location.href = url;
  }

  const APP_NAME = { t3: "T3 Code", cursor: "Cursor" };

  async function run(target, commentId, button, host) {
    if (button.getAttribute("aria-busy") === "true") return;
    button.setAttribute("aria-busy", "true");
    try {
      const res = await fetchThread(commentId, host);
      if (!res.ok) {
        toast(res.error);
        return;
      }
      const settings = await getSettings();
      const data = res.data;
      const r = AAB.promptFor(target, data, { instruction: settings.instruction });

      if (target === "copy") {
        if (await copyText(r.prompt)) flashDone(button);
        else toast("Could not write to the clipboard.");
        return;
      }

      if (!r.prompt) {
        const copied = await copyText(r.full);
        const why = r.blocked
          ? "Cursor refuses prompts that mention .env, tokens or passwords, even in code."
          : `This thread is too long for a ${APP_NAME[target]} link.`;
        toast(copied ? `${why} The prompt is on your clipboard instead.` : `${why} Copying it also failed.`);
        return;
      }

      const url =
        target === "t3"
          ? AAB.t3Url(r.prompt, {
              owner: data.owner,
              repo: data.repo,
              provider: settings.t3Provider.trim(),
              model: settings.t3Model.trim(),
            })
          : AAB.cursorUrl(r.prompt, { workspace: AAB.cursorWorkspace(data.owner, data.repo, settings.cursorWorkspaces) });

      if (r.truncated) {
        await copyText(r.full);
        toast(`Shortened the prompt to fit ${APP_NAME[target]}'s link limit. The full prompt is on your clipboard.`);
      }
      launch(url);
    } finally {
      button.removeAttribute("aria-busy");
    }
  }

  function flashDone(button) {
    const original = button.innerHTML;
    button.innerHTML = SVG_CHECK;
    button.classList.add("done");
    setTimeout(() => {
      button.innerHTML = original;
      button.classList.remove("done");
    }, 1500);
  }

  // ---------- toast ----------

  let toastHost = null;
  let toastTimer = null;

  function toast(message) {
    if (!toastHost) {
      toastHost = document.createElement("div");
      toastHost.setAttribute("data-aab-toast", "");
      const root = toastHost.attachShadow({ mode: "open" });
      root.innerHTML = `<style>
        .t { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; max-width: min(420px, calc(100vw - 32px));
             display: none; padding: 10px 12px; border-radius: 8px;
             font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
             color: var(--fgColor-onEmphasis, #fff); background: var(--bgColor-emphasis, #25292e);
             box-shadow: 0 8px 24px rgba(0,0,0,.2); }
        .t.show { display: block; }
      </style><div class="t" role="status" aria-live="polite"></div>`;
      document.body.append(toastHost);
    }
    const box = toastHost.shadowRoot.querySelector(".t");
    box.textContent = message;
    box.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => box.classList.remove("show"), 6000);
  }

  // ---------- toolbar ----------

  function makeToolbar(commentId) {
    const host = document.createElement("span");
    host.setAttribute("data-aab-host", commentId);
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${TOOLBAR_CSS}</style>
      <span class="bar">
        <button type="button" data-target="t3" title="Address in T3 Code" aria-label="Address this comment in T3 Code"><img src="${ICONS.t3}" alt=""></button>
        <button type="button" data-target="cursor" title="Address in Cursor" aria-label="Address this comment in Cursor"><img src="${ICONS.cursor}" alt=""></button>
        <button type="button" data-target="copy" title="Copy as prompt" aria-label="Copy this comment as a prompt">${SVG_COPY}</button>
      </span>`;
    const stop = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    root.querySelectorAll("button").forEach((b) => {
      b.addEventListener("click", (e) => {
        stop(e);
        run(b.dataset.target, commentId, b, host);
      });
      b.addEventListener("mousedown", (e) => e.stopPropagation());
    });
    // Warm the cache so the click acts within the browser's user-gesture window.
    host.addEventListener("pointerenter", () => fetchThread(commentId, host), { once: true });
    host.addEventListener("focusin", () => fetchThread(commentId, host), { once: true });
    host.addEventListener("click", (e) => e.stopPropagation());
    return host;
  }

  // ---------- placement ----------

  function commentIdOf(el) {
    return /^discussion_r(\d+)$/.exec(el?.id || "")?.[1] ?? null;
  }

  function threadRootId(thread) {
    const hidden = thread.dataset.hiddenCommentIds;
    if (hidden) return hidden.split(",")[0].trim() || null;
    return commentIdOf(thread.querySelector('[id^="discussion_r"]:not([id$="-permalink"])'));
  }

  // Threads rendered as <review-thread-collapsible> on both the Conversation
  // and the classic Files changed tab.
  function placeInThread(thread) {
    if (thread.querySelector("[data-aab-host]")) return;
    const id = threadRootId(thread);
    if (!id) return;

    const header = [...thread.children].find((c) =>
      c.querySelector(':scope > [data-target="review-thread-collapsible.button"]'),
    );
    if (header) {
      header.append(makeToolbar(id));
      return;
    }

    const first = thread.querySelector(`#discussion_r${id}`);
    if (!first) return;
    const classicActions = first.querySelector(".timeline-comment-actions");
    if (classicActions) {
      classicActions.after(makeToolbar(id));
      return;
    }
    const reactActions = first.querySelector('[data-testid="comment-header-right-side-items"]');
    if (reactActions) {
      reactActions.prepend(makeToolbar(id));
      return;
    }
    const stamp = timestampLinks(first)[0];
    if (stamp) stamp.after(makeToolbar(id));
  }

  function timestampLinks(scope) {
    return [...scope.querySelectorAll('a[href*="#discussion_r"], a[href*="#r"]')].filter(
      (a) => PERMALINK.test(a.getAttribute("href") || "") && a.querySelector("relative-time"),
    );
  }

  // Anything else that links to a review comment by its timestamp, e.g. the
  // React "Files changed" experience. One toolbar per comment.
  function placeByPermalink(scope) {
    for (const a of timestampLinks(scope)) {
      if (a.closest("review-thread-collapsible, .markdown-body, .comment-body, [data-aab-host]")) continue;
      if (a.parentElement?.querySelector(":scope > [data-aab-host]")) continue;
      const id = PERMALINK.exec(a.getAttribute("href"))[1];
      a.after(makeToolbar(id));
    }
  }

  function scan() {
    if (!prContext()) return;
    document.querySelectorAll("review-thread-collapsible").forEach(placeInThread);
    placeByPermalink(document);
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      scan();
    });
  }

  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("turbo:load", schedule);
  scan();
})();
