/**
 * Shared-Chromium session manager.
 *
 * Architecture: a single long-lived Chromium process is spawned
 * detached on first use, with `--remote-debugging-port=0` and a
 * persistent --user-data-dir. The DevTools http endpoint is recorded
 * to ENDPOINT_FILE, and every pi session attaches via CDP.
 *
 * Each pi session owns its own pages (tabs) inside the shared
 * browser. session_shutdown closes only this session's pages; the
 * Chromium process keeps running so concurrent / later pi sessions
 * inherit cookies and logins. The `/browser-quit` command actually
 * kills the shared process.
 *
 * Lock model: a single launcher wins via O_EXCL lockfile creation,
 * losers poll the endpoint file until the winner finishes.
 */

import { spawn } from "node:child_process"
import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    readSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs"
import {
    type Browser,
    type BrowserContext,
    chromium,
    type Page,
} from "playwright"
import {
    ENDPOINT_FILE,
    LOCK_FILE,
    LOG_FILE,
    PROFILE_DIR,
    STATE_DIR,
    sleep,
} from "./util"

interface ConsoleMsg {
    level: string
    text: string
    url: string
    ts: number
}

interface EndpointFile {
    httpEndpoint: string
    wsEndpoint: string
    port: number
    pid: number
    startedAt: number
}

const CONSOLE_BUF_LIMIT = 200

class BrowserSession {
    private browser?: Browser
    private ctx?: BrowserContext
    private pages: Page[] = []
    private activeIdx = 0
    private wired = new WeakSet<Page>()
    private consoleBufs = new WeakMap<Page, ConsoleMsg[]>()
    private headless = false

    setHeadless(value: boolean): void {
        this.headless = value
    }

    isHeadless(): boolean {
        return this.headless
    }

    async ensure(): Promise<void> {
        if (this.browser?.isConnected()) return

        mkdirSync(STATE_DIR, { recursive: true })
        mkdirSync(PROFILE_DIR, { recursive: true })

        // Up to 30s waiting for endpoint to become reachable (launch + race).
        const deadline = Date.now() + 30_000
        let attemptedSpawn = false

        while (Date.now() < deadline) {
            const ep = readEndpoint()
            if (ep && (await isReachable(ep.httpEndpoint))) {
                this.browser = await chromium.connectOverCDP(ep.httpEndpoint)
                this.attachContext()
                return
            }

            if (!attemptedSpawn && this.tryAcquireLock()) {
                attemptedSpawn = true
                try {
                    const ep2 = await spawnChromium(this.headless)
                    writeEndpoint(ep2)
                    this.browser = await chromium.connectOverCDP(
                        ep2.httpEndpoint,
                    )
                    this.attachContext()
                    return
                } finally {
                    this.releaseLock()
                }
            }

            await sleep(200)
        }

        throw new Error(
            "browser: timed out waiting for shared Chromium endpoint",
        )
    }

    private attachContext(): void {
        if (!this.browser) throw new Error("browser not connected")
        const contexts = this.browser.contexts()
        // For connectOverCDP into a persistent context the existing
        // context is index 0. Reuse it so cookies/storage persist.
        this.ctx =
            contexts[0] ??
            this.browser.contexts()[0] ??
            // Defensive fallback — should not happen with persistent
            // contexts but keeps types honest.
            undefined
        if (!this.ctx) {
            throw new Error(
                "browser: no context available from shared Chromium",
            )
        }
    }

    async page(): Promise<Page> {
        await this.ensure()
        if (this.pages[this.activeIdx]?.isClosed()) {
            this.pages.splice(this.activeIdx, 1)
            this.activeIdx = Math.max(0, this.activeIdx - 1)
        }
        if (!this.pages.length) {
            const ctx = this.requireCtx()
            const p = await ctx.newPage()
            this.wirePage(p)
            this.pages.push(p)
            this.activeIdx = 0
        }
        return this.pages[this.activeIdx]!
    }

    requireCtx(): BrowserContext {
        if (!this.ctx) throw new Error("browser: context not attached")
        return this.ctx
    }

    async newTab(): Promise<Page> {
        const ctx = this.requireCtx()
        const p = await ctx.newPage()
        this.wirePage(p)
        this.pages.push(p)
        this.activeIdx = this.pages.length - 1
        return p
    }

