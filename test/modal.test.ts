import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PolishLevel } from "../src/polish";
import type { Phase, SessionDeps } from "../src/session";

// The sheet over a stand-in for Obsidian's Modal and its DOM helpers
// (createDiv, createSpan, createEl, addClass, setText, empty). How it looks is
// design/playground's to show; this holds each state to its one header line,
// its hero and its footer of one primary and the rest as text.
interface El {
	tag: string;
	cls: string[];
	text: string;
	attr: Record<string, string>;
	children: El[];
	click(): void;
}
type Opts = { cls?: string | string[]; text?: string; attr?: Record<string, string> };
function el(tag: string, o: Opts = {}): El & Record<string, unknown> {
	const handlers: Array<() => void> = [];
	const e = {
		tag,
		cls: o.cls === undefined ? [] : Array.isArray(o.cls) ? [...o.cls] : [o.cls],
		text: o.text ?? "",
		attr: { ...o.attr },
		children: [] as El[],
		createEl(t: string, oo?: Opts) {
			const c = el(t, oo);
			e.children.push(c);
			return c;
		},
		createDiv(oo?: Opts) {
			return e.createEl("div", oo);
		},
		createSpan(oo?: Opts) {
			return e.createEl("span", oo);
		},
		addClass(c: string) {
			e.cls.push(c);
		},
		removeClass(c: string) {
			e.cls = e.cls.filter((x) => x !== c);
		},
		toggleClass(c: string, on: boolean) {
			e.cls = e.cls.filter((x) => x !== c);
			if (on) e.cls.push(c);
		},
		setCssProps() {},
		setText(t: string) {
			e.text = t;
		},
		empty() {
			e.children.length = 0;
		},
		contains(other: El): boolean {
			return other === (e as El) || e.children.some((c) => (c as El & { contains(o: El): boolean }).contains(other));
		},
		addEventListener(_: string, fn: () => void) {
			handlers.push(fn);
		},
		click() {
			for (const fn of handlers) fn();
		},
		getContext: () => null,
	};
	return e;
}
function add(parent: El, child: El): El {
	parent.children.push(child);
	return child;
}
vi.mock("obsidian", () => {
	class Modal {
		modalEl = el("div", { cls: "modal" });
		titleEl = add(this.modalEl, el("div", { cls: "modal-title" }));
		contentEl = add(this.modalEl, el("div", { cls: "modal-content" }));
		constructor(public app: unknown) {
			// Obsidian's close button, first in the modal as in the app.
			this.modalEl.children.unshift(el("div", { cls: "modal-close-button" }));
		}
		close() {}
	}
	class Stub {}
	return { Modal, MarkdownView: Stub, Notice: Stub, TFile: Stub };
});

const { DictateModal, selectedLevel } = await import("../src/modal");

const NAME = "A very long note name that ends in an ellipsis";
const ready = (extra: Partial<Extract<Phase, { kind: "ready" }>> = {}, text = "Tell Flio hello."): Phase => ({
	kind: "ready",
	text,
	biased: true,
	durationMs: 42_000,
	targetGone: false,
	polish: { text, level: "light", ran: true },
	...extra,
});

/** Each state: its pill word, its primary button (or none) and its text buttons. */
const STATES: Array<[string, Phase, string, string | null, string[]]> = [
	["unsupported", { kind: "unsupported", message: "No microphone." }, "Can't record", "Close", []],
	["starting", { kind: "starting" }, "Starting", null, ["Cancel"]],
	["recording", { kind: "recording", elapsedMs: 12_000, warning: false }, "Recording", "Stop", ["Cancel"]],
	["recording (warning)", { kind: "recording", elapsedMs: 95_000, warning: true }, "Recording", "Stop", ["Cancel"]],
	["cleaning", { kind: "cleaning", durationMs: 12_000, terms: 3 }, "Cleaning", null, ["Cancel"]],
	["polishing", { kind: "polishing", durationMs: 12_000, level: "light" }, "Polishing", null, ["Cancel", "Skip"]],
	["ready", ready(), "Ready", "Insert", ["Discard", "Retake"]],
	["ready (note gone)", ready({ targetGone: true }), "Ready", "Copy", ["Discard"]],
	["failed", { kind: "failed", message: "No signal.", durationMs: 12_000, takeKept: true }, "Not cleaned", "Try again", ["Discard"]],
];

