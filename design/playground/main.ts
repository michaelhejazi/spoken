// The playground: the real sheet (src/modal.ts, styles.css) in every state, in
// a phone frame and at desktop width, light and dark. A state is drawn by
// handing the sheet a phase as the session would; buttons are logged instead
// of acting, and a sheet that closes opens again in the same state. Moving
// between states redraws the open sheet, so a change of height animates as
// it does in the app.

import { DictateModal } from "../../src/modal";
import type { Phase, SessionDeps } from "../../src/session";
import { App, Modal, TFile } from "./obsidian-stub";

const CAP_MS = 5 * 60_000;
const NOTE = "Trail notes — the one-customer question";

const SHORT = "Call Simin back about the trial before Friday.";
const LONG =
	"Walked the ridge loop before the call with Simin. What I keep coming back to is the one-customer question. " +
	"Flio has about ten practices paying; if I take the trial to year end at five to ten hours a week, the thing to decide first is which single practice we design for, not the equity.\n\n" +
	"Second thing: the onboarding call. Every practice asked the same three questions in the first ten minutes, and none of them were about price. " +
	"They wanted to know who sees the recordings, whether the front desk has to change anything, and what happens when the internet drops in the middle of a day. " +
	"If the answers to those fit on one page, that page is the sales deck.\n\n" +
	"Last: book the dentist, and ask Lena whether the cabin is free the second weekend of November.";

interface State {
	name: string;
	phase: Phase;
	/** Polish set to Off in settings: the progress line has one step. */
	polishOff?: true;
}

const ready = (text: string, extra: Partial<Extract<Phase, { kind: "ready" }>> = {}): Phase => ({
	kind: "ready",
	text,
	biased: true,
	durationMs: 42_000,
	targetGone: false,
	polish: { text, level: "light", ran: true },
	...extra,
});

const STATES: State[] = [
	{ name: "Starting", phase: { kind: "starting" } },
	{ name: "Recording", phase: { kind: "recording", elapsedMs: 42_000, warning: false } },
	{ name: "Recording, 30 s left", phase: { kind: "recording", elapsedMs: CAP_MS - 28_000, warning: true } },
	{ name: "Cleaning", phase: { kind: "cleaning", durationMs: 42_000, terms: 12 } },
	{ name: "Cleaning, Polish off", phase: { kind: "cleaning", durationMs: 42_000, terms: 12 }, polishOff: true },
	{ name: "Polishing", phase: { kind: "polishing", durationMs: 42_000, level: "light" } },
	{ name: "Ready, long", phase: ready(LONG) },
	{ name: "Ready, short", phase: ready(SHORT) },
	{ name: "Ready, not polished", phase: ready(SHORT, { polish: { text: SHORT, level: "light", ran: false, why: "Gemini took too long" } }) },
	{ name: "Ready, note gone", phase: ready(SHORT, { targetGone: true }) },
	{ name: "Failed", phase: { kind: "failed", message: "Google couldn't be reached. The recording is still here.", durationMs: 42_000, takeKept: true } },
	{ name: "Unsupported", phase: { kind: "unsupported", message: "This device can't record audio in Obsidian, so there is nothing to dictate with here." } },
];

/** A canned loudness track: syllables in phrases with pauses, 0..1, the same every load. */
function loudness(t: number): number {
	const phrase = (t % 4.2) / 4.2;
	if (phrase > 0.82) return 0.03 + 0.02 * Math.abs(Math.sin(t * 31));
	const syllable = Math.abs(Math.sin(t * 9.5)) * (0.55 + 0.45 * Math.sin(t * 2.3 + 1));
	const grain = 0.08 * Math.abs(Math.sin(t * 57));
	return Math.min(1, 0.06 + 0.75 * syllable + grain);
}

const track = (n: number) => Array.from({ length: n }, (_, i) => loudness(i * 0.09));

// What the sheet would tell the session, as private fields seen from here.
interface Inside {
	render(p: Phase): void;
	levels: number[];
	session: Record<string, unknown> & { level(): number };
}

const ACTIONS = ["stop", "retry", "retake", "repolish", "skipPolish"] as const;

