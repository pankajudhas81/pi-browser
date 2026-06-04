/**
 * DOM-interaction tools: snapshot, click, type, hover, select, upload.
 *
 * All actions resolve a ref through the per-page refs table to a CSS
 * selector captured by the most recent snapshot. Stale refs error out
 * with a clear message asking for a fresh snapshot.
 */

import { resolve as resolvePath } from "node:path"
import { defineTool } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { browser } from "../browser"
import { mutex } from "../mutex"
import { refs } from "../refs"
import { captureSnapshot } from "../snapshot"
import { shortError, withAbort } from "../util"

const ACT_TIMEOUT = 15_000

interface ActDetails {
    action: string
    ref?: number
    targetRole?: string
    targetName?: string
    url: string
    title: string
    refs: number
}

export const snapshot = defineTool({
    name: "browser_snapshot",
    label: "Snapshot",
    description:
        "Capture an accessibility-tree snapshot of the active tab. Each interactive node gets a stable [ref=N] valid until the next browser action.",
    promptSnippet:
        "Snapshot the active page; returns YAML-ish tree with [ref=N] markers used by click/type/etc.",
    promptGuidelines: [
        "Always call browser_snapshot before browser_click/browser_type/browser_hover/browser_select; refs from earlier snapshots may be stale.",
        "Use browser_snapshot rather than browser_screenshot when you only need page structure \u2014 it's far cheaper.",
    ],
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
        const page = await browser.page()
        return mutex.run(page, async () => {
            const snap = await withAbort(captureSnapshot(page), signal)
            return {
                content: [{ type: "text" as const, text: snap.text }],
                details: {
                    action: "snapshot",
                    url: snap.url,
                    title: snap.title,
                    refs: snap.count,
                } satisfies ActDetails,
            }
        })
    },
})

async function actOnRef(
    ref: number,
    signal: AbortSignal | undefined,
    fn: (sel: string) => Promise<void>,
    action: string,
) {
    const page = await browser.page()
    return mutex.run(page, async () => {
        const record = refs.require(page, ref)
        try {
            await withAbort(fn(record.selector), signal)
        } catch (e) {
            throw new Error(`${action} failed on ref=${ref}: ${shortError(e)}`)
        }
        // Many actions trigger navigation or DOM rerender; wait briefly
        // and re-snapshot.
        await page.waitForLoadState("domcontentloaded").catch(() => {})
        const snap = await captureSnapshot(page)
        return {
            content: [{ type: "text" as const, text: snap.text }],
            details: {
                action,
                ref,
                targetRole: record.role,
                targetName: record.name,
                url: snap.url,
                title: snap.title,
                refs: snap.count,
            } satisfies ActDetails,
        }
    })
}

export const click = defineTool({
    name: "browser_click",
    label: "Click",
    description:
        "Click an element by ref from the latest browser_snapshot. Returns a fresh snapshot.",
    promptSnippet: "Click element by ref id from the latest snapshot",
    parameters: Type.Object({
        ref: Type.Number({ description: "Ref id from browser_snapshot." }),
    }),
    async execute(_id, params, signal) {
        const page = await browser.page()
        return actOnRef(
            params.ref,
            signal,
            (sel) => page.locator(sel).first().click({ timeout: ACT_TIMEOUT }),
            "click",
        )
    },
})

export const type = defineTool({
    name: "browser_type",
    label: "Type",
    description:
        "Focus an input/textarea by ref and type text. Optionally press Enter to submit. Returns a fresh snapshot.",
    promptSnippet:
        "Type text into a textbox by ref; optional submit presses Enter",
    parameters: Type.Object({
        ref: Type.Number(),
        text: Type.String(),
        submit: Type.Optional(
            Type.Boolean({
                description: "Press Enter after typing.",
            }),
        ),
        clear: Type.Optional(
            Type.Boolean({
                description: "Clear the field before typing (default true).",
            }),
        ),
    }),
    async execute(_id, params, signal) {
        const page = await browser.page()
        const clear = params.clear ?? true
        return actOnRef(
            params.ref,
            signal,
            async (sel) => {
                const loc = page.locator(sel).first()
                if (clear) await loc.fill("", { timeout: ACT_TIMEOUT })
                await loc.pressSequentially(params.text, {
                    timeout: ACT_TIMEOUT,
                })
                if (params.submit) await loc.press("Enter")
            },
            "type",
        )
    },
})

export const hover = defineTool({
    name: "browser_hover",
    label: "Hover",
    description:
        "Hover over an element by ref. Useful for revealing menus and tooltips.",
    parameters: Type.Object({
        ref: Type.Number(),
    }),
    async execute(_id, params, signal) {
        const page = await browser.page()
        return actOnRef(
            params.ref,
            signal,
            (sel) => page.locator(sel).first().hover({ timeout: ACT_TIMEOUT }),
            "hover",
        )
    },
})

export const select = defineTool({
    name: "browser_select",
    label: "Select",
    description:
        "Choose one or more options in a <select> element by visible label or value.",
    parameters: Type.Object({
        ref: Type.Number(),
        values: Type.Array(Type.String(), {
            description:
                "Option values or labels to select (single-select uses first).",
        }),
    }),
    async execute(_id, params, signal) {
        const page = await browser.page()
        return actOnRef(
            params.ref,
            signal,
            async (sel) => {
                await page
                    .locator(sel)
                    .first()
                    .selectOption(params.values, { timeout: ACT_TIMEOUT })
            },
            "select",
        )
    },
})

export const upload = defineTool({
    name: "browser_upload",
    label: "Upload",
    description:
        "Attach local files to an <input type=file> element by ref. Paths are resolved against pi's cwd.",
    parameters: Type.Object({
        ref: Type.Number(),
        paths: Type.Array(Type.String(), {
            description: "Local file paths to attach.",
        }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
        const page = await browser.page()
        const abs = params.paths.map((p) => resolvePath(ctx.cwd, p))
        return actOnRef(
            params.ref,
            signal,
            async (sel) => {
                await page
                    .locator(sel)
                    .first()
                    .setInputFiles(abs, { timeout: ACT_TIMEOUT })
            },
            "upload",
        )
    },
})
