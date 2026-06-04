---
description: Use the browser_* tools to read, interact with, and verify web pages. Driven by snapshot → ref → act → re-snapshot loop. Trigger when the user mentions a URL, asks to log in / fill a form / click / scrape a page / verify UI, or when a task can only be completed by interacting with a real website. Skill explains the snapshot/ref model, when to screenshot vs snapshot, login flow with the persistent profile, and common pitfalls.
---

# browser — Pi's Web Automation Tools

These tools drive a shared Chromium instance that survives across all pi
sessions. Logins, cookies, and localStorage persist between sessions because
every session attaches to the same `--user-data-dir`.

## The core loop

```
browser_navigate(url)        # opens the page, returns a snapshot
  ↓
browser_snapshot()           # re-snapshot whenever DOM may have changed
  ↓
browser_click(ref=N)         # act using a ref from the latest snapshot
  ↓
… returns a new snapshot     # refs from before this call are now stale
```

**Refs are valid only until the next browser action.** Every action returns
a fresh snapshot, so you can chain `navigate → click → type` without calling
`browser_snapshot` between them. Call `browser_snapshot` only when:

- A page changes via JS without you triggering it (timers, XHR redraws).
- You're starting work on a tab you didn't just act on.
- The previous tool reported a stale-ref error.

## Snapshot format

```
url: https://example.com
title: Example Domain
interactive: 5

- heading "Example Domain" [ref=1]
- link "More information..." href="https://www.iana.org/..." [ref=2]
- form [ref=3]
  - textbox "(Email)" [ref=4]
  - button "Sign in" [ref=5]
```

Each interactive node carries a `[ref=N]`. Pass that integer to
`browser_click`, `browser_type`, `browser_hover`, `browser_select`,
`browser_upload`, or `browser_screenshot`.

## When to snapshot vs screenshot

- **`browser_snapshot`** — default. Text-only, cheap, gives you refs.
- **`browser_screenshot`** — only when visual layout matters (e.g. user asks
  "does this look right?" or you need to verify a chart rendered). Costs
  many tokens; use sparingly. Use `ref` to crop to a single element.

## Logging in

Pi launches Chromium headed by default so the user can complete login
flows you can't (CAPTCHAs, 2FA, password managers). Typical pattern:

1. `browser_navigate("https://app.example.com/login")`
2. Inspect snapshot; if you can fill the form, do so.
3. If 2FA or CAPTCHA appears, tell the user: _"A login screen is open in
   the shared browser — please complete login, then say 'continue'."_
4. After the user proceeds, call `browser_snapshot` and continue.

The session persists, so subsequent pi runs are already logged in.

## `browser_eval` — confirm-gated

Runs raw JS in the page. The user is prompted to approve every call.
Use only when snapshot + structured tools can't do the job (e.g. dumping
a complex client-side data structure). Always wrap multi-statement code
in an IIFE:

- ✅ `document.title`
- ✅ `(() => Array.from(document.querySelectorAll('.row')).map(r => r.innerText))()`
- ✅ `(async () => (await fetch('/api/me')).status)()`
- ❌ `async () => document.title` (returns the function itself, doesn't run it)

## Tabs

Tabs are scoped to your pi session. New tabs are visible only to you.
Other concurrent pi sessions share the browser but not your tab list.

- `browser_tabs_list` — see your tabs + active tab marker
- `browser_tabs_new(url?)` — open new tab
- `browser_tabs_select(index)` — switch active tab
- `browser_tabs_close(index)` — close one tab

## Pitfalls

- **Acting on a stale ref.** The tool will say "stale or unknown ref=N".
  Call `browser_snapshot` and use the new refs.
- **Waiting on slow pages.** Use `browser_wait_for({text: "..."})` or
  `browser_wait_for({load: "networkidle"})` after navigation that triggers
  client-side rendering.
- **Looking for content not in the snapshot.** The snapshot includes
  interactive elements, headings, and landmarks. To dump raw text use
  `browser_eval` with something like `document.body.innerText`.
- **Multiple matching elements.** Refs are unique per snapshot; if you
  need a specific one of N similar buttons, look at the surrounding
  context in the snapshot tree (parent landmark, nearby text) to pick
  the right ref.
- **Killing the browser.** Don't. The user runs `/browser-quit` when
  they want the shared Chromium gone. Closing your own tabs is fine.

## Status & control

- `/browser-status` — show endpoint, pid, tab count
- `/browser-quit` — terminate the shared Chromium (affects all pi sessions)
- `/browser-headless` — toggle headless for the next launch
