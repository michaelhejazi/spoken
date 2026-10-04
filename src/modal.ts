// The sheet: an Obsidian Modal, drawn as a bottom sheet on a phone. It draws
// the session's phase (design/playground renders every one) and forwards the
// buttons. Words land only on Insert; any other way out throws the take away.
//
// Every state has the same frame: a handle, one header line (a status pill and
// the note's name), one hero, then a footer of one primary button (or, while
// waiting, the progress line in its place) and a row of text buttons. Starting,
// Recording, Cleaning and Polishing share one compact height, so moving between
// them moves nothing; Ready, Failed and Unsupported grow to what their content
// needs, up to a cap, and the change of height animates.

import { App, Editor, MarkdownFileInfo, MarkdownView, Modal, Notice, TFile } from "obsidian";
import { insertAtCursor } from "./insert";
import { POLISH_LEVELS, PolishLevel, Polished } from "./polish";
import { DictationSession, Phase, SessionDeps } from "./session";

export interface Target {
	editor: Editor;
	ctx: MarkdownFileInfo;
	file: TFile;
}

const BARS = 48;

type Pill = "recording" | "amber" | "quiet" | "busy" | "error";
type Quiet = [text: string, fn: () => void, danger?: boolean];
type Step = "done" | "running" | "todo";
type Primary = [text: string, fn: () => void] | { steps: Step[] };

/** The states whose content sets the sheet's height; the rest keep the compact one. */
const GROWN: ReadonlySet<Phase["kind"]> = new Set(["ready", "failed", "unsupported"]);
/** A little longer than the 150 ms the height takes in styles.css. */
const SIZING_MS = 200;

export class DictateModal extends Modal {
	private readonly session: DictationSession;
	private readonly capMs: number;
	private readonly polishLevel: () => PolishLevel;
	private shownKind: string | null = null;
	private shownWarning = false;
	private clockEl: HTMLElement | null = null;
	private captionEl: HTMLElement | null = null;
	private canvas: HTMLCanvasElement | null = null;
	private textEl: HTMLElement | null = null;
	private sizing = 0;
	private levels: number[] = new Array<number>(BARS).fill(0);
	private frame = 0;
	private lastSample = 0;

	constructor(
		app: App,
		private readonly target: Target,
		deps: SessionDeps,
		private readonly termCount: number,
		private readonly onGone: (m: DictateModal) => void,
	) {
		super(app);
		this.session = new DictationSession(deps);
		this.capMs = deps.capMs;
		this.polishLevel = deps.polishLevel;
	}

	onOpen(): void {
		this.modalEl.addClass("spoken-modal");
		this.hideChrome();
		this.session.onChange((p) => this.render(p));
		this.render(this.session.phase);
		window.addEventListener("resize", this.onResize);
		void this.session.record();
	}

	onClose(): void {
		window.removeEventListener("resize", this.onResize);
		window.clearTimeout(this.sizing);
		this.session.close();
		this.stopWave();
		this.contentEl.empty();
		this.onGone(this);
	}

	/** Called when the user leaves the note: the take is thrown away, as in the app. */
	leftTarget(): void {
		this.close();
	}

	get file(): TFile {
		return this.target.file;
	}

	/**
	 * Obsidian's own close button and empty title are hidden inside this modal
	 * only: Cancel, Discard, Escape and the backdrop still close it. They are
	 * found as whatever in the modal is not the content, so no Obsidian class
	 * name is relied on (1.13 renamed the close button's).
	 */
	private hideChrome(): void {
		for (const child of Array.from(this.modalEl.children)) {
			if (child !== this.contentEl && !child.contains(this.contentEl)) child.addClass("spoken-chrome");
		}
	}

