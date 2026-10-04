// What the sheet takes from Obsidian, stood in for in a plain browser page.
// `npm run playground` bundles src/modal.ts against this file in place of the
// `obsidian` package (which ships types only), so the page draws the real
// sheet with the real DOM calls. Only what src/modal.ts and src/insert.ts touch
// is here.

type Cls = string | string[];
interface ElOpts {
	cls?: Cls;
	text?: string;
	href?: string;
	attr?: Record<string, string>;
}

declare global {
	interface HTMLElement {
		createEl<K extends keyof HTMLElementTagNameMap>(tag: K, o?: ElOpts): HTMLElementTagNameMap[K];
		createDiv(o?: ElOpts): HTMLDivElement;
		createSpan(o?: ElOpts): HTMLSpanElement;
		addClass(...cls: string[]): void;
		removeClass(...cls: string[]): void;
		toggleClass(cls: string | string[], value: boolean): void;
		setCssProps(props: Record<string, string>): void;
		setText(text: string): void;
		empty(): void;
	}
	interface Element {
		addClass(...cls: string[]): void;
	}
}

// Obsidian's DOM helpers, which it adds to every element.
const proto = HTMLElement.prototype;
proto.createEl = function <K extends keyof HTMLElementTagNameMap>(this: HTMLElement, tag: K, o: ElOpts = {}) {
	const e = document.createElement(tag);
	if (o.cls) e.classList.add(...(Array.isArray(o.cls) ? o.cls : o.cls.split(" ")).filter(Boolean));
	if (o.text !== undefined) e.textContent = o.text;
	if (o.href !== undefined) e.setAttribute("href", o.href);
	for (const [k, v] of Object.entries(o.attr ?? {})) e.setAttribute(k, v);
	this.appendChild(e);
	return e;
};
proto.createDiv = function (this: HTMLElement, o?: ElOpts) {
	return this.createEl("div", o);
};
proto.createSpan = function (this: HTMLElement, o?: ElOpts) {
	return this.createEl("span", o);
};
proto.setText = function (this: HTMLElement, text: string) {
	this.textContent = text;
};
proto.empty = function (this: HTMLElement) {
	this.replaceChildren();
};
Element.prototype.addClass = function (this: Element, ...cls: string[]) {
	this.classList.add(...cls);
};
proto.removeClass = function (this: HTMLElement, ...cls: string[]) {
	this.classList.remove(...cls);
};
proto.toggleClass = function (this: HTMLElement, cls: string | string[], value: boolean) {
	for (const c of Array.isArray(cls) ? cls : [cls]) this.classList.toggle(c, value);
};
proto.setCssProps = function (this: HTMLElement, props: Record<string, string>) {
	for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v);
};

export class App {}
export class TFile {
	constructor(public basename: string) {}
}
export class MarkdownView {}

/** Obsidian's notice, as a toast in the page. */
export class Notice {
	constructor(message: string) {
		const host = document.getElementById("toasts");
		if (!host) return;
		const t = host.createDiv({ cls: "toast", text: message });
		window.setTimeout(() => t.remove(), 2600);
	}
}

/**
 * Obsidian's Modal, drawn the way the app draws it: a container with a
 * backdrop, the modal holding a close button, a title and the content.
 * Escape and the backdrop close it. `Modal.host` is where the next one opens.
 */
export class Modal {
	static host: HTMLElement = document.body;
	containerEl: HTMLElement;
	modalEl: HTMLElement;
	titleEl: HTMLElement;
	contentEl: HTMLElement;
	shouldRestoreSelection = true;
	private onKey = (ev: KeyboardEvent) => {
		if (ev.key === "Escape") this.close();
	};

	constructor(public app: App) {
		this.containerEl = document.createElement("div");
		this.containerEl.className = "modal-container mod-dim";
		this.containerEl.createDiv({ cls: "modal-bg" }).addEventListener("click", () => this.close());
		this.modalEl = this.containerEl.createDiv({ cls: "modal" });
		// Obsidian's own close button; the sheet hides it.
		this.modalEl.createDiv({ cls: "modal-close-button", text: "×" }).addEventListener("click", () => this.close());
		this.titleEl = this.modalEl.createDiv({ cls: "modal-title" });
		this.contentEl = this.modalEl.createDiv({ cls: "modal-content" });
	}

	open(): void {
		Modal.host.appendChild(this.containerEl);
		document.addEventListener("keydown", this.onKey);
		this.onOpen();
	}

	close(): void {
		if (!this.containerEl.isConnected) return;
		document.removeEventListener("keydown", this.onKey);
		this.containerEl.remove();
		this.onClose();
	}

	onOpen(): void {}
	onClose(): void {}
}

export type Editor = unknown;
export type EditorPosition = { line: number; ch: number };
export type MarkdownFileInfo = unknown;