function log(text: string): void {
	const el = document.getElementById("log");
	if (el) el.textContent = text;
}

class Frame {
	private modal: DictateModal | null = null;
	private state: State | null = null;
	private ticker = 0;

	constructor(private readonly host: HTMLElement) {}

	show(state: State): void {
		this.state = state;
		window.clearInterval(this.ticker);
		const modal = this.modal ?? this.open();
		const inside = modal as unknown as Inside;
		// Mid-take, as if recorded so far; a sheet still waiting for the microphone has heard nothing.
		inside.levels = state.phase.kind === "starting" ? inside.levels.map(() => 0) : track(inside.levels.length);
		inside.render(state.phase);

		const p = state.phase;
		if (p.kind === "recording") {
			const start = Date.now() - p.elapsedMs;
			this.ticker = window.setInterval(() => {
				let elapsedMs = Date.now() - start;
				if (elapsedMs >= CAP_MS) elapsedMs = CAP_MS - 1000;
				inside.render({ kind: "recording", elapsedMs, warning: p.warning });
			}, 200);
		}
	}

	private open(): DictateModal {
		Modal.host = this.host;
		const deps = {
			// A microphone that is always about to start: the page sets the phase itself.
			recorders: () => ({ start: () => new Promise<void>(() => {}), stop: () => new Promise(() => {}), release() {}, level: () => 0, onError: null }),
			transcriber: { transcribe: () => new Promise(() => {}) },
			terms: () => [],
			polisher: { polish: () => new Promise(() => {}) },
			polishLevel: () => (this.state?.polishOff ? "off" : "light"),
			polishTerms: () => [],
			capMs: CAP_MS,
			clock: { now: () => Date.now(), every: () => () => {} },
			signal: () => {},
			awake: { hold() {}, release() {} },
		} as unknown as SessionDeps;
		const editor = { getCursor: () => ({ line: 0, ch: 0 }), getLine: () => "", transaction() {}, focus() {} };
		const file = new TFile(NOTE);
		const modal = new DictateModal(new App() as never, { editor, ctx: { file, editor }, file } as never, deps, 12, () => {
			this.modal = null;
			window.clearInterval(this.ticker);
			log("Closed: the take is thrown away. Opening it again…");
			window.setTimeout(() => {
				if (this.state) this.show(this.state);
			}, 900);
		});
		this.modal = modal;
		modal.open();

		const inside = modal as unknown as Inside;
		let t = 0;
		inside.session.level = () => loudness((t += 0.09));
		for (const name of ACTIONS) {
			inside.session[name] = (arg?: string) => log(`Pressed: session.${name}(${arg ?? ""})`);
		}
		return modal;
	}
}

const frames = [new Frame(document.getElementById("phone-host")!), new Frame(document.getElementById("desk-host")!)];
const bar = document.getElementById("states")!;
let current = 0;

const slug = (s: State) => s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-$/, "");

function select(i: number): void {
	current = i;
	history.replaceState(null, "", `#${slug(STATES[i])}`);
	bar.querySelectorAll("button").forEach((b, j) => b.classList.toggle("is-on", j === i));
	log("");
	for (const f of frames) f.show(STATES[i]);
}

STATES.forEach((s, i) => {
	bar.createEl("button", { text: s.name }).addEventListener("click", () => select(i));
});

document.getElementById("theme")!.addEventListener("click", (ev) => {
	const dark = document.body.classList.toggle("theme-dark");
	document.body.classList.toggle("theme-light", !dark);
	(ev.target as HTMLElement).textContent = dark ? "Light" : "Dark";
});

document.addEventListener("keydown", (ev) => {
	if (ev.target instanceof HTMLInputElement) return;
	if (ev.key === "ArrowRight") select((current + 1) % STATES.length);
	if (ev.key === "ArrowLeft") select((current - 1 + STATES.length) % STATES.length);
});

// A state and theme can be linked: #ready-long, #ready-long/light.
const [want, theme] = location.hash.slice(1).split("/");
if (theme === "light") document.getElementById("theme")!.click();
const found = STATES.findIndex((s) => slug(s) === want);
select(found >= 0 ? found : 1);