interface Drawn {
	sheet: El;
	modal: El;
	calls: string[];
}
function draw(p: Phase, polishLevel: PolishLevel = "light"): Drawn {
	const target = { editor: {}, ctx: {}, file: { basename: NAME } };
	const modal = new DictateModal({} as never, target as never, { capMs: 120_000, polishLevel: () => polishLevel } as SessionDeps, 3, () => {});
	const inside = modal as unknown as { render(p: Phase): void; hideChrome(): void; session: Record<string, unknown>; contentEl: El; modalEl: El };
	const calls: string[] = [];
	for (const name of ["stop", "retry", "retake", "repolish", "skipPolish"]) {
		inside.session[name] = (arg?: string) => void calls.push(arg ? `${name}(${arg})` : name);
	}
	inside.hideChrome();
	inside.render(p);
	return { sheet: inside.contentEl, modal: inside.modalEl, calls };
}

/** Every text under an element, in order. */
const texts = (e: El): string[] => [e.text, ...e.children.flatMap(texts)].filter(Boolean);
const find = (e: El, cls: string): El | undefined => (e.cls.includes(cls) ? e : e.children.map((c) => find(c, cls)).find(Boolean));
const all = (e: El, cls: string): El[] => [...(e.cls.includes(cls) ? [e] : []), ...e.children.flatMap((c) => all(c, cls))];

describe("the sheet, every state", () => {
	// The recording sheet starts its wave; under Node no frame ever comes.
	const w = window as unknown as Record<string, unknown>;
	const saved = { raf: w.requestAnimationFrame, caf: w.cancelAnimationFrame };
	beforeAll(() => {
		w.requestAnimationFrame = () => 1;
		w.cancelAnimationFrame = () => {};
	});
	afterAll(() => {
		w.requestAnimationFrame = saved.raf;
		w.cancelAnimationFrame = saved.caf;
	});

	it.each(STATES)("%s: a handle, one header line, the hero, then the footer", (_, p) => {
		const { sheet } = draw(p);
		expect(sheet.children.map((c) => c.cls[0])).toEqual(["spoken-handle", "spoken-head", "spoken-body", "spoken-foot"]);
		expect(find(sheet, "spoken-body")!.cls).toContain("is-entering");
	});

	it.each(STATES)("%s: the pill says one word and the note's name is the right-hand element", (_, p, word) => {
		const head = draw(p).sheet.children[1];
		expect(head.children.map((c) => c.cls[0])).toEqual(["spoken-pill", "spoken-into"]);
		expect(texts(head.children[0])).toEqual([word]);
		expect(head.children[1].text).toBe(NAME);
		expect(head.children[1].cls).not.toContain("spoken-beside-close");
	});

	it.each(STATES)("%s: one primary at most, the rest as text buttons", (_, p, __, primary, quiet) => {
		const foot = draw(p).sheet.children[3];
		const primaries = all(foot, "spoken-primary");
		expect(primaries.map((b) => b.text)).toEqual(primary ? [primary] : []);
		if (primary) expect(primaries[0].cls).toContain("mod-cta");
		else expect(find(foot, "spoken-progress")).toBeDefined();
		expect(all(foot, "spoken-quiet").map((b) => b.text)).toEqual(quiet);
	});

	it.each(STATES)("%s: the sheet grows to its content only in Ready, Failed and Unsupported", (_, p) => {
		const grown = ["unsupported", "ready", "failed"].includes(p.kind);
		expect(draw(p).sheet.cls.includes("is-grown")).toBe(grown);
	});

	it("Obsidian's close button and title are hidden in this modal, and the content is not", () => {
		const { modal } = draw({ kind: "starting" });
		const [close, title, content] = modal.children;
		expect(close.cls).toEqual(["modal-close-button", "spoken-chrome"]);
		expect(title.cls).toEqual(["modal-title", "spoken-chrome"]);
		expect(content.cls).not.toContain("spoken-chrome");
	});

	it("Recording, Cleaning and Polishing share one stage: the timer, the wave, one caption", () => {
		for (const p of STATES.slice(2, 6).map((s) => s[1])) {
			const stage = find(draw(p).sheet, "spoken-stage")!;
			expect(stage.children.map((c) => c.cls[0])).toEqual(["spoken-clock", "spoken-wave", "spoken-caption"]);
		}
		const recording = find(draw(STATES[2][1]).sheet, "spoken-stage")!;
		expect(texts(recording.children[0])).toEqual(["0:12", " / 2:00"]);
		expect(recording.children[1].cls).not.toContain("is-frozen");
		expect(recording.children[2].text).toBe("Names and terms: 3");
		const cleaning = find(draw(STATES[4][1]).sheet, "spoken-stage")!;
		expect(cleaning.children[1].cls).toContain("is-frozen");
		expect(cleaning.children[2].text).toBe("Biased with 3 terms");
	});

	it("thirty seconds left: the pill, the timer and the caption turn amber, and the caption counts down", () => {
		const { sheet } = draw(STATES[3][1]);
		expect(find(sheet, "spoken-pill")!.cls).toContain("is-amber");
		expect(find(sheet, "spoken-clock")!.cls).toContain("is-amber");
		expect(find(sheet, "spoken-caption")!.text).toBe("25 seconds left");
	});

	it("the buttons reach the session", () => {
		const press = (p: Phase, text: string) => {
			const d = draw(p);
			const b = [...all(d.sheet, "spoken-primary"), ...all(d.sheet, "spoken-quiet")].find((x) => x.text === text)!;
			b.click();
			return d.calls;
		};
		expect(press(STATES[2][1], "Stop")).toEqual(["stop"]);
		expect(press(STATES[5][1], "Skip")).toEqual(["skipPolish"]);
		expect(press(ready(), "Retake")).toEqual(["retake"]);
		expect(press(STATES[8][1], "Try again")).toEqual(["retry"]);
	});
});

