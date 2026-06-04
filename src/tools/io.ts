/**
 * I/O tools: browser_screenshot, browser_eval, browser_console.
 */

import {
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_LINES,
    defineTool,
    formatSize,
    truncateTail,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { browser } from "../browser"
import { mutex } from "../mutex"
import { refs } from "../refs"
import { shortError, withAbort } from "../util"

export const screenshot = defineTool({
    name: "browser_screenshot",
    label: "Screenshot",
    description:
        "Take a PNG screenshot of the active tab (viewport, full page, or a single element by ref). Returns the image to the model.",
    promptSnippet:
        "Capture a PNG of the active tab; prefer browser_snapshot for text content",
    promptGuidelines: [
        "Use browser_screenshot only when visual layout matters; for content or actionable elements use browser_snapshot.",
    ],
    parameters: Type.Object({
        fullPage: Type.Optional(
            Type.Boolean({
                description: "Capture the full scrollable page.",
            }),
        ),
        ref: Type.Optional(
            Type.Number({
                description:
                    "If set, screenshot only that element from the latest snapshot.",
            }),
        ),
    }),
    async execute(_id, params, signal) {
        const page = await browser.page()
        return mutex.run(page, async () => {
            try {
                let buf: Buffer
                if (params.ref !== undefined) {
                    const record = refs.require(page, params.ref)
                    buf = await withAbort(
                        page.locator(record.selector).first().screenshot({
                            type: "png",
                            timeout: 15_000,
                        }),
                        signal,
                    )
                } else {
                    buf = await withAbort(
                        page.screenshot({
                            type: "png",
                            fullPage: params.fullPage ?? false,
                            timeout: 30_000,
                        }),
                        signal,
                    )
                }
                return {
                    content: [
                        {
                            type: "image" as const,
                            data: buf.toString("base64"),
                            mimeType: "image/png",
                        },
                    ],
                    details: {
                        url: page.url(),
                        bytes: buf.byteLength,
                        size: formatSize(buf.byteLength),
                        fullPage: params.fullPage ?? false,
                        ref: params.ref,
                    },
                }
            } catch (e) {
                throw new Error(`screenshot failed: ${shortError(e)}`)
            }
        })
    },
})

export const evalScript = defineTool({
    name: "browser_eval",
    label: "Evaluate JS",
    description:
        "Run a JavaScript expression in the active page context. To run statements or async code, wrap in an IIFE: `(() => { ... })()` or `(async () => { ... })()`. Return value is JSON-serialized; non-serializable values become strings.",
    promptSnippet:
        "Run JS in the page (gated). Use for data extraction beyond snapshots.",
    promptGuidelines: [
        "Use browser_eval sparingly \u2014 prefer browser_snapshot + structured tools when possible.",
        "browser_eval executes arbitrary JS in the active page and is confirm-gated.",
    ],
    parameters: Type.Object({
        script: Type.String({
            description:
                "JS expression evaluated in the page. For functions/statements wrap as IIFE. Examples: `document.title`, `(() => document.title)()`, `(async () => (await fetch('/api')).status)()`.",
        }),
    }),
    async execute(_id, params, signal) {
        const page = await browser.page()
        return mutex.run(page, async () => {
            try {
                // Playwright evaluates the string in the page context, not
                // in our node process. The risk surface is the page itself,
                // not pi, and the call is confirm-gated upstream.
                const value = (await withAbort(
                    page.evaluate(params.script) as Promise<unknown>,
                    signal,
                )) as unknown
                const text = stringifySafe(value)
                return {
                    content: [{ type: "text" as const, text }],
                    details: { url: page.url(), bytes: text.length },
                }
            } catch (e) {
                throw new Error(`eval failed: ${shortError(e)}`)
            }
        })
    },
})

interface ConsoleEntry {
    level: string
    text: string
    url: string
    ts: number
}

export const consoleTool = defineTool({
    name: "browser_console",
    label: "Console",
    description:
        "Return recent console + pageerror messages from the active tab (most recent last). Optionally clear the buffer.",
    parameters: Type.Object({
        clear: Type.Optional(Type.Boolean()),
        limit: Type.Optional(
            Type.Number({ description: "Max entries (default 50)." }),
        ),
    }),
    async execute(_id, params) {
        const page = await browser.page()
        const all = browser.consoleBuffer(page)
        const limit = Math.max(1, Math.min(200, params.limit ?? 50))
        const entries: ConsoleEntry[] = all.slice(-limit)
        if (params.clear) browser.clearConsole(page)
        const raw = entries
            .map(
                (e) =>
                    `[${new Date(e.ts).toISOString()}] ${e.level}: ${e.text}`,
            )
            .join("\n")
        const truncation = truncateTail(raw, {
            maxLines: DEFAULT_MAX_LINES,
            maxBytes: DEFAULT_MAX_BYTES,
        })
        let body = truncation.content || "(no console messages)"
        if (truncation.truncated) {
            body += `\n\n[Console buffer truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines]`
        }
        return {
            content: [{ type: "text" as const, text: body }],
            details: {
                url: page.url(),
                entries: entries.length,
                cleared: params.clear === true,
            },
        }
    },
})

function stringifySafe(value: unknown): string {
    if (value === undefined) return "undefined"
    if (value === null) return "null"
    if (typeof value === "string") return value
    if (typeof value === "number" || typeof value === "boolean")
        return String(value)
    try {
        return JSON.stringify(value, null, 2) ?? String(value)
    } catch {
        return String(value)
    }
}
