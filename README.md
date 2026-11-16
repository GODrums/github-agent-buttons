# Agent Buttons for GitHub

Chrome extension (Manifest V3, no build step) that adds three icon buttons to every review thread on GitHub pull requests:

| Button | What it does |
|---|---|
| T3 Code logo | Opens `t3code://new?repo=owner/repo&prompt=…`. It opens as a draft in the matching project and does not run until you press Send. |
| Cursor logo | Opens `cursor://anysphere.cursor-deeplink/prompt?workspace=…&text=…`, which pre-fills the chat in the window whose folder matches. |
| Copy | Copies the full prompt to the clipboard. |

The prompt includes the PR, branch, file and line, the code the comment points at, the whole thread as the original markdown, the comment link and an instruction you can customise.

## Install

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick this folder.
2. The first time you click a T3 Code or Cursor button, Chrome asks whether github.com may open the app. Tick "Always allow".

No token is needed: the extension reads threads through github.com with the session you're signed in with, so any private or organization repo you can see works.

## Where the data comes from

All requests are same-origin from the content script, so they carry your GitHub session. These endpoints are what GitHub's own UI uses; they're undocumented and may change, so all knowledge of them is in `src/github-page.js`.

| Data | Source |
|---|---|
| Thread comments as markdown, authors, links | `GET /{owner}/{repo}/pull/{n}/page_data/threads` (headers `Accept: application/json`, `X-Requested-With: XMLHttpRequest`, `GitHub-Verified-Fetch: true`) |
| PR title, head and base branch | `GET …/page_data/header` |
| Code excerpt and commented line | `GET …/pull/{n}/threads/{threadId}?rendering_on_files_tab=false` (HTML diff table; the last row is the commented line) |
| File path | The page: the thread header link on the Conversation tab, or the enclosing file container on Files changed |

**Known gaps:** multi-line comments show only their last line (the start line isn't exposed), threads longer than 20 comments are cut off by GitHub, and a comment's file name is left out if the page doesn't show it.

## Where the buttons appear

- **Thread header bar** (`review-thread-collapsible`) on the Conversation and Files changed tabs, including collapsed and resolved threads.
- **First comment's header** when a thread has no header bar.
- **Next to the timestamp link** of any other review comment (fallback for GitHub's React-only views).

A `MutationObserver` re-adds buttons when GitHub navigates or re-renders a thread.

## Limits handled

- **T3 Code** refuses prompts over 8,000 characters. **Cursor** refuses links whose encoded text is over 10,000 characters. Long threads are shortened step by step: smaller code excerpt, then no code, then only first, focused and last comment, then shorter bodies. When that happens the full prompt is also copied.
- **Cursor** rejects invisible formatting characters (stripped) and anything matching its secret-theft filter, e.g. `.env` or "dump token". If only the code excerpt matches, the excerpt is dropped. If the comment itself matches, the prompt is copied instead and a toast explains why.
- **Cursor** decodes link parameters twice, so its text is double-encoded. Otherwise `+`, `&name=` and `%` in comments would be mangled.

## Development

```
npm test   # node >= 20, no dependencies
```

`src/prompt.js` holds the prompt and link logic (pure, unit-tested against copies of each app's link parser). `src/content.js` handles DOM placement and clicks. `src/github-page.js` reads threads from github.com's own endpoints. `options.html` and `src/options.js` are the settings page (instruction, T3 Code provider/model, Cursor folder mapping).

## License and trademarks

Code is MIT licensed, see [LICENSE](LICENSE).

T3 Code and Cursor are trademarks of their respective owners. This project is not affiliated with or endorsed by either of them. The button icons identify the app each button opens:

- `icons/t3code.png`: from [pingdotgg/t3code](https://github.com/pingdotgg/t3code) (`assets/prod/black-universal-1024.png`, MIT), resized.
- `icons/cursor.png`: the 2D dark app icon from Cursor's official [brand assets](https://cursor.com/brand), resized.