	private render(p: Phase): void {
		if (p.kind === "closed") return;
		const warning = p.kind === "recording" && p.warning;
		if (p.kind === this.shownKind && warning === this.shownWarning && p.kind === "recording") {
			this.updateRecording(p);
			return;
		}
		this.shownKind = p.kind;
		this.shownWarning = warning;
		this.stopWave();
		this.clockEl = this.captionEl = null;
		this.canvas = null;
		this.textEl = null;

		const el = this.contentEl;
		const from = el.isConnected ? el.offsetHeight : 0;
		el.empty();
		el.addClass("spoken");
		el.toggleClass("is-grown", GROWN.has(p.kind));
		el.createDiv({ cls: "spoken-handle" });
		const head = el.createDiv({ cls: "spoken-head" });
		const body = el.createDiv({ cls: "spoken-body" });
		const foot = el.createDiv({ cls: "spoken-foot" });
		switch (p.kind) {
			case "unsupported":
				this.head(head, "error", "Can't record");
				this.message(body, p.message);
				this.foot(foot, ["Close", () => this.close()], []);
				break;
			case "starting":
				this.head(head, "busy", "Starting");
				this.stage(body, "0:00", true, false, false, "Allow the microphone if Obsidian asks.");
				this.foot(foot, this.steps("todo", "todo"), [["Cancel", () => this.close()]]);
				this.drawWave(false);
				break;
			case "recording":
				this.head(head, p.warning ? "amber" : "recording", "Recording");
				this.stage(body, fmt(p.elapsedMs), true, p.warning, false, "");
				this.foot(foot, ["Stop", () => void this.session.stop()], [["Cancel", () => this.close()]]);
				this.updateRecording(p);
				this.startWave();
				break;
			case "cleaning":
				this.head(head, "busy", "Cleaning");
				this.stage(body, fmt(p.durationMs), false, false, true, p.terms === null ? "Sending the take" : `Biased with ${p.terms} ${plural(p.terms, "term")}`);
				this.foot(foot, this.steps("running", "todo"), [["Cancel", () => this.close()]]);
				this.drawWave(true);
				break;
			case "polishing":
				this.head(head, "busy", "Polishing");
				this.stage(body, fmt(p.durationMs), false, false, true, `${POLISH_LEVELS[p.level]} polish · names from the terms note`);
				this.foot(foot, this.steps("done", "running", true), [
					["Cancel", () => this.close()],
					["Skip", () => this.session.skipPolish()],
				]);
				this.drawWave(true);
				break;
			case "ready": {
				this.head(head, "quiet", "Ready");
				this.textEl = body.createDiv({ cls: "spoken-text", text: p.text });
				this.textEl.addEventListener("scroll", () => this.updateFade());
				const meta = body.createDiv({ cls: "spoken-meta" });
				meta.createSpan({ cls: "spoken-facts", text: `${words(p.text)} ${plural(words(p.text), "word")} · ${fmt(p.durationMs)}` });
				if (!p.targetGone) {
					this.levelControl(meta, selectedLevel(p.polish));
					if (!p.polish.ran) body.createDiv({ cls: "spoken-note", text: `Polish did not run: ${p.polish.why}. This is the transcript as heard.` });
					this.foot(foot, ["Insert", () => this.insert(p.text)], [
						["Discard", () => this.close()],
						["Retake", () => void this.session.retake()],
					]);
				} else {
					body.createDiv({ cls: ["spoken-note", "is-error"], text: `${this.target.file.basename} is no longer open for editing, so the words weren't inserted anywhere else. Copy them, or discard them.` });
					this.foot(foot, ["Copy", () => void this.copy(p.text)], [["Discard", () => this.close()]]);
				}
				break;
			}
			case "failed":
				this.head(head, "error", "Not cleaned");
				this.message(body, p.message, p.takeKept ? "Try again when you have signal, or discard it." : "Try again to record, or close.");
				this.foot(foot, ["Try again", () => void this.session.retry()], [["Discard", () => this.close(), true]]);
				break;
		}
		// The body fades in on every change of state; ticks of the same state redraw in place.
		body.addClass("is-entering");
		this.settle(from);
	}

	private onResize = (): void => {
		if (this.textEl) this.settle(0);
	};

	/**
	 * After a redraw: fit the words to whole lines, then, if the sheet's height
	 * changed, run it from the old height to the new one (styles.css times it).
	 * Nothing to measure until the sheet is in the page.
	 */
	private settle(from: number): void {
		const el = this.contentEl;
		if (!el.isConnected) return;
		window.clearTimeout(this.sizing);
		el.removeClass("is-sizing");
		el.setCssProps({ "--spoken-height": "" });
		this.fitLines();
		const to = el.offsetHeight;
		if (!from || Math.abs(to - from) < 1) return;
		el.setCssProps({ "--spoken-height": `${from}px` });
		el.addClass("is-sizing");
		void el.offsetHeight; // the old height is laid out, so the change to the new one is a transition
		el.setCssProps({ "--spoken-height": `${to}px` });
		this.sizing = window.setTimeout(() => {
			el.removeClass("is-sizing");
			el.setCssProps({ "--spoken-height": "" });
		}, SIZING_MS);
	}

