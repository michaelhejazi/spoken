import { describe, expect, it } from "vitest";
import { MAX_ENCODED_BYTES, MAX_TERMS, buildTerms, encodeTerms } from "../src/vocabulary";

describe("the vocabulary sent with a take", () => {
	it("puts the terms note's list first, then the note title, then its headings", () => {
		expect(buildTerms(["Quillmate", "Vecso"], "Trail notes", ["Ridge loop", "Next"])).toEqual([
			"Quillmate",
			"Vecso",
			"Trail notes",
			"Ridge loop",
			"Next",
		]);
	});

	it("keeps each term once regardless of case, the first spelling winning", () => {
		expect(buildTerms(["Vecso", "vecso"], "VECSO", ["Trail", "trail"])).toEqual(["Vecso", "Trail"]);
	});

	it("drops blank lines, trims, and drops terms over 80 characters", () => {
		const long = "x".repeat(81);
		const edge = "y".repeat(80);
		expect(buildTerms(["  Quillmate ", "", "\r", long, edge], null, [])).toEqual(["Quillmate", edge]);
	});

	it("caps the list at 100 terms, cut from the end", () => {
		const user = Array.from({ length: 90 }, (_, i) => `user${i}`);
		const headings = Array.from({ length: 30 }, (_, i) => `heading${i}`);
		const out = buildTerms(user, "Title", headings);
		expect(out.length).toBe(MAX_TERMS);
		expect(out.slice(0, 90)).toEqual(user);
		expect(out[90]).toBe("Title");
		expect(out.at(-1)).toBe("heading8");
	});

	it("caps the encoded list at 6,000 bytes, cut from the end", () => {
		// Non-ASCII terms grow ninefold when URI-encoded, so the byte cap bites well before 100 terms.
		const user = Array.from({ length: 60 }, (_, i) => `Gödel–Escher–Bach ${i} ☕☕☕☕☕☕☕☕`);
		const out = buildTerms(user, "Title", []);
		expect(encodeTerms(out).length).toBeLessThanOrEqual(MAX_ENCODED_BYTES);
		expect(out.length).toBeLessThan(60);
		expect(out).toEqual(user.slice(0, out.length));
		expect(encodeTerms(user.slice(0, out.length + 1)).length).toBeGreaterThan(MAX_ENCODED_BYTES);
	});

	it("is empty when there is nothing to send", () => {
		expect(buildTerms([], null, [])).toEqual([]);
	});
});
