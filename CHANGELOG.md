# Changelog

## 0.1.0

### Features

- Initial release. Browser automation tools for pi via Playwright.
- Spawns a single shared Chromium on first use and persists cookies and
  logins under `~/.pi/agent/state/browser/profile`; all concurrent pi
  sessions attach to the same Chromium over CDP, so a fresh login is
  visible everywhere.
- Snapshot-driven tool surface: `browser_navigate`, `browser_back`,
  `browser_forward`, `browser_wait_for`, `browser_snapshot`,
  `browser_click`, `browser_type`, `browser_hover`, `browser_select`,
  `browser_upload`, `browser_screenshot`, `browser_eval`,
  `browser_console`, and tab management
  (`browser_tabs_list`/`new`/`select`/`close`).
- Commands: `/browser-status`, `/browser-quit`, `/browser-headless`.
- Ships the `browser` skill teaching the snapshot → ref → act →
  re-snapshot interaction loop.
