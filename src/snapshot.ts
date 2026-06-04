/**
 * Builds a YAML-ish accessibility-tree snapshot for an LLM, and a
 * matching ref-id → CSS-selector table for tool actions.
 *
 * The walk runs entirely inside the page via page.evaluate() so we
 * see only what the user would see in the rendered DOM. Hidden,
 * zero-size, and aria-hidden nodes are skipped. Selectors are
 * structural (tag + #id or :nth-of-type chain) and stable for the
 * lifetime of one snapshot.
 */

import type { Page } from "playwright"
import { type RefRecord, refs } from "./refs"

interface RawNode {
    ref: number
    role: string
    name: string
    selector: string
    tag: string
    depth: number
    disabled?: boolean
    checked?: boolean
    value?: string
    href?: string
}

interface RawSnapshot {
    url: string
    title: string
    nodes: RawNode[]
}

export interface Snapshot {
    text: string
    url: string
    title: string
    count: number
}

export async function captureSnapshot(page: Page): Promise<Snapshot> {
    const raw = (await page.evaluate(walkSource)) as RawSnapshot

    refs.reset(page)
    for (const n of raw.nodes) {
        const record: RefRecord = {
            role: n.role,
            name: n.name,
            selector: n.selector,
            tag: n.tag,
        }
        refs.set(page, n.ref, record)
    }

    const lines: string[] = [
        `url: ${raw.url}`,
        `title: ${raw.title}`,
        `interactive: ${raw.nodes.length}`,
        "",
    ]

    for (const n of raw.nodes) {
        const pad = "  ".repeat(Math.min(n.depth, 8))
        const parts: string[] = [`- ${n.role}`]
        if (n.name) parts.push(JSON.stringify(n.name))
        if (n.value) parts.push(`value=${JSON.stringify(n.value)}`)
        if (n.href) parts.push(`href=${JSON.stringify(n.href)}`)
        if (n.disabled) parts.push("disabled")
        if (n.checked) parts.push("checked")
        parts.push(`[ref=${n.ref}]`)
        lines.push(pad + parts.join(" "))
    }

    return {
        text: lines.join("\n"),
        url: raw.url,
        title: raw.title,
        count: raw.nodes.length,
    }
}

