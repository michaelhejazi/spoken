import { describe, expect, it } from "vitest";
import { PolishError, PolishLevel, Polisher, WHY_SKIPPED } from "../src/polish";
import type { Phrase } from "../src/links";
import { mediaRecorderFactory } from "../src/recorder";
import { CANNOT_RECORD, Clock, DictationSession, Phase, TICK_MS } from "../src/session";
import { HAPTICS, Signals } from "../src/signals";
import { Transcriber, TranscribeError, Transcript } from "../src/transcriber";
import { ScreenWake } from "../src/wakelock";
import { fakeMic } from "./fake-media";
import { fakeWake } from "./fake-wake";

const CAP = 60_000;

function fakeClock() {
	let now = 1_000_000;
	const timers = new Set<{ ms: number; fn: () => void; next: number }>();
	const clock: Clock = {
		now: () => now,
		every: (ms, fn) => {
			const t = { ms, fn, next: now + ms };
			timers.add(t);
			return () => timers.delete(t);
		},
	};
	return {
		clock,
		running: () => timers.size,
		advance(ms: number) {
			const end = now + ms;
			while (true) {
				const due = [...timers].filter((t) => t.next <= end).sort((a, b) => a.next - b.next)[0];
				if (!due) break;
				now = due.next;
				due.next += due.ms;
				due.fn();
			}
			now = end;
		},
	};
}

