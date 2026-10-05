import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	BAD_KEY,
	GeminiTranscriber,
	MODEL_FAILED,
	NOT_FINISHED,
	NO_KEY,
	NO_WORDS,
	OVERLOADED,
	RATE_LIMITED,
	TOO_LARGE,
	TOO_SLOW,
	UNREACHABLE,
	UNREADABLE,
	geminiMime,
	unknownModel,
} from "../src/gemini";
import { TranscribeError } from "../src/transcriber";
import { FakeGemini, startFakeGemini } from "./fake-gemini.mjs";
import { fetchClient } from "./fetch-client";

let fake: FakeGemini;
beforeAll(async () => {
	fake = await startFakeGemini();
});
afterAll(() => fake.close());
beforeEach(() => {
	fake.rejectVocabulary = false;
});

const audio = new Uint8Array([1, 2, 3, 4, 5, 250, 251, 252]).buffer;
const gemini = (key = fake.key, model = "gemini-3.5-transcribe", waitMs?: number, url = fake.url) =>
	new GeminiTranscriber(() => ({ key, model }), fetchClient, waitMs, url);

async function failure(p: Promise<unknown>): Promise<TranscribeError> {
	try {
		await p;
	} catch (e) {
		expect(e).toBeInstanceOf(TranscribeError);
		return e as TranscribeError;
	}
	throw new Error("expected a failure");
}

const googleError = (code: number, status: string, message: string) => ({ error: { code, status, message } });

describe("the request to Gemini's interactions endpoint", () => {
	it("sends the key, the model, the audio in base64 and the terms as custom_vocabulary in smart mode", async () => {
		const terms = ["Quillmate", "Vecso", "café & co"];
		const res = await gemini().transcribe(audio, "audio/webm;codecs=opus", terms);
		expect(res).toEqual({ text: "Fake transcript of 8 bytes of audio/webm.", biased: true });

		const req = fake.requests.at(-1)!;
		expect(req.method).toBe("POST");
		expect(req.url).toBe("/v1beta/interactions");
		expect(req.headers["x-goog-api-key"]).toBe(fake.key);
		expect(req.headers["content-type"]).toBe("application/json");
		expect(req.headers.authorization).toBeUndefined();
		expect(req.json).toEqual({
			model: "gemini-3.5-transcribe",
			input: [{ type: "audio", mime_type: "audio/webm", data: "AQIDBAX6+/w=" }],
			generation_config: {
				transcription_config: { mode: "smart", custom_vocabulary: ["Quillmate", "Vecso", "café & co"] },
			},
		});
	});

	it("leaves custom_vocabulary out when there are no terms, and reports biased false", async () => {
		const res = await gemini().transcribe(audio, "audio/webm;codecs=opus", []);
		expect(res.biased).toBe(false);
		expect(fake.requests.at(-1)!.json.generation_config).toEqual({ transcription_config: { mode: "smart" } });
	});

	it("sends iOS's audio/mp4 as audio/m4a, the base64 unchanged", async () => {
		const res = await gemini().transcribe(audio, "audio/mp4", []);
		expect(res.text).toBe("Fake transcript of 8 bytes of audio/m4a.");
		expect(fake.requests.at(-1)!.json.input[0]).toEqual({ type: "audio", mime_type: "audio/m4a", data: "AQIDBAX6+/w=" });
	});

	it("maps each platform MIME type to one on Gemini's list", () => {
		expect(geminiMime("audio/webm;codecs=opus")).toBe("audio/webm");
		expect(geminiMime("audio/webm")).toBe("audio/webm");
		expect(geminiMime("audio/mp4")).toBe("audio/m4a");
		expect(geminiMime("audio/mp4;codecs=mp4a.40.2")).toBe("audio/m4a");
		expect(geminiMime("audio/ogg;codecs=opus")).toBe("audio/ogg");
	});

	it("encodes a take larger than one base64 slice exactly", async () => {
		const big = new Uint8Array(100_000).map((_, i) => i % 256);
		const res = await gemini().transcribe(big.buffer, "audio/webm", []);
		expect(res.text).toBe("Fake transcript of 100000 bytes of audio/webm.");
		expect(fake.requests.at(-1)!.json.input[0].data).toBe(Buffer.from(big).toString("base64"));
	});

	it("uses the model named in settings, and the default when it is blank", async () => {
		await gemini(fake.key, "gemini-9-transcribe").transcribe(audio, "audio/webm", []);
		expect(fake.requests.at(-1)!.json.model).toBe("gemini-9-transcribe");
		await gemini(fake.key, "  ").transcribe(audio, "audio/webm", []);
		expect(fake.requests.at(-1)!.json.model).toBe("gemini-3.5-transcribe");
	});

	it("does not call Google when there is no key", async () => {
		const before = fake.requests.length;
		const e = await failure(gemini(" ").transcribe(audio, "audio/webm", []));
		expect(e.message).toBe(NO_KEY);
		expect(fake.requests.length).toBe(before);
	});
});