	/** The words show whole lines only: their box is cut down to the last line that fits. */
	private fitLines(): void {
		const text = this.textEl;
		if (!text) return;
		text.setCssProps({ "--spoken-text-height": "" });
		const line = parseFloat(getComputedStyle(text).lineHeight);
		if (!line) return;
		const lines = Math.max(1, Math.floor((text.clientHeight + 1) / line));
		text.setCssProps({ "--spoken-text-height": `${lines * line}px` });
		this.updateFade();
	}

	/** The bottom edge fades only while there are more words below it. */
	private updateFade(): void {
		const text = this.textEl;
		if (text) text.toggleClass("is-more", text.scrollTop + text.clientHeight < text.scrollHeight - 1);
	}

	/** One quiet line: a status pill on the left, the note's name on the right. */
	private head(head: HTMLElement, pill: Pill, word: string): void {
		const state = head.createDiv({ cls: ["spoken-pill", `is-${pill}`] });
		state.createSpan({ cls: pill === "busy" ? "spoken-spin" : "spoken-dot" });
		state.createSpan({ text: word });
		head.createDiv({ cls: "spoken-into", text: this.target.file.basename });
	}

	/** Recording's hero, kept through Cleaning and Polishing: the timer, the wave, one caption. */
	private stage(body: HTMLElement, now: string, cap: boolean, amber: boolean, frozen: boolean, caption: string): void {
		const stage = body.createDiv({ cls: "spoken-stage" });
		const clock = stage.createDiv({ cls: ["spoken-clock", ...(amber ? ["is-amber"] : []), ...(frozen ? ["is-faint"] : [])] });
		this.clockEl = clock.createSpan({ cls: "spoken-now", text: now });
		if (cap) clock.createSpan({ cls: "spoken-cap", text: ` / ${fmt(this.capMs)}` });
		this.canvas = stage.createEl("canvas", { cls: ["spoken-wave", ...(frozen ? ["is-frozen"] : [])] });
		this.captionEl = stage.createDiv({ cls: ["spoken-caption", ...(amber ? ["is-amber"] : [])], text: caption });
	}

	private message(body: HTMLElement, text: string, then?: string): void {
		const box = body.createDiv({ cls: "spoken-message" });
		box.createDiv({ cls: "spoken-message-text", text });
		if (then) box.createDiv({ cls: "spoken-message-then", text: then });
	}

	/**
	 * One full-width primary button, or while waiting the progress line at the
	 * same height, so Cancel stays where it was; then the quiet ones as text in
	 * one row.
	 */
	private foot(foot: HTMLElement, primary: Primary, quiet: Quiet[]): void {
		if ("steps" in primary) {
			this.progress(foot, primary.steps);
		} else {
			const b = foot.createEl("button", { cls: ["spoken-primary", "mod-cta"], text: primary[0] });
			b.addEventListener("click", primary[1]);
		}
		if (!quiet.length) return;
		const row = foot.createDiv({ cls: "spoken-quiet-row" });
		for (const [text, fn, danger] of quiet) {
			const b = row.createEl("button", { cls: ["spoken-quiet", ...(danger ? ["is-danger"] : [])], text });
			b.addEventListener("click", fn);
		}
	}

	/** Transcribe, then Polish unless it is off: where this take is. */
	private steps(transcribe: Step, polish: Step, polishing = false): Primary {
		return { steps: polishing || this.polishLevel() !== "off" ? [transcribe, polish] : [transcribe] };
	}

	/** Two thin segments (one when Polish is off), each named beneath: done in the accent colour, running shimmering, to come muted. */
	private progress(foot: HTMLElement, steps: Step[]): void {
		const line = foot.createDiv({ cls: "spoken-progress", attr: { role: "list", "aria-label": "Progress" } });
		steps.forEach((step, i) => {
			const item = line.createDiv({
				cls: ["spoken-step", `is-${step}`],
				attr: { role: "listitem", ...(step === "running" ? { "aria-current": "step" } : {}) },
			});
			item.createDiv({ cls: "spoken-step-bar" });
			item.createDiv({ cls: "spoken-step-label", text: i === 0 ? "Transcribe" : "Polish" });
		});
	}

