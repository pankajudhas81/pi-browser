/**
 * Ref-id → DOM-selector map for the current snapshot. Refs are stable
 * for the lifetime of one snapshot; a fresh snapshot resets them.
 *
 * Each page owns its own ref table because tools address pages independently.
 */

import type { Page } from "playwright";

export interface RefRecord {
    role: string;
    name: string;
    selector: string;
    tag: string;
}

type Table = Map<number, RefRecord>;

const tables = new WeakMap<Page, Table>();

export const refs = {
    reset(page: Page): void {
        tables.set(page, new Map());
    },

    set(page: Page, ref: number, record: RefRecord): void {
        let t = tables.get(page);
        if (!t) {
            t = new Map();
            tables.set(page, t);
        }
        t.set(ref, record);
    },

    get(page: Page, ref: number): RefRecord | undefined {
        return tables.get(page)?.get(ref);
    },

    require(page: Page, ref: number): RefRecord {
        const r = tables.get(page)?.get(ref);
        if (!r) {
            throw new Error(
                `stale or unknown ref=${ref}; call browser_snapshot to get fresh refs`,
            );
        }
        return r;
    },

    size(page: Page): number {
        return tables.get(page)?.size ?? 0;
    },
};