describe("the progress line, in the primary's place while waiting", () => {
	const line = (p: Phase, level: PolishLevel = "light") => {
		const progress = find(draw(p, level).sheet, "spoken-progress")!;
		return progress.children.map((s) => `${texts(s).join("")}:${s.cls.find((c) => c.startsWith("is-"))}`);
	};

	it("progress, starting: Transcribe and Polish, both to come", () => {
		expect(line({ kind: "starting" })).toEqual(["Transcribe:is-todo", "Polish:is-todo"]);
	});

	it("progress, cleaning: Transcribe running, Polish to come", () => {
		expect(line({ kind: "cleaning", durationMs: 12_000, terms: 3 })).toEqual(["Transcribe:is-running", "Polish:is-todo"]);
	});

	it("progress, polishing: Transcribe done, Polish running", () => {
		expect(line({ kind: "polishing", durationMs: 12_000, level: "full" })).toEqual(["Transcribe:is-done", "Polish:is-running"]);
	});

	it("progress, Polish off: one segment, Transcribe", () => {
		expect(line({ kind: "starting" }, "off")).toEqual(["Transcribe:is-todo"]);
		expect(line({ kind: "cleaning", durationMs: 12_000, terms: 3 }, "off")).toEqual(["Transcribe:is-running"]);
	});

	it("progress: the running step is the current one, for a screen reader", () => {
		const progress = find(draw({ kind: "cleaning", durationMs: 12_000, terms: 3 }).sheet, "spoken-progress")!;
		expect(progress.children.map((s) => s.attr["aria-current"])).toEqual(["step", undefined]);
	});
});