	/** Off · Light · Full: the level this take shows, and the others one tap away (each re-polishes the kept transcript). */
	private levelControl(meta: HTMLElement, current: PolishLevel | null): void {
		const seg = meta.createDiv({ cls: "spoken-seg", attr: { role: "group", "aria-label": "Polish" } });
		for (const level of Object.keys(POLISH_LEVELS) as PolishLevel[]) {
			const on = level === current;
			const b = seg.createEl("button", {
				cls: ["spoken-seg-item", ...(on ? ["is-active"] : [])],
				text: POLISH_LEVELS[level],
				attr: { "aria-pressed": on ? "true" : "false" },
			});
			b.addEventListener("click", () => {
				if (!on) void this.session.repolish(level);
			});
		}
	}

	private updateRecording(p: Extract<Phase, { kind: "recording" }>): void {
		this.clockEl?.setText(fmt(p.elapsedMs));
		if (!this.captionEl) return;
		if (p.warning) {
			const left = Math.max(0, Math.ceil((this.capMs - p.elapsedMs) / 1000));
			this.captionEl.setText(`${left} ${plural(left, "second")} left`);
		} else {
			this.captionEl.setText(`Names and terms: ${this.termCount}`);
		}
	}

	// The wave: a canvas of recent loudness, so nothing is styled inline.

	private startWave(): void {
		const step = (t: number) => {
			if (t - this.lastSample > 90) {
				this.lastSample = t;
				this.levels.push(this.session.level());
				this.levels.shift();
			}
			this.drawWave(false);
			this.frame = window.requestAnimationFrame(step);
		};
		this.frame = window.requestAnimationFrame(step);
	}

	private stopWave(): void {
		if (this.frame) window.cancelAnimationFrame(this.frame);
		this.frame = 0;
	}

	private drawWave(frozen: boolean): void {
		const canvas = this.canvas;
		if (!canvas) return;
		const ratio = window.devicePixelRatio || 1;
		const w = canvas.clientWidth, h = canvas.clientHeight;
		if (!w || !h) return;
		if (canvas.width !== Math.round(w * ratio)) canvas.width = Math.round(w * ratio);
		if (canvas.height !== Math.round(h * ratio)) canvas.height = Math.round(h * ratio);
		const g = canvas.getContext("2d");
		if (!g) return;
		g.setTransform(ratio, 0, 0, ratio, 0, 0);
		g.clearRect(0, 0, w, h);
		g.fillStyle = getComputedStyle(canvas).color;
		// Full width: the bars share it, with gaps as wide as the bars.
		const pitch = w / BARS, bar = Math.max(2, pitch * 0.5);
		this.levels.forEach((v, i) => {
			const bh = Math.max(bar, Math.min(h, (frozen ? 0.12 + 0.45 * v : 0.06 + v) * h));
			const x = i * pitch + (pitch - bar) / 2, y = (h - bh) / 2, r = bar / 2;
			// A pill per bar: a rectangle with round ends.
			g.beginPath();
			g.arc(x + r, y + r, r, Math.PI, 0);
			g.arc(x + r, y + bh - r, r, 0, Math.PI);
			g.closePath();
			g.fill();
		});
	}

	// Insert, or Copy when the editor is gone.

	private insert(text: string): void {
		if (!this.targetAlive()) {
			this.session.targetGone();
			return;
		}
		insertAtCursor(this.target.editor, text);
		// The cursor now sits after the words; don't let the modal put it back.
		this.shouldRestoreSelection = false;
		this.close();
	}

	private targetAlive(): boolean {
		const { ctx, editor, file } = this.target;
		if (ctx.file !== file || ctx.editor !== editor) return false;
		if (ctx instanceof MarkdownView) return ctx.getMode() === "source" && ctx.containerEl.isConnected;
		return true;
	}

	private async copy(text: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
			new Notice("Spoken: copied the words.");
			this.close();
		} catch {
			new Notice("Spoken: couldn't copy. Select the text in the sheet and copy it by hand.");
		}
	}
}

/** The segment lit on the Ready sheet: the level that ran, or none when Polish fell back to the transcript. */
export function selectedLevel(p: Polished): PolishLevel | null {
	return p.ran ? p.level : null;
}

function fmt(ms: number): string {
	const s = Math.floor(ms / 1000);
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function words(text: string): number {
	const t = text.trim();
	return t ? t.split(/\s+/).length : 0;
}

function plural(n: number, word: string): string {
	return n === 1 ? word : word + "s";
}