/** A transcriber whose answers the test hands out. */
function fakeTranscriber() {
	const calls: Array<{ audio: ArrayBuffer; mimeType: string; terms: string[]; resolve: (t: Transcript) => void; reject: (e: unknown) => void }> = [];
	const t: Transcriber = {
		transcribe: (audio, mimeType, terms) =>
			new Promise<Transcript>((resolve, reject) => calls.push({ audio, mimeType, terms, resolve, reject })),
	};
	return { t, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A phone's vibration and tone, remembering what they were asked to do. */
function fakeSignals(vibrate: "works" | "missing" | "refuses" = "works") {
	const vibrations: number[][] = [];
	const tones: number[][] = [];
	const signals = new Signals(() => ({
		vibrate:
			vibrate === "missing"
				? undefined
				: (p: number[]) => {
						vibrations.push(p);
						return vibrate === "works";
					},
		tone: (p) => tones.push([...p]),
	}));
	return { signals, vibrations, tones };
}

function setup(
	opts: {
		mediaRecorder?: boolean;
		vibrate?: "works" | "missing" | "refuses";
		terms?: () => string[] | Promise<string[]>;
		/** Off unless a test is about Polish, so the paths before it read as they always have. */
		polish?: PolishLevel;
		polisher?: Polisher;
		/** The Links setting; off unless a test is about links. */
		links?: () => boolean;
		phrases?: () => Phrase[] | Promise<Phrase[]>;
	} = {},
) {
	const mic = fakeMic(opts);
	const time = fakeClock();
	const tx = fakeTranscriber();
	const wake = fakeWake();
	const sig = fakeSignals(opts.vibrate);
	const session = new DictationSession({
		recorders: mediaRecorderFactory(() => mic.env),
		transcriber: tx.t,
		terms: opts.terms ?? (() => ["Quillmate", "Vecso"]),
		polisher: opts.polisher ?? { polish: () => Promise.reject(new Error("Polish is off in this test")) },
		polishLevel: () => opts.polish ?? "off",
		polishTerms: () => ["Quillmate", "Vecso", "Vexo"],
		links: opts.links ?? (() => false),
		linkPhrases: opts.phrases ?? (() => []),
		capMs: CAP,
		clock: time.clock,
		signal: (m) => sig.signals.signal(m),
		awake: new ScreenWake(wake.env),
	});
	const phases: Phase["kind"][] = [];
	session.onChange((p) => phases.push(p.kind));
	return { mic, time, tx, wake, sig, session, phases };
}

describe("the sheet's session, through every way out", () => {
	it("Stop → cleaning → ready → Insert: the microphone is released at Stop", async () => {
		const s = setup();
		await s.session.record();
		expect(s.session.phase.kind).toBe("recording");
		expect(s.mic.released()).toBe(false);
		s.time.advance(22_000);
		expect(s.session.phase).toEqual({ kind: "recording", elapsedMs: 22_000, warning: false });

		const stopping = s.session.stop();
		expect(s.session.phase).toEqual({ kind: "cleaning", durationMs: 22_000, terms: null });
		await flush();
		expect(s.mic.released()).toBe(true);
		expect(s.time.running()).toBe(0);
		expect(s.tx.calls).toHaveLength(1);
		expect(s.tx.calls[0].mimeType).toBe("audio/webm;codecs=opus");
		expect(s.tx.calls[0].terms).toEqual(["Quillmate", "Vecso"]);
		expect(s.session.phase).toEqual({ kind: "cleaning", durationMs: 22_000, terms: 2 });

		s.tx.calls[0].resolve({ text: "Walked the ridge.", biased: true });
		await stopping;
		expect(s.session.phase).toEqual({
			kind: "ready",
			text: "Walked the ridge.",
			biased: true,
			durationMs: 22_000,
			targetGone: false,
			polish: { text: "Walked the ridge.", level: "off", ran: true },
		});

		s.session.close(); // Insert closes the sheet once the words are in.
		expect(s.session.phase.kind).toBe("closed");
		expect(s.mic.released()).toBe(true);
	});

	it("Cancel while recording releases the microphone and sends nothing", async () => {
		const s = setup();
		await s.session.record();
		s.time.advance(5_000);
		s.session.close();
		expect(s.session.phase.kind).toBe("closed");
		expect(s.mic.released()).toBe(true);
		expect(s.time.running()).toBe(0);
		await flush();
		expect(s.tx.calls).toHaveLength(0);
	});

	it("closing while the permission prompt is up releases the microphone when it arrives", async () => {
		const s = setup();
		const grant = s.mic.holdPermission();
		const recording = s.session.record();
		expect(s.session.phase.kind).toBe("starting");
		s.session.close();
		grant();
		await recording;
		expect(s.session.phase.kind).toBe("closed");
		expect(s.mic.tracks).toHaveLength(1);
		expect(s.mic.released()).toBe(true);
		expect(s.time.running()).toBe(0);
	});

	it("a refused microphone is a sentence, not a crash; Try again asks again", async () => {
		const s = setup();
		s.mic.denyNext("NotAllowedError");
		await s.session.record();
		const p = s.session.phase;
		expect(p.kind).toBe("failed");
		if (p.kind === "failed") {
			expect(p.message).toMatch(/isn't allowed to use the microphone/);
			expect(p.takeKept).toBe(false);
		}
		await s.session.retry();
		expect(s.session.phase.kind).toBe("recording");
		s.session.close();
		expect(s.mic.released()).toBe(true);
	});

	it("a recorder error mid-take releases the microphone and says so", async () => {
		const s = setup();
		await s.session.record();
		s.time.advance(3_000);
		s.mic.recorders[0].fail();
		const p = s.session.phase;
		expect(p).toEqual({ kind: "failed", message: "Recording stopped because the microphone failed.", durationMs: 3_000, takeKept: false });
		expect(s.mic.released()).toBe(true);
		expect(s.time.running()).toBe(0);
		s.session.close();
	});

	it("thirty seconds before the cap it warns; at the cap it stops by itself", async () => {
		const s = setup();
		await s.session.record();
		s.time.advance(CAP - 30_000 - TICK_MS);
		expect(s.session.phase).toMatchObject({ kind: "recording", warning: false });
		s.time.advance(TICK_MS);
		expect(s.session.phase).toMatchObject({ kind: "recording", warning: true });
		s.time.advance(30_000);
		expect(s.session.phase).toEqual({ kind: "cleaning", durationMs: CAP, terms: null });
		await flush();
		expect(s.mic.released()).toBe(true);
		expect(s.tx.calls).toHaveLength(1);
		s.session.close();
	});

	it("Cancel while cleaning throws the take away; a late answer changes nothing", async () => {
		const s = setup();
		await s.session.record();
		const stopping = s.session.stop();
		await flush();
		s.session.close();
		s.tx.calls[0].resolve({ text: "too late", biased: false });
		await stopping;
		expect(s.session.phase.kind).toBe("closed");
		expect(s.mic.released()).toBe(true);
	});

	it("not cleaned keeps the take; Try again resends the same audio", async () => {
		const s = setup();
		await s.session.record();
		s.time.advance(8_000);
		const stopping = s.session.stop();
		await flush();
		s.tx.calls[0].reject(new TranscribeError("Google couldn't be reached. The recording is still here.", 0));
		await stopping;
		expect(s.session.phase).toEqual({
			kind: "failed",
			message: "Google couldn't be reached. The recording is still here.",
			durationMs: 8_000,
			takeKept: true,
		});
		expect(s.mic.released()).toBe(true);

		const retrying = s.session.retry();
		expect(s.session.phase.kind).toBe("cleaning");
		await flush();
		expect(s.tx.calls).toHaveLength(2);
		expect(s.tx.calls[1].audio).toBe(s.tx.calls[0].audio);
		expect(s.mic.tracks).toHaveLength(1); // no new recording
		s.tx.calls[1].resolve({ text: "Here now.", biased: false });
		await retrying;
		expect(s.session.phase.kind).toBe("ready");
		s.session.close();
	});

	it("Retake records afresh; closing then releases the new microphone too", async () => {
		const s = setup();
		await s.session.record();
		const stopping = s.session.stop();
		await flush();
		s.tx.calls[0].resolve({ text: "First go.", biased: false });
		await stopping;
		await s.session.retake();
		expect(s.session.phase).toEqual({ kind: "recording", elapsedMs: 0, warning: false });
		expect(s.mic.tracks).toHaveLength(2);
		expect(s.mic.tracks[0].stopped).toBe(true);
		expect(s.mic.tracks[1].stopped).toBe(false);
		s.session.close();
		expect(s.mic.released()).toBe(true);
	});

	it("an editor gone at Insert keeps the words and marks the target gone", async () => {
		const s = setup();
		await s.session.record();
		const stopping = s.session.stop();
		await flush();
		s.tx.calls[0].resolve({ text: "Keep me.", biased: false });
		await stopping;
		s.session.targetGone();
		expect(s.session.phase).toMatchObject({ kind: "ready", text: "Keep me.", targetGone: true });
		s.session.close();
	});

	it("where the platform cannot record, the session says so instead of failing", async () => {
		const s = setup({ mediaRecorder: false });
		await expect(s.session.record()).resolves.toBeUndefined();
		expect(s.session.phase).toEqual({ kind: "unsupported", message: CANNOT_RECORD });
		expect(s.mic.tracks).toHaveLength(0);
		s.session.close();
		expect(s.session.phase.kind).toBe("closed");
	});
});

describe("the terms are read when the take is sent", () => {
	it("waits for a terms note read from the vault, then sends what it held", async () => {
		let reads = 0;
		const s = setup({ terms: async () => (reads++, ["From the note"]) });
		await s.session.record();
		expect(reads).toBe(0);
		s.time.advance(5_000);
		void s.session.stop();
		await flush();
		expect(reads).toBe(1);
		expect(s.tx.calls[0].terms).toEqual(["From the note"]);
		expect(s.session.phase).toMatchObject({ kind: "cleaning", terms: 1 });
	});

	it("the first take's cleaning sheet is drawn with that take's count, and so is every take after (issue #1)", async () => {
		let note = ["Quillmate", "Vecso", "Ridge"];
		const s = setup({ terms: async () => note });
		const counts: Array<number | null> = [];
		s.session.onChange((p) => p.kind === "cleaning" && counts.push(p.terms));
		await s.session.record();
		s.time.advance(5_000);
		void s.session.stop();
		await flush();
		expect(counts).toEqual([null, 3]);
		s.tx.calls[0].resolve({ text: "One.", biased: true });
		await flush();

		note = ["Quillmate"];
		counts.length = 0;
		await s.session.retake();
		s.time.advance(5_000);
		void s.session.stop();
		await flush();
		expect(counts).toEqual([null, 1]);
	});

	it("a sheet closed while the note is being read sends nothing", async () => {
		let release!: (t: string[]) => void;
		const s = setup({ terms: () => new Promise<string[]>((r) => (release = r)) });
		await s.session.record();
		void s.session.stop();
		await flush();
		s.session.close();
		release(["late"]);
		await flush();
		expect(s.tx.calls).toHaveLength(0);
		expect(s.session.phase.kind).toBe("closed");
	});
});

describe("the screen stays on while recording, and only then", () => {
	/** Records, checks the lock is held, runs the way out, checks it is let go. */
	async function exits(way: (s: ReturnType<typeof setup>) => Promise<unknown> | void) {
		const s = setup();
		expect(s.wake.held()).toBe(0);
		await s.session.record();
		expect(s.session.phase.kind).toBe("recording");
		await flush();
		expect(s.wake.held()).toBe(1);
		s.time.advance(2_000); // ticks while recording don't ask again
		expect(s.wake.requests()).toBe(1);
		await way(s);
		await flush();
		expect(s.wake.held()).toBe(0);
		return s;
	}

	it("Stop lets it go", async () => {
		await exits(async (s) => {
			const stopping = s.session.stop();
			await flush();
			s.tx.calls[0].resolve({ text: "x", biased: false });
			await stopping;
		});
	});

	it("Cancel lets it go", async () => {
		await exits((s) => s.session.close());
	});

	it("the cap lets it go", async () => {
		await exits((s) => s.time.advance(CAP));
	});

	it("a microphone error lets it go", async () => {
		const s = await exits((s) => s.mic.recorders[0].fail());
		expect(s.session.phase.kind).toBe("failed");
	});

	it("Retake holds it again for the new take, and closing lets it go", async () => {
		await exits(async (s) => {
			const stopping = s.session.stop();
			await flush();
			s.tx.calls[0].resolve({ text: "x", biased: false });
			await stopping;
			expect(s.wake.held()).toBe(0);
			await s.session.retake();
			await flush();
			expect(s.wake.held()).toBe(1);
			s.session.close();
		});
	});

	it("is not asked for while waiting for the microphone, nor when it is refused", async () => {
		const s = setup();
		s.mic.denyNext("NotAllowedError");
		await s.session.record();
		await flush();
		expect(s.session.phase.kind).toBe("failed");
		expect(s.wake.requests()).toBe(0);
	});

	it("is asked for again when the page is shown again mid-take, and not after", async () => {
		const s = setup();
		await s.session.record();
		await flush();
		s.wake.hide();
		expect(s.wake.held()).toBe(0);
		s.wake.show();
		await flush();
		expect(s.wake.requests()).toBe(2);
		expect(s.wake.held()).toBe(1);
		s.session.close();
		await flush();
		expect(s.wake.held()).toBe(0);
		s.wake.hide();
		s.wake.show();
		await flush();
		expect(s.wake.requests()).toBe(2);
	});

	it("where there is no Wake Lock API, recording goes on without it", async () => {
		const wake = fakeWake({ api: false });
		const w = new ScreenWake(wake.env);
		expect(w.supported).toBe(false);
		w.hold();
		w.release();
		expect(wake.requests()).toBe(0);
	});
});

describe("one haptic language: three moments and no others", () => {
	it("a tap at start, two pulses thirty seconds before the cap, one long pulse at the cap", async () => {
		const s = setup();
		await s.session.record();
		expect(s.sig.vibrations).toEqual([[40]]);
		s.time.advance(CAP - 30_000 - TICK_MS);
		expect(s.sig.vibrations).toHaveLength(1);
		s.time.advance(TICK_MS);
		expect(s.sig.vibrations).toEqual([[40], [150, 100, 150]]);
		s.time.advance(29_000);
		expect(s.sig.vibrations).toHaveLength(2);
		s.time.advance(1_000);
		expect(s.session.phase.kind).toBe("cleaning");
		expect(s.sig.vibrations).toEqual([[40], [150, 100, 150], [500]]);
		expect(s.sig.tones).toEqual([]);
		await flush();
		s.tx.calls[0].resolve({ text: "x", biased: false });
		await flush();
		s.session.close();
		expect(s.sig.vibrations).toHaveLength(3);
	});

	it("the patterns are the ones in src/signals.ts", () => {
		expect(HAPTICS).toEqual({ started: [40], warning: [150, 100, 150], cap: [500] });
	});

	it("a Stop pressed before the warning gets only the start tap", async () => {
		const s = setup();
		await s.session.record();
		s.time.advance(10_000);
		const stopping = s.session.stop();
		await flush();
		s.tx.calls[0].resolve({ text: "x", biased: false });
		await stopping;
		expect(s.sig.vibrations).toEqual([[40]]);
		s.session.close();
	});

	it("a Stop pressed after the warning gets no buzz of its own", async () => {
		const s = setup();
		await s.session.record();
		s.time.advance(CAP - 10_000);
		const stopping = s.session.stop();
		await flush();
		s.tx.calls[0].resolve({ text: "x", biased: false });
		await stopping;
		expect(s.sig.vibrations).toEqual([[40], [150, 100, 150]]);
		s.session.close();
	});

	it("Cancel and a microphone error get none either", async () => {
		const a = setup();
		await a.session.record();
		a.session.close();
		const b = setup();
		await b.session.record();
		b.mic.recorders[0].fail();
		expect(a.sig.vibrations).toEqual([[40]]);
		expect(b.sig.vibrations).toEqual([[40]]);
	});

	for (const vibrate of ["missing", "refuses"] as const) {
		it(`where vibrate ${vibrate === "missing" ? "is missing" : "returns false"}, the two later moments play a tone`, async () => {
			const s = setup({ vibrate });
			await s.session.record();
			expect(s.sig.tones).toEqual([]); // no tone at start
			s.time.advance(CAP - 30_000);
			expect(s.sig.tones).toEqual([[150, 100, 150]]);
			s.time.advance(30_000);
			expect(s.sig.tones).toEqual([[150, 100, 150], [500]]);
			expect(s.sig.signals.path()).toBe(vibrate === "missing" ? "tone: no vibration" : "tone: vibration refused");
			s.session.close();
		});
	}

	it("where vibrate works, the path is vibration and no tone plays", async () => {
		const s = setup();
		expect(s.sig.signals.path()).toBe("vibration");
		await s.session.record();
		s.time.advance(CAP);
		expect(s.sig.tones).toEqual([]);
		expect(s.sig.signals.path()).toBe("vibration");
		s.session.close();
	});
});

/** A polisher whose answers the test hands out. */
function fakePolisher() {
	const calls: Array<{ text: string; level: string; terms: string[]; resolve: (t: string) => void; reject: (e: unknown) => void }> = [];
	const p: Polisher = {
		polish: (text, level, terms) => new Promise<string>((resolve, reject) => calls.push({ text, level, terms, resolve, reject })),
	};
	return { p, calls };
}

describe("Polish, between cleaning and ready", () => {
	async function toPolishing(level: PolishLevel = "light") {
		const pol = fakePolisher();
		const s = setup({ polish: level, polisher: pol.p });
		await s.session.record();
		s.time.advance(10_000);
		const stopping = s.session.stop();
		await flush();
		s.tx.calls[0].resolve({ text: "tell vekso hello", biased: true });
		await flush();
		return { ...s, pol, stopping };
	}

	it("Stop → cleaning → polishing → ready, with the whole terms list and the level that ran", async () => {
		const s = await toPolishing("light");
		expect(s.session.phase).toEqual({ kind: "polishing", durationMs: 10_000, level: "light" });
		expect(s.pol.calls).toHaveLength(1);
		expect(s.pol.calls[0]).toMatchObject({ text: "tell vekso hello", level: "light", terms: ["Quillmate", "Vecso", "Vexo"] });
		s.pol.calls[0].resolve("Tell Vexo hello.");
		await s.stopping;
		expect(s.session.phase).toMatchObject({ kind: "ready", text: "Tell Vexo hello.", biased: true, polish: { level: "light", ran: true } });
		expect(s.phases.filter((k, i) => k !== s.phases[i - 1])).toEqual(["starting", "recording", "cleaning", "polishing", "ready"]);
	});

	it("a polish error is never a failed take: the transcript is ready, with why", async () => {
		const s = await toPolishing("full");
		s.pol.calls[0].reject(new PolishError("Gemini took too long"));
		await s.stopping;
		expect(s.session.phase).toMatchObject({
			kind: "ready",
			text: "tell vekso hello",
			polish: { level: "full", ran: false, why: "Gemini took too long" },
		});
	});

	it("Skip while polishing shows the transcript at once, and the late answer is ignored", async () => {
		const s = await toPolishing("light");
		s.session.skipPolish();
		expect(s.session.phase).toMatchObject({ kind: "ready", text: "tell vekso hello", polish: { ran: false, why: WHY_SKIPPED } });
		s.pol.calls[0].resolve("Tell Vexo hello.");
		await s.stopping;
		expect(s.session.phase).toMatchObject({ kind: "ready", text: "tell vekso hello" });
	});

	it("another level re-polishes the kept transcript: no re-recording, no re-transcribing", async () => {
		const s = await toPolishing("light");
		s.pol.calls[0].resolve("Tell Vexo hello.");
		await s.stopping;
		const again = s.session.repolish("full");
		expect(s.session.phase).toEqual({ kind: "polishing", durationMs: 10_000, level: "full" });
		await flush();
		expect(s.pol.calls[1]).toMatchObject({ text: "tell vekso hello", level: "full" });
		s.pol.calls[1].resolve("Tell Vexo hello!");
		await again;
		expect(s.session.phase).toMatchObject({ kind: "ready", text: "Tell Vexo hello!", polish: { level: "full", ran: true } });
		await s.session.repolish("off");
		expect(s.session.phase).toMatchObject({ kind: "ready", text: "tell vekso hello", polish: { level: "off", ran: true } });
		expect(s.tx.calls).toHaveLength(1);
		expect(s.mic.recorders).toHaveLength(1);
	});

	it("Off goes straight from cleaning to ready and calls nothing", async () => {
		const s = await toPolishing("off");
		await s.stopping;
		expect(s.pol.calls).toHaveLength(0);
		expect(s.phases).not.toContain("polishing");
		expect(s.session.phase).toMatchObject({ kind: "ready", polish: { level: "off", ran: true } });
	});

	it("the kept transcript goes at Discard: nothing is left to re-polish", async () => {
		const s = await toPolishing("light");
		s.pol.calls[0].resolve("Tell Vexo hello.");
		await s.stopping;
		s.session.close();
		await s.session.repolish("full");
		expect(s.pol.calls).toHaveLength(1);
		expect(s.session.phase.kind).toBe("closed");
	});

	it("Cancel while polishing closes, and the late answer is ignored", async () => {
		const s = await toPolishing("light");
		s.session.close();
		s.pol.calls[0].resolve("Tell Vexo hello.");
		await s.stopping;
		expect(s.session.phase.kind).toBe("closed");
	});
});

describe("Links, applied last", () => {
	async function toReady(opts: { links?: boolean; phrases?: () => Phrase[] | Promise<Phrase[]>; polish?: PolishLevel } = {}) {
		const pol = fakePolisher();
		let reads = 0;
		const phrases = opts.phrases ?? (() => [{ target: "Vexo", aliases: ["vekso"] }]);
		const s = setup({
			polish: opts.polish ?? "light",
			polisher: pol.p,
			links: () => opts.links ?? true,
			phrases: () => (reads++, phrases()),
		});
		await s.session.record();
		s.time.advance(10_000);
		const stopping = s.session.stop();
		await flush();
		s.tx.calls[0].resolve({ text: "tell vekso hello", biased: true });
		await flush();
		return { ...s, pol, stopping, reads: () => reads };
	}

	it("with Links on, the polished words are linked, and the toggle is lit", async () => {
		const s = await toReady();
		s.pol.calls[0].resolve("Tell Vexo hello.");
		await s.stopping;
		expect(s.session.phase).toMatchObject({ kind: "ready", text: "Tell [[Vexo]] hello.", links: true, polish: { text: "Tell Vexo hello." } });
		expect(s.reads()).toBe(1);
	});

	it("with Links off, the note is never read and the sheet has no toggle", async () => {
		const s = await toReady({ links: false });
		s.pol.calls[0].resolve("Tell Vexo hello.");
		await s.stopping;
		expect(s.session.phase).toMatchObject({ kind: "ready", text: "Tell Vexo hello." });
		expect(s.session.phase).not.toHaveProperty("links");
		expect(s.reads()).toBe(0);
		s.session.setLinks(true);
		expect(s.session.phase).toMatchObject({ text: "Tell Vexo hello." });
	});

	it("the toggle redraws the same words with or without links, calling nothing", async () => {
		const s = await toReady();
		s.pol.calls[0].resolve("Tell Vexo hello.");
		await s.stopping;
		s.session.setLinks(false);
		expect(s.session.phase).toMatchObject({ kind: "ready", text: "Tell Vexo hello.", links: false });
		s.session.setLinks(true);
		expect(s.session.phase).toMatchObject({ kind: "ready", text: "Tell [[Vexo]] hello.", links: true });
		expect(s.tx.calls).toHaveLength(1);
		expect(s.pol.calls).toHaveLength(1);
		expect(s.reads()).toBe(1);
	});

	it("a re-polish is linked afresh, and the toggle keeps its place", async () => {
		const s = await toReady();
		s.pol.calls[0].resolve("Tell Vexo hello.");
		await s.stopping;
		await s.session.repolish("off");
		expect(s.session.phase).toMatchObject({ text: "tell [[Vexo|vekso]] hello", links: true, polish: { level: "off" } });
		s.session.setLinks(false);
		const again = s.session.repolish("full");
		await flush();
		s.pol.calls[1].resolve("Tell Vexo hello!");
		await again;
		expect(s.session.phase).toMatchObject({ text: "Tell Vexo hello!", links: false });
	});

	it("Polish off: the transcript as heard is linked", async () => {
		const s = await toReady({ polish: "off" });
		await s.stopping;
		expect(s.session.phase).toMatchObject({ kind: "ready", text: "tell [[Vexo|vekso]] hello", links: true });
	});

	it("a note that can't be read means no links, never a failed take", async () => {
		const s = await toReady({ phrases: () => Promise.reject(new Error("gone")) });
		s.pol.calls[0].resolve("Tell Vexo hello.");
		await s.stopping;
		expect(s.session.phase).toMatchObject({ kind: "ready", text: "Tell Vexo hello.", links: true });
	});

	it("the note is read afresh for every take", async () => {
		let note: Phrase[] = [{ target: "Vexo", aliases: [] }];
		const s = await toReady({ polish: "off", phrases: () => note });
		await s.stopping;
		expect(s.session.phase).toMatchObject({ text: "tell vekso hello" });
		note = [{ target: "Hello", aliases: [] }];
		const retaking = s.session.retake();
		await retaking;
		s.time.advance(5_000);
		const stopping = s.session.stop();
		await flush();
		s.tx.calls[1].resolve({ text: "tell vekso hello", biased: true });
		await stopping;
		expect(s.session.phase).toMatchObject({ text: "tell vekso [[Hello|hello]]" });
		expect(s.reads()).toBe(2);
	});
});
