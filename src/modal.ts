// The sheet: an Obsidian Modal, drawn as a bottom sheet on a phone. It draws
// the session's phase (design/playground renders every one) and forwards the
// buttons. Words land only on Insert; any other way out throws the take away.
//
// Every state has the same frame: a handle, one header line (a status pill and
// the note's name), one hero, then a footer of at most one primary button and
// a row of text buttons pinned to the bottom of a fixed-height sheet, so a
// state change swaps the hero without anything around it moving.

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

export class DictateModal extends Modal {
	private readonly session: DictationSession;
	private readonly capMs: number;
	private shownKind: string | null = null;
	private shownWarning = false;
	private clockEl: HTMLElement | null = null;
	private captionEl: HTMLElement | null = null;
	private canvas: HTMLCanvasElement | null = null;
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
	}

	onOpen(): void {
		this.modalEl.addClass("spoken-modal");
		this.hideChrome();
		this.session.onChange((p) => this.render(p));
		this.render(this.session.phase);
		void this.session.record();
	}

	onClose(): void {
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

		const el = this.contentEl;
		el.empty();
		el.addClass("spoken");
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
				this.foot(foot, null, [["Cancel", () => this.close()]]);
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
				this.foot(foot, null, [["Cancel", () => this.close()]]);
				this.drawWave(true);
				break;
			case "polishing":
				this.head(head, "busy", "Polishing");
				this.stage(body, fmt(p.durationMs), false, false, true, `${POLISH_LEVELS[p.level]} polish · names from the terms note`);
				this.foot(foot, null, [
					["Cancel", () => this.close()],
					["Skip", () => this.session.skipPolish()],
				]);
				this.drawWave(true);
				break;
			case "ready": {
				this.head(head, "quiet", "Ready");
				body.createDiv({ cls: "spoken-text", text: p.text });
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
	 * At most one full-width primary button, then the quiet ones as text in one
	 * row. Without a primary, its room is kept, so Cancel stays where it was.
	 */
	private foot(foot: HTMLElement, primary: [string, () => void] | null, quiet: Quiet[]): void {
		if (primary) {
			const b = foot.createEl("button", { cls: ["spoken-primary", "mod-cta"], text: primary[0] });
			b.addEventListener("click", primary[1]);
		} else {
			foot.createDiv({ cls: "spoken-primary-room" });
		}
		if (!quiet.length) return;
		const row = foot.createDiv({ cls: "spoken-quiet-row" });
		for (const [text, fn, danger] of quiet) {
			const b = row.createEl("button", { cls: ["spoken-quiet", ...(danger ? ["is-danger"] : [])], text });
			b.addEventListener("click", fn);
		}
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
