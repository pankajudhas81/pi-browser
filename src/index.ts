/**
 * Browser automation extension for pi.
 *
 * Spawns a single shared Chromium on first use, persists cookies and
 * logins under ~/.pi/agent/state/browser/profile, and exposes a
 * snapshot-driven tool surface. All concurrent pi sessions attach to
 * the same Chromium via CDP — fresh logins are visible everywhere.
 *
 * Tools (16):
 *   browser_navigate, browser_back, browser_forward, browser_wait_for
 *   browser_snapshot, browser_click, browser_type, browser_hover,
 *   browser_select, browser_upload
 *   browser_screenshot, browser_eval, browser_console
 *   browser_tabs_list, browser_tabs_new, browser_tabs_select, browser_tabs_close
 *
 * Commands:
 *   /browser-status   summary of the shared browser (endpoint, tabs)
 *   /browser-quit     terminate the shared Chromium across all pi sessions
 *   /browser-headless toggle headless mode for the next launch
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { browser } from "./browser";
import {
    click,
    hover,
    select,
    snapshot,
    type as typeTool,
    upload,
} from "./tools/dom";
import { consoleTool, evalScript, screenshot } from "./tools/io";
import { back, forward, navigate, waitFor } from "./tools/nav";
import { tabsClose, tabsList, tabsNew, tabsSelect } from "./tools/tabs";
import { shortError } from "./util";

const BROWSER_TOOLS = [
    navigate,
    back,
    forward,
    waitFor,
    snapshot,
    click,
    typeTool,
    hover,
    select,
    upload,
    screenshot,
    evalScript,
    consoleTool,
    tabsList,
    tabsNew,
    tabsSelect,
    tabsClose,
];

export default function (pi: ExtensionAPI) {
    pi.registerFlag("browser-headless", {
        description: "Launch the shared Chromium in headless mode",
        type: "boolean",
        default: false,
    });

    for (const tool of BROWSER_TOOLS) {
        pi.registerTool(tool);
    }

    pi.on("session_start", async (_event, ctx) => {
        if (pi.getFlag("browser-headless")) browser.setHeadless(true);
        const s = browser.status();
        if (s.connected && s.endpoint) {
            ctx.ui.setStatus("browser", footerLabel());
        }
    });

    pi.on("tool_execution_end", async (event, ctx) => {
        if (!event.toolName.startsWith("browser_")) return;
        ctx.ui.setStatus("browser", footerLabel());
    });

    pi.on("session_shutdown", async () => {
        // Disconnect this session's pages; shared Chromium stays up.
        await browser.detach();
    });

    pi.registerCommand("browser-status", {
        description: "Show shared Chromium status",
        handler: async (_args, ctx) => {
            const s = browser.status();
            if (!s.connected && !s.endpoint) {
                ctx.ui.notify(
                    "browser: not running. First browser_* tool call will launch it.",
                    "info",
                );
                return;
            }
            const ep = s.endpoint;
            const lines = [
                `connected: ${s.connected}`,
                `tabs (this session): ${s.tabs}`,
                ep ? `endpoint: ${ep.httpEndpoint} (pid ${ep.pid})` : "",
                ep ? `started: ${new Date(ep.startedAt).toISOString()}` : "",
                `headless: ${browser.isHeadless()}`,
            ].filter(Boolean);
            ctx.ui.notify(lines.join("\n"), "info");
        },
    });

    pi.registerCommand("browser-quit", {
        description:
            "Terminate the shared Chromium process (affects all pi sessions)",
        handler: async (_args, ctx) => {
            const ok = await ctx.ui.confirm(
                "browser-quit",
                "Kill the shared Chromium? This affects all running pi sessions.",
            );
            if (!ok) return;
            try {
                const r = await browser.quitShared();
                ctx.ui.notify(
                    r.killed
                        ? `browser: terminated (${r.reason})`
                        : `browser: ${r.reason}`,
                    r.killed ? "info" : "warning",
                );
                ctx.ui.setStatus("browser", undefined);
            } catch (e) {
                ctx.ui.notify(`browser-quit failed: ${shortError(e)}`, "error");
            }
        },
    });

    pi.registerCommand("browser-headless", {
        description: "Toggle headless mode for the next browser launch",
        handler: async (_args, ctx) => {
            const next = !browser.isHeadless();
            browser.setHeadless(next);
            ctx.ui.notify(
                `browser: headless=${next} (effective after /browser-quit + relaunch)`,
                "info",
            );
        },
    });
}

function footerLabel(): string {
    const s = browser.status();
    if (!s.connected) return "browser: off";
    return `browser: ${s.tabs} tab${s.tabs === 1 ? "" : "s"}`;
}