    listTabs(): { index: number; url: string; title: Promise<string> }[] {
        return this.pages
            .filter((p) => !p.isClosed())
            .map((p, i) => ({
                index: i,
                url: p.url(),
                title: p.title().catch(() => ""),
            }))
    }

    activeIndex(): number {
        if (!this.pages.length) return -1
        return this.activeIdx
    }

    selectTab(index: number): void {
        if (index < 0 || index >= this.pages.length) {
            throw new Error(`tab index out of range: ${index}`)
        }
        if (this.pages[index]?.isClosed()) {
            throw new Error(`tab ${index} is closed`)
        }
        this.activeIdx = index
    }

    async closeTab(index: number): Promise<void> {
        if (index < 0 || index >= this.pages.length) {
            throw new Error(`tab index out of range: ${index}`)
        }
        const p = this.pages[index]!
        await p.close({ runBeforeUnload: false }).catch(() => {})
        this.pages.splice(index, 1)
        if (this.activeIdx >= this.pages.length) {
            this.activeIdx = Math.max(0, this.pages.length - 1)
        }
    }

    consoleBuffer(page: Page): ConsoleMsg[] {
        return this.consoleBufs.get(page) ?? []
    }

    clearConsole(page: Page): void {
        this.consoleBufs.set(page, [])
    }

    private wirePage(page: Page): void {
        if (this.wired.has(page)) return
        this.wired.add(page)
        this.consoleBufs.set(page, [])
        page.on("console", (msg) => {
            const buf = this.consoleBufs.get(page)
            if (!buf) return
            buf.push({
                level: msg.type(),
                text: msg.text().slice(0, 2000),
                url: page.url(),
                ts: Date.now(),
            })
            if (buf.length > CONSOLE_BUF_LIMIT) {
                buf.splice(0, buf.length - CONSOLE_BUF_LIMIT)
            }
        })
        page.on("pageerror", (err) => {
            const buf = this.consoleBufs.get(page)
            if (!buf) return
            buf.push({
                level: "pageerror",
                text: (err.message ?? String(err)).slice(0, 2000),
                url: page.url(),
                ts: Date.now(),
            })
        })
    }

    /** Close this session's pages; leave the shared Chromium running. */
    async detach(): Promise<void> {
        for (const p of this.pages) {
            if (!p.isClosed())
                await p.close({ runBeforeUnload: false }).catch(() => {})
        }
        this.pages = []
        this.activeIdx = 0
        if (this.browser) {
            // Disconnect from the shared instance but don't terminate it.
            await this.browser.close().catch(() => {})
        }
        this.browser = undefined
        this.ctx = undefined
    }

    /** Hard-kill the shared Chromium process. */
    async quitShared(): Promise<{ killed: boolean; reason: string }> {
        const ep = readEndpoint()
        await this.detach()
        if (!ep) return { killed: false, reason: "no endpoint file" }
        try {
            process.kill(ep.pid, "SIGTERM")
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ESRCH") {
                clearEndpoint()
                return { killed: false, reason: "process already gone" }
            }
            throw e
        }
        // Give it a moment, then SIGKILL if still alive.
        for (let i = 0; i < 20; i++) {
            await sleep(100)
            try {
                process.kill(ep.pid, 0)
            } catch {
                clearEndpoint()
                return { killed: true, reason: "SIGTERM" }
            }
        }
        try {
            process.kill(ep.pid, "SIGKILL")
        } catch {
            // ignore
        }
        clearEndpoint()
        return { killed: true, reason: "SIGKILL" }
    }

    status(): { connected: boolean; endpoint?: EndpointFile; tabs: number } {
        return {
            connected: !!this.browser?.isConnected(),
            endpoint: readEndpoint() ?? undefined,
            tabs: this.pages.filter((p) => !p.isClosed()).length,
        }
    }

    private tryAcquireLock(): boolean {
        try {
            const fd = openSync(LOCK_FILE, "wx")
            writeFileSync(LOCK_FILE, String(process.pid))
            closeSync(fd)
            return true
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "EEXIST") {
                // Stale lock if pid is dead.
                try {
                    const pid = Number(readFileSync(LOCK_FILE, "utf8")) || 0
                    if (pid > 0) {
                        try {
                            process.kill(pid, 0)
                            return false
                        } catch {
                            unlinkSync(LOCK_FILE)
                            return this.tryAcquireLock()
                        }
                    }
                } catch {
                    // fall through and let the next iteration retry
                }
                return false
            }
            throw e
        }
    }

    private releaseLock(): void {
        try {
            unlinkSync(LOCK_FILE)
        } catch {
            // ignore — lock file may not exist if spawn failed before write
        }
    }
}