describe("the vocabulary fallback", () => {
	it("when Gemini refuses the vocabulary, resends once without the terms and reports biased false", async () => {
		fake.rejectVocabulary = true;
		const before = fake.requests.length;
		const res = await gemini().transcribe(audio, "audio/webm", ["Quillmate"]);
		expect(res).toEqual({ text: "Fake transcript of 8 bytes of audio/webm.", biased: false });
		const sent = fake.requests.slice(before);
		expect(sent).toHaveLength(2);
		expect(sent[0].json.generation_config.transcription_config).toEqual({ mode: "smart", custom_vocabulary: ["Quillmate"] });
		expect(sent[1].json.generation_config.transcription_config).toEqual({ mode: "smart" });
		expect(sent[1].json.input).toEqual(sent[0].json.input);
	});

	it("resends only once: a second failure is shown", async () => {
		const before = fake.requests.length;
		fake.respondNext(400, googleError(400, "INVALID_ARGUMENT", "Bad custom_vocabulary."));
		fake.respondNext(429, googleError(429, "RESOURCE_EXHAUSTED", "Quota exceeded."));
		const e = await failure(gemini().transcribe(audio, "audio/webm", ["Quillmate"]));
		expect(e.message).toBe(RATE_LIMITED);
		expect(fake.requests.length - before).toBe(2);
	});

	it("does not resend a 400 that is about something else", async () => {
		const before = fake.requests.length;
		fake.respondNext(400, googleError(400, "INVALID_ARGUMENT", "Unsupported MIME type: audio/x-foo"));
		const e = await failure(gemini().transcribe(audio, "audio/webm", ["Quillmate"]));
		expect(e.message).toBe("Gemini couldn't transcribe the recording: Unsupported MIME type: audio/x-foo");
		expect(fake.requests.length - before).toBe(1);
	});
});

