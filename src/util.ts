/**
 * Shared utilities for the browser extension.
 */

export const STATE_DIR =
    process.env.PI_BROWSER_STATE_DIR ??
    `${process.env.HOME}/.pi/agent/state/browser`

export const PROFILE_DIR = `${STATE_DIR}/profile`
export const ENDPOINT_FILE = `${STATE_DIR}/endpoint.json`
export const LOCK_FILE = `${STATE_DIR}/launch.lock`
export const LOG_FILE = `${STATE_DIR}/chromium.log`

/**
 * Race a promise against an AbortSignal. If the signal fires the
 * outer promise rejects, but the inner work keeps running until the
 * caller-supplied timeout fires inside Playwright. That is fine —
 * we want fast UI cancellation, not silent half-completed work.
 */
export function withAbort<T>(
    work: Promise<T>,
    signal: AbortSignal | undefined,
): Promise<T> {
    if (!signal) return work
    if (signal.aborted) return Promise.reject(new Error("aborted"))
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(new Error("aborted"))
        signal.addEventListener("abort", onAbort, { once: true })
        work.then(
            (v) => {
                signal.removeEventListener("abort", onAbort)
                resolve(v)
            },
            (e) => {
                signal.removeEventListener("abort", onAbort)
                reject(e)
            },
        )
    })
}

export function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
}

export function shortError(e: unknown): string {
    if (e instanceof Error) {
        // Playwright errors have long call sites — keep just the first line.
        return e.message.split("\n")[0]!.slice(0, 400)
    }
    return String(e).slice(0, 400)
}
