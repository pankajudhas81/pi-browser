# Agent Guidelines — pi-browser

## Overview

Pi extension that registers Playwright-backed browser tools. A single shared
Chromium is spawned on first use and persists logins under
`~/.pi/agent/state/browser/profile`. All concurrent pi sessions attach over
CDP, so a fresh login is visible everywhere.

## Rules

- 4-space indentation, 80-char line width
- Format before commit: `pnpm lint:fix`
- Never commit secrets or credentials
- Keep the extension entry in `src/index.ts`
- Keep the skill in `skills/browser/SKILL.md`

## Architecture

```
src/index.ts        Extension entry: registers tools + commands
src/browser.ts      Shared Chromium lifecycle (spawn, CDP attach, profile)
src/snapshot.ts     Accessibility-tree snapshot + [ref=N] tagging
src/refs.ts         Ref registry mapping [ref=N] to DOM handles
src/mutex.ts        Cross-session lock for the shared browser
src/util.ts         Helpers
src/tools/          Tool groups: nav, io, dom, tabs
skills/browser/     Skill teaching the snapshot/ref interaction loop
```

## Key patterns

- Only `playwright` is a real dependency; pi SDK packages
  (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `typebox`)
  are peer dependencies provided by pi — never bundle them
- Tools operate on a snapshot → ref → act → re-snapshot loop; refs from an
  earlier snapshot may be stale
- `build` runs `tsc` as a type-check (`noEmit`); pi loads `src/index.ts`
  directly, so no compiled output is shipped
