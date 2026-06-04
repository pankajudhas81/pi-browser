/**
 * Per-page async mutex. Used to serialize browser actions on the
 * same page so two parallel tool calls do not race the DOM.
 */

import type { Page } from "playwright";

type Task<T> = () => Promise<T>;

const tails = new WeakMap<Page, Promise<unknown>>();

export const mutex = {
    async run<T>(page: Page, task: Task<T>): Promise<T> {
        const prev = tails.get(page) ?? Promise.resolve();
        let release!: () => void;
        const slot = new Promise<void>((r) => {
            release = r;
        });
        const tail = prev.then(() => slot);
        tails.set(page, tail);
        try {
            await prev;
            return await task();
        } finally {
            release();
            if (tails.get(page) === tail) {
                tails.delete(page);
            }
        }
    },
};
