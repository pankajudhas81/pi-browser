# @pankajudhas81/pi-browser

Browser automation tools for [pi](https://pi.dev) via Playwright. Spawns a
single shared Chromium on first use, persists cookies and logins, and exposes
a snapshot-driven tool surface. All concurrent pi sessions attach to the same
Chromium over CDP — a fresh login is visible everywhere.

## Install

```bash
pi install npm:@pankajudhas81/pi-browser
```

Or reference a local checkout in `settings.json`:

```json
{
    "packages": ["/absolute/path/to/pi-browser"]
}
```

## Prerequisites

- [pi](https://pi.dev) installed
- Chromium is downloaded by Playwright on first launch

## Tools

| Tool | Purpose |
| --- | --- |
| `browser_navigate` / `browser_back` / `browser_forward` | Navigation |
| `browser_wait_for` | Wait for text, URL, or load state |
| `browser_snapshot` | Accessibility-tree snapshot with `[ref=N]` markers |
| `browser_click` / `browser_type` / `browser_hover` / `browser_select` | Interaction |
| `browser_upload` | Attach files to a file input |
| `browser_screenshot` | PNG of viewport, full page, or element |
| `browser_eval` / `browser_console` | Run JS / read console + page errors |
| `browser_tabs_list` / `browser_tabs_new` / `browser_tabs_select` / `browser_tabs_close` | Tab management |

## Commands

| Command | Description |
| --- | --- |
| `/browser-status` | Summary of the shared browser (endpoint, tabs) |
| `/browser-quit` | Terminate the shared Chromium across all pi sessions |
| `/browser-headless` | Toggle headless mode for the next launch |

## Skill

The `browser` skill teaches the snapshot → ref → act → re-snapshot loop,
login flow with the persistent profile, and when to screenshot vs snapshot.

## License

MIT