export const browser = new BrowserSession()

// ── helpers ─────────────────────────────────────────────────────

function readEndpoint(): EndpointFile | null {
    if (!existsSync(ENDPOINT_FILE)) return null
    try {
        const raw = readFileSync(ENDPOINT_FILE, "utf8")
        const ep = JSON.parse(raw) as EndpointFile
        if (!ep.httpEndpoint || !ep.pid) return null
        // Verify the process is alive; stale file otherwise.
        try {
            process.kill(ep.pid, 0)
        } catch {
            return null
        }
        return ep
    } catch {
        return null
    }
}

function writeEndpoint(ep: EndpointFile): void {
    writeFileSync(ENDPOINT_FILE, JSON.stringify(ep, null, 2))
}

function clearEndpoint(): void {
    try {
        unlinkSync(ENDPOINT_FILE)
    } catch {
        // ignore
    }
}

async function isReachable(httpEndpoint: string): Promise<boolean> {
    try {
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), 1000)
        const res = await fetch(`${httpEndpoint}/json/version`, {
            signal: ctrl.signal,
        })
        clearTimeout(t)
        return res.ok
    } catch {
        return false
    }
}

async function spawnChromium(headless: boolean): Promise<EndpointFile> {
    const exe = chromium.executablePath()
    if (!exe) {
        throw new Error(
            "playwright chromium executable not found; run `npx playwright install chromium`",
        )
    }

    // Make sure the log file exists and we open it for write so the
    // child inherits a real fd. Truncate on each launch — old logs
    // would otherwise confuse the port-parsing scan below.
    const logFd = openSync(LOG_FILE, "w")

    const args = [
        "--remote-debugging-port=0",
        `--user-data-dir=${PROFILE_DIR}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-default-apps",
        "--password-store=basic",
        "--use-mock-keychain",
        "--remote-allow-origins=*",
    ]
    if (headless) args.unshift("--headless=new")

    const child = spawn(exe, args, {
        detached: true,
        stdio: ["ignore", "ignore", logFd],
        env: { ...process.env },
    })

    closeSync(logFd) // parent's copy of fd; child still has it
    child.unref()

    const pid = child.pid
    if (!pid) {
        throw new Error("browser: failed to spawn chromium (no pid)")
    }

    // Scan log file for "DevTools listening on ws://" up to ~15s.
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
        const url = tryParseDevToolsUrl()
        if (url) {
            const wsEndpoint = url
            // ws://127.0.0.1:PORT/devtools/browser/UUID
            const m = wsEndpoint.match(/^ws:\/\/([^/]+)\//)
            if (!m) {
                throw new Error(
                    `browser: malformed DevTools url: ${wsEndpoint}`,
                )
            }
            const host = m[1]!
            const portM = host.match(/:(\d+)$/)
            const port = portM ? Number(portM[1]) : 9222
            return {
                httpEndpoint: `http://${host}`,
                wsEndpoint,
                port,
                pid,
                startedAt: Date.now(),
            }
        }
        // If the child died, fail fast.
        try {
            process.kill(pid, 0)
        } catch {
            const log = readLogTail()
            throw new Error(`browser: chromium exited during launch.\n${log}`)
        }
        await sleep(150)
    }

    // Last-ditch: kill the half-launched process.
    try {
        process.kill(pid, "SIGKILL")
    } catch {
        // ignore
    }
    throw new Error("browser: timed out waiting for chromium devtools port")
}

function tryParseDevToolsUrl(): string | null {
    if (!existsSync(LOG_FILE)) return null
    try {
        const st = statSync(LOG_FILE)
        const size = Math.min(st.size, 64 * 1024)
        if (size === 0) return null
        const fd = openSync(LOG_FILE, "r")
        const buf = Buffer.alloc(size)
        readSync(fd, buf, 0, size, st.size - size)
        closeSync(fd)
        const text = buf.toString("utf8")
        const m = text.match(
            /DevTools listening on (ws:\/\/[^\s]+\/devtools\/browser\/[^\s]+)/,
        )
        return m ? m[1]! : null
    } catch {
        return null
    }
}

function readLogTail(): string {
    try {
        const txt = readFileSync(LOG_FILE, "utf8")
        return txt.slice(-2000)
    } catch {
        return "(no log)"
    }
}