// Evaluated inside the page. Must be self-contained — no closures
// over outer scope. Returns RawSnapshot.
function walkSource(): unknown {
    const INTERESTING_TAGS = new Set([
        "A",
        "BUTTON",
        "INPUT",
        "SELECT",
        "TEXTAREA",
        "FORM",
        "LABEL",
        "DETAILS",
        "SUMMARY",
        "IMG",
        "VIDEO",
        "AUDIO",
        "H1",
        "H2",
        "H3",
        "H4",
        "H5",
        "H6",
        "NAV",
        "MAIN",
        "HEADER",
        "FOOTER",
        "ASIDE",
        "DIALOG",
    ])
    const INTERESTING_ROLES = new Set([
        "button",
        "link",
        "checkbox",
        "radio",
        "switch",
        "menuitem",
        "tab",
        "option",
        "textbox",
        "searchbox",
        "combobox",
        "slider",
        "spinbutton",
        "dialog",
        "alert",
        "alertdialog",
        "menu",
        "tablist",
        "listbox",
        "tree",
        "treeitem",
    ])

    function defaultRole(el: Element): string | null {
        const r = el.getAttribute("role")
        if (r) return r
        switch (el.tagName) {
            case "A":
                return (el as HTMLAnchorElement).hasAttribute("href")
                    ? "link"
                    : null
            case "BUTTON":
                return "button"
            case "INPUT": {
                const t = (el as HTMLInputElement).type
                if (t === "checkbox") return "checkbox"
                if (t === "radio") return "radio"
                if (t === "submit" || t === "button" || t === "reset")
                    return "button"
                if (t === "range") return "slider"
                if (t === "search") return "searchbox"
                if (t === "hidden" || t === "file") return t
                return "textbox"
            }
            case "TEXTAREA":
                return "textbox"
            case "SELECT":
                return "combobox"
            case "IMG":
                return "img"
            case "H1":
            case "H2":
            case "H3":
            case "H4":
            case "H5":
            case "H6":
                return "heading"
            case "FORM":
                return "form"
            case "NAV":
                return "navigation"
            case "MAIN":
                return "main"
            case "HEADER":
                return "banner"
            case "FOOTER":
                return "contentinfo"
            case "DIALOG":
                return "dialog"
            default:
                return null
        }
    }

    function isVisible(el: Element): boolean {
        if (el.getAttribute("aria-hidden") === "true") return false
        const he = el as HTMLElement
        if (he.hidden) return false
        const r = he.getBoundingClientRect()
        if (r.width < 1 || r.height < 1) return false
        const cs = getComputedStyle(he)
        if (cs.visibility === "hidden" || cs.display === "none") return false
        if (Number(cs.opacity) === 0) return false
        return true
    }

    // Browser-eval context — these DOM lookups are necessary and
    // intentional. Aliased to dodge a TS linter rule meant for app code.
    const doc = document

    function accName(el: Element): string {
        const direct =
            el.getAttribute("aria-label") ??
            el.getAttribute("alt") ??
            el.getAttribute("title") ??
            null
        if (direct) return direct.trim().slice(0, 200)

        const labelledBy = el.getAttribute("aria-labelledby")
        if (labelledBy) {
            const text = labelledBy
                .split(/\s+/)
                .map((id) => doc.getElementById(id)?.textContent ?? "")
                .join(" ")
                .trim()
            if (text) return text.slice(0, 200)
        }

        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
            const id = el.id
            if (id) {
                const lbl = doc.querySelector(`label[for="${CSS.escape(id)}"]`)
                if (lbl?.textContent)
                    return lbl.textContent.trim().slice(0, 200)
            }
            const parentLabel = el.closest("label")
            if (parentLabel?.textContent)
                return parentLabel.textContent.trim().slice(0, 200)
            const ph = (el as HTMLInputElement).placeholder
            if (ph) return `(${ph})`.slice(0, 200)
            const nm = el.getAttribute("name")
            if (nm) return `[${nm}]`.slice(0, 200)
            return ""
        }

        if (el.tagName === "IMG") {
            return (el as HTMLImageElement).alt?.slice(0, 200) ?? ""
        }

        // Use only this element's own text, not nested-control text.
        const own = (el as HTMLElement).innerText ?? el.textContent ?? ""
        return own.replace(/\s+/g, " ").trim().slice(0, 120)
    }

    function cssPath(el: Element): string {
        const parts: string[] = []
        let cur: Element | null = el
        while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
            let part = cur.tagName.toLowerCase()
            if (cur.id) {
                part += `#${CSS.escape(cur.id)}`
                parts.unshift(part)
                break
            }
            const parent = cur.parentElement
            if (parent) {
                const sameTag = Array.from(parent.children).filter(
                    (s) => s.tagName === cur!.tagName,
                )
                if (sameTag.length > 1) {
                    const idx = sameTag.indexOf(cur) + 1
                    part += `:nth-of-type(${idx})`
                }
            }
            parts.unshift(part)
            cur = cur.parentElement
        }
        return parts.length ? parts.join(" > ") : "html"
    }

    const nodes: RawNode[] = []
    let counter = 0

    function walk(el: Element, depth: number): void {
        const role = defaultRole(el)
        const isLandmark =
            role === "heading" ||
            role === "form" ||
            role === "navigation" ||
            role === "main" ||
            role === "banner" ||
            role === "contentinfo" ||
            role === "dialog"
        const interesting =
            role !== null &&
            role !== "hidden" &&
            role !== "file" &&
            (INTERESTING_TAGS.has(el.tagName) ||
                INTERESTING_ROLES.has(role) ||
                isLandmark)

        if (interesting && isVisible(el)) {
            const ref = ++counter
            const node: RawNode = {
                ref,
                role,
                name: accName(el),
                selector: cssPath(el),
                tag: el.tagName.toLowerCase(),
                depth,
            }
            if ((el as HTMLInputElement).disabled === true) node.disabled = true
            if ((el as HTMLInputElement).checked === true) node.checked = true
            const val = (el as HTMLInputElement).value
            if (typeof val === "string" && val) node.value = val.slice(0, 200)
            if (el.tagName === "A") {
                const href = (el as HTMLAnchorElement).getAttribute("href")
                if (href) node.href = href.slice(0, 200)
            }
            nodes.push(node)
            for (const child of Array.from(el.children)) walk(child, depth + 1)
        } else {
            for (const child of Array.from(el.children)) walk(child, depth)
        }
    }

    walk(document.body, 0)
    return { url: location.href, title: document.title, nodes }
}
