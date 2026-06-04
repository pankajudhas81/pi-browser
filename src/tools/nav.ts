/**
 * Navigation tools: browser_navigate, browser_back, browser_forward,
 * browser_wait_for.
 */

import { StringEnum } from "@earendil-works/pi-ai"
import { defineTool } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { browser } from "../browser"
import { mutex } from "../mutex"
import { captureSnapshot } from "../snapshot"
import { shortError, withAbort } from "../util"

const NAV_TIMEOUT = 30_000

interface NavDetails {
    url: string
    title: string
    refs: number
}

export const navigate = defineTool({
    name: "browser_navigate",
    label: "Navigate",
    description:
        "Navigate the active tab to a URL and return a fresh accessibility snapshot with [ref=N] markers.",
    promptSnippet:
        "Open a URL in the shared browser and return a ref-tagged page snapshot",
    promptGuidelines: [
        "Use browser_navigate to open or change the page; never assume a URL is already loaded.",
    ],
    parameters: Type.Object({
        url: Type.String({ description: "Absolute URL to open." }),
    }),
    async execute(_id, params, signal) {
        const page = await browser.page()
        return mutex.run(page, async () => {
            try {
                await withAbort(
                    page.goto(params.url, {
                        waitUntil: "domcontentloaded",
                        timeout: NAV_TIMEOUT,
                    }),
                    signal,
                )
            } catch (e) {
                throw new Error(`navigate failed: ${shortError(e)}`)
            }
            const snap = await captureSnapshot(page)
            const details: NavDetails = {
                url: snap.url,
                title: snap.title,
                refs: snap.count,
            }
            return {
                content: [{ type: "text" as const, text: snap.text }],
                details,
            }
        })
    },
})

export const back = defineTool({
    name: "browser_back",
    label: "Back",
    description: "Go back one entry in browser history; returns a snapshot.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
        const page = await browser.page()
        return mutex.run(page, async () => {
            try {
                await withAbort(
                    page.goBack({
                        waitUntil: "domcontentloaded",
                        timeout: NAV_TIMEOUT,
                    }),
                    signal,
                )
            } catch (e) {
                throw new Error(`back failed: ${shortError(e)}`)
            }
            const snap = await captureSnapshot(page)
            return {
                content: [{ type: "text" as const, text: snap.text }],
                details: { url: snap.url, title: snap.title, refs: snap.count },
            }
        })
    },
})

export const forward = defineTool({
    name: "browser_forward",
    label: "Forward",
    description: "Go forward one entry in browser history; returns a snapshot.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
        const page = await browser.page()
        return mutex.run(page, async () => {
            try {
                await withAbort(
                    page.goForward({
                        waitUntil: "domcontentloaded",
                        timeout: NAV_TIMEOUT,
                    }),
                    signal,
                )
            } catch (e) {
                throw new Error(`forward failed: ${shortError(e)}`)
            }
            const snap = await captureSnapshot(page)
            return {
                content: [{ type: "text" as const, text: snap.text }],
                details: { url: snap.url, title: snap.title, refs: snap.count },
            }
        })
    },
})

export const waitFor = defineTool({
    name: "browser_wait_for",
    label: "Wait",
    description:
        "Wait for the page to reach a condition. Exactly one of text, urlContains, or load must be set. Returns a snapshot when satisfied.",
    parameters: Type.Object({
        text: Type.Optional(
            Type.String({
                description: "Substring that must appear in the page body.",
            }),
        ),
        urlContains: Type.Optional(
            Type.String({
                description: "Substring the current URL must contain.",
            }),
        ),
        load: Type.Optional(
            StringEnum(["load", "domcontentloaded", "networkidle"] as const, {
                description: "Load state to wait for.",
            }),
        ),
        timeoutMs: Type.Optional(
            Type.Number({
                description: "Override default 15s timeout.",
            }),
        ),
    }),
    async execute(_id, params, signal) {
        const page = await browser.page()
        const timeout = params.timeoutMs ?? 15_000
        return mutex.run(page, async () => {
            try {
                if (params.text) {
                    await withAbort(
                        page.waitForFunction(
                            (needle) =>
                                document.body?.innerText?.includes(needle) ===
                                true,
                            params.text,
                            { timeout },
                        ),
                        signal,
                    )
                } else if (params.urlContains) {
                    await withAbort(
                        page.waitForURL(
                            (u) => u.toString().includes(params.urlContains!),
                            { timeout },
                        ),
                        signal,
                    )
                } else if (params.load) {
                    await withAbort(
                        page.waitForLoadState(params.load, { timeout }),
                        signal,
                    )
                } else {
                    throw new Error(
                        "browser_wait_for: must set one of text, urlContains, or load",
                    )
                }
            } catch (e) {
                throw new Error(`wait_for failed: ${shortError(e)}`)
            }
            const snap = await captureSnapshot(page)
            return {
                content: [{ type: "text" as const, text: snap.text }],
                details: { url: snap.url, title: snap.title, refs: snap.count },
            }
        })
    },
})
