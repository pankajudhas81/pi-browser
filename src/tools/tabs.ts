/**
 * Tab tools: list, new, select, close.
 *
 * Tabs are tracked per pi session. New tabs land in this session's
 * page list inside the shared browser context.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { browser } from "../browser";
import { captureSnapshot } from "../snapshot";

export const tabsList = defineTool({
    name: "browser_tabs_list",
    label: "Tabs",
    description:
        "List tabs owned by this pi session (index, url, title). The active tab has * next to its index.",
    parameters: Type.Object({}),
    async execute() {
        await browser.page(); // ensure browser is up
        const tabs = browser.listTabs();
        const titles = await Promise.all(tabs.map((t) => t.title));
        const active = browser.activeIndex();
        const lines = tabs.map((t, i) => {
            const marker = i === active ? "*" : " ";
            return `${marker} [${t.index}] ${titles[i]}  ${t.url}`;
        });
        return {
            content: [
                {
                    type: "text" as const,
                    text: lines.length ? lines.join("\n") : "(no tabs)",
                },
            ],
            details: { count: tabs.length, active },
        };
    },
});

export const tabsNew = defineTool({
    name: "browser_tabs_new",
    label: "New Tab",
    description:
        "Open a new tab. If url is given, navigate to it and return a snapshot; otherwise return an empty tab note.",
    parameters: Type.Object({
        url: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
        await browser.page();
        const p = await browser.newTab();
        if (params.url) {
            await p.goto(params.url, {
                waitUntil: "domcontentloaded",
                timeout: 30_000,
            });
            const snap = await captureSnapshot(p);
            return {
                content: [{ type: "text" as const, text: snap.text }],
                details: {
                    url: snap.url,
                    title: snap.title,
                    refs: snap.count,
                },
            };
        }
        const blankTitle = await p.title();
        return {
            content: [{ type: "text" as const, text: "Opened blank tab." }],
            details: { url: p.url(), title: blankTitle, refs: 0 },
        };
    },
});

export const tabsSelect = defineTool({
    name: "browser_tabs_select",
    label: "Select Tab",
    description:
        "Make the given tab index active. Subsequent tools act on this tab.",
    parameters: Type.Object({
        index: Type.Number(),
    }),
    async execute(_id, params) {
        await browser.page();
        browser.selectTab(params.index);
        const page = await browser.page();
        const snap = await captureSnapshot(page);
        return {
            content: [{ type: "text" as const, text: snap.text }],
            details: { url: snap.url, title: snap.title, refs: snap.count },
        };
    },
});

export const tabsClose = defineTool({
    name: "browser_tabs_close",
    label: "Close Tab",
    description: "Close a tab by index. The browser keeps running.",
    parameters: Type.Object({
        index: Type.Number(),
    }),
    async execute(_id, params) {
        await browser.page();
        await browser.closeTab(params.index);
        return {
            content: [
                { type: "text" as const, text: `Closed tab ${params.index}.` },
            ],
            details: { closedIndex: params.index },
        };
    },
});