describe("Polish on the Ready sheet", () => {
	const seg = (s: El) => all(s, "spoken-seg-item").map((b) => `${b.text}${b.cls.includes("is-active") ? "*" : ""}`);

	it("after Light: the meta line says words and time, and Off · Light · Full has Light lit", () => {
		const { sheet } = draw(ready());
		expect(find(sheet, "spoken-facts")!.text).toBe("3 words · 0:42");
		expect(seg(sheet)).toEqual(["Off", "Light*", "Full"]);
		expect(find(sheet, "spoken-note")).toBeUndefined();
	});

	it("with polish off: Off is lit", () => {
		const { sheet } = draw(ready({ polish: { text: "tell fleo hello", level: "off", ran: true } }, "tell fleo hello"));
		expect(seg(sheet)).toEqual(["Off*", "Light", "Full"]);
	});

	it("after a fallback: nothing is lit and one quiet line says why", () => {
		const { sheet } = draw(ready({ polish: { text: "tell fleo hello", level: "light", ran: false, why: "Gemini took too long" } }, "tell fleo hello"));
		expect(seg(sheet)).toEqual(["Off", "Light", "Full"]);
		expect(find(sheet, "spoken-note")!.text).toBe("Polish did not run: Gemini took too long. This is the transcript as heard.");
		expect(find(sheet, "spoken-note")!.cls).not.toContain("is-error");
	});

	it("a segment re-polishes this take at its level; the lit one does nothing", () => {
		const d = draw(ready());
		const [off, light, full] = all(d.sheet, "spoken-seg-item");
		light.click();
		off.click();
		full.click();
		expect(d.calls).toEqual(["repolish(off)", "repolish(full)"]);
		expect(light.attr["aria-pressed"]).toBe("true");
	});

	it("with the note gone: no levels to choose, the reason in the error colour", () => {
		const { sheet } = draw(ready({ targetGone: true }));
		expect(find(sheet, "spoken-seg")).toBeUndefined();
		expect(find(sheet, "spoken-note")!.cls).toContain("is-error");
	});

	it("selectedLevel: the level that ran, none when Polish fell back", () => {
		expect(selectedLevel({ text: "", level: "full", ran: true })).toBe("full");
		expect(selectedLevel({ text: "", level: "full", ran: false, why: "x" })).toBeNull();
	});
});

describe("styles.css and the playground", () => {
	const css = readFileSync("styles.css", "utf8");

	it("hides what src/modal.ts marks without naming Obsidian's close button", () => {
		expect(css).toMatch(/\.modal\.spoken-modal > \.spoken-chrome \{\s*display: none;\s*\}/);
		expect(css).not.toMatch(/modal-close-button|modal-header-button|spoken-beside-close/);
	});

	it("the sheet's corners are --radius-l throughout (dots and spinners stay round)", () => {
		const sheet = css.slice(0, css.indexOf("/* Settings:"));
		expect(sheet).toMatch(/var\(--radius-l\)/);
		expect(sheet).not.toMatch(/--radius-[sm]\b|border-radius: \d+px/);
	});

	it("state changes fade in over 150 ms, and a change of height takes the same 150 ms", () => {
		expect(css).toMatch(/\.spoken-body\.is-entering \{\s*animation: spoken-in 150ms/);
		expect(css).toMatch(/\.is-sizing \{[^}]*transition: height 150ms/);
	});

	it("heights: compact min(380px, 72vh); grown up to 70vh in a dialog and 85vh on a phone", () => {
		expect(css).toContain("--spoken-compact: min(380px, calc(72 * var(--spoken-vh, 1vh)));");
		expect(css).toMatch(/\.spoken\.is-grown \{[^}]*min-height: var\(--spoken-compact\);\s*max-height: calc\(70 \* var\(--spoken-vh, 1vh\)\);/);
		expect(css).toMatch(/\.is-phone [^{]*\.is-grown \{\s*max-height: calc\(85 \* var\(--spoken-vh, 1vh\)\);/);
	});

	it("the progress line stands at the primary's height, and the words fade only while there is more", () => {
		expect(css).toMatch(/\.spoken-progress \{\s*height: 48px;/);
		expect(css).toMatch(/button\.spoken-primary \{[^}]*height: 48px;/);
		expect(css).toMatch(/\.spoken-text\.is-more \{[^}]*calc\(100% - var\(--size-4-8\)\)/);
		expect(css.slice(css.indexOf(".spoken-text {"), css.indexOf(".spoken-text.is-more"))).not.toContain("mask-image");
	});

	it("the built playground carries today's styles.css and draws every state", () => {
		const page = readFileSync("design/playground/index.html", "utf8");
		expect(page).toContain(css.replace(/<\/style/gi, "<\\/style"));
		for (const name of ["Starting", "Recording, 30 s left", "Cleaning", "Cleaning, Polish off", "Polishing", "Ready, long", "Ready, short", "Ready, note gone", "Failed", "Unsupported"]) {
			expect(page).toContain(`"${name}"`);
		}
	});
});