describe("each way Gemini says no, as a sentence", () => {
	it("a wrong key: Google's own 400 'API key not valid'", async () => {
		const e = await failure(gemini("wrong-key").transcribe(audio, "audio/webm", ["Quillmate"]));
		expect(e.message).toBe(BAD_KEY);
		expect(e.status).toBe(400);
	});

	for (const status of [401, 403]) {
		it(`a refused key: ${status}`, async () => {
			fake.respondNext(status, googleError(status, "PERMISSION_DENIED", "Permission denied."));
			expect((await failure(gemini().transcribe(audio, "audio/webm", []))).message).toBe(BAD_KEY);
		});
	}

	it("rate-limiting: 429 RESOURCE_EXHAUSTED", async () => {
		fake.respondNext(429, googleError(429, "RESOURCE_EXHAUSTED", "Resource has been exhausted (e.g. check quota)."));
		const e = await failure(gemini().transcribe(audio, "audio/webm", []));
		expect(e.message).toBe(RATE_LIMITED);
		expect(e.status).toBe(429);
	});

	it("a take too large: 413, or a 400 saying the payload is too large", async () => {
		fake.respondNext(413, "<html>Request Entity Too Large</html>");
		expect((await failure(gemini().transcribe(audio, "audio/webm", []))).message).toBe(TOO_LARGE);
		fake.respondNext(400, googleError(400, "INVALID_ARGUMENT", "Request payload size exceeds the limit: 20971520 bytes."));
		expect((await failure(gemini().transcribe(audio, "audio/webm", []))).message).toBe(TOO_LARGE);
	});

	it("an unknown model: 404 names the model", async () => {
		fake.respondNext(404, googleError(404, "NOT_FOUND", "models/gemini-typo is not found."));
		const e = await failure(gemini(fake.key, "gemini-typo").transcribe(audio, "audio/webm", []));
		expect(e.message).toBe(unknownModel("gemini-typo"));
	});

	it("Google failing: 500, 503, 504", async () => {
		fake.respondNext(500, googleError(500, "INTERNAL", "Internal error."));
		expect((await failure(gemini().transcribe(audio, "audio/webm", []))).message).toBe(MODEL_FAILED);
		fake.respondNext(503, googleError(503, "UNAVAILABLE", "The model is overloaded."));
		expect((await failure(gemini().transcribe(audio, "audio/webm", []))).message).toBe(OVERLOADED);
		fake.respondNext(504, "<html>Gateway timeout</html>");
		expect((await failure(gemini().transcribe(audio, "audio/webm", []))).message).toBe(TOO_SLOW);
	});

	for (const status of ["failed", "incomplete", "in_progress", "cancelled"]) {
		it(`a model that did not finish: status ${status}`, async () => {
			fake.respondNext(200, {
				status,
				steps: [{ type: "model_output", content: [{ type: "text", text: "half a sent" }] }],
			});
			const e = await failure(gemini().transcribe(audio, "audio/webm", []));
			expect(e.message).toBe(NOT_FINISHED);
		});
	}

	it("no words heard: completed with no text", async () => {
		fake.respondNext(200, { status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "  " }] }] });
		expect((await failure(gemini().transcribe(audio, "audio/webm", []))).message).toBe(NO_WORDS);
		fake.respondNext(200, { status: "completed", steps: [] });
		expect((await failure(gemini().transcribe(audio, "audio/webm", []))).message).toBe(NO_WORDS);
	});

	it("reads only model_output text, in order", async () => {
		fake.respondNext(200, {
			status: "completed",
			steps: [
				{ type: "thought", content: [{ type: "text", text: "thinking" }] },
				{ type: "model_output", content: [{ type: "text", text: "Walked the " }, { type: "audio" }, { type: "text", text: "ridge." }] },
			],
		});
		expect((await gemini().transcribe(audio, "audio/webm", [])).text).toBe("Walked the ridge.");
	});

	it("an answer that isn't JSON", async () => {
		fake.respondNext(200, "<html>captive portal</html>");
		expect((await failure(gemini().transcribe(audio, "audio/webm", []))).message).toBe(UNREADABLE);
	});

	it("Google unreachable: says so and keeps the take", async () => {
		const e = await failure(gemini(fake.key, "gemini-3.5-transcribe", undefined, "http://127.0.0.1:9/v1beta/interactions").transcribe(audio, "audio/webm", []));
		expect(e.message).toBe(UNREACHABLE);
		expect(e.status).toBe(0);
	});

	it("slower than the wait: gives up with a sentence", async () => {
		fake.respondNext(200, { status: "completed", steps: [] }, 500);
		const e = await failure(gemini(fake.key, "gemini-3.5-transcribe", 50).transcribe(audio, "audio/webm", []));
		expect(e.message).toBe(TOO_SLOW);
		expect(e.status).toBe(0);
	});
});
