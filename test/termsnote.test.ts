import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_TERMS_PATH,
	NOTE_HEADER,
	NoteStore,
	ensureTermsNote,
	moveOldTerms,
	parseTermsNote,
	readTermsNote,
	termsPath,
} from "../src/termsnote";
import { buildTerms } from "../src/vocabulary";

const fixture = readFileSync(new URL("./fixtures/Dictation terms.md", import.meta.url), "utf8");

/** An in-memory vault. */
function memoryStore(files: Record<string, string> = {}): NoteStore & { files: Record<string, string> } {
	return {
		files,
		exists: async (p) => p in files,
		read: async (p) => files[p],
		create: async (p, text) => {
			if (p in files) throw new Error("File already exists.");
			files[p] = text;
		},
	};
}

describe("the terms note", () => {
	it("parses the fixture: frontmatter, headings, comments and blank lines ignored, list markers stripped, commas split", () => {
		expect(parseTermsNote(fixture)).toEqual([
			"Quillmate",
			"Ilka Brannmoor",
			"Anaïs",
			"Tochal",
			"Darband",
			"Darakeh",
			"Shemiran",
			"Readwise",
			"Obsidian",
			"Vecso",
			"WebM",
			"Opus",
			"Gödel–Escher–Bach",
			"#hashtag stays",
		]);
	});

	it("feeds the list a take sends: the note first, then the open note's title and headings, deduped", () => {
		expect(buildTerms(parseTermsNote(fixture), "Tochal walk", ["Darband", "Lunch"])).toEqual([
			...parseTermsNote(fixture),
			"Tochal walk",
			"Lunch",
		]);
	});

	it("ignores the two explanatory lines a created note starts with", () => {
		expect(parseTermsNote(NOTE_HEADER)).toEqual([]);
		expect(parseTermsNote(NOTE_HEADER + "\nQuillmate\n")).toEqual(["Quillmate"]);
	});

	it("reads CRLF notes, and a note with no frontmatter whose first line is a term", () => {
		expect(parseTermsNote("Quillmate\r\n- Vecso\r\n")).toEqual(["Quillmate", "Vecso"]);
	});

	it("keeps a line of dashes after the top when there is no closing fence", () => {
		expect(parseTermsNote("---\nQuillmate")).toEqual(["---", "Quillmate"]);
	});

	it("is read fresh each time, and is empty when the note is missing", async () => {
		const store = memoryStore();
		expect(await readTermsNote(store, DEFAULT_TERMS_PATH)).toEqual([]);
		store.files[DEFAULT_TERMS_PATH] = "Quillmate";
		expect(await readTermsNote(store, DEFAULT_TERMS_PATH)).toEqual(["Quillmate"]);
		store.files[DEFAULT_TERMS_PATH] = "Quillmate\nVecso";
		expect(await readTermsNote(store, DEFAULT_TERMS_PATH)).toEqual(["Quillmate", "Vecso"]);
	});

	it("turns the setting into a vault path ending in .md", () => {
		expect(termsPath("")).toBe("Dictation terms.md");
		expect(termsPath(" /Meta/Terms ")).toBe("Meta/Terms.md");
		expect(termsPath("Meta\\Terms.MD")).toBe("Meta/Terms.MD");
	});

	it("Open creates the note with its two explanatory lines only when it is missing", async () => {
		const store = memoryStore();
		await ensureTermsNote(store, "Terms.md");
		expect(store.files["Terms.md"]).toBe(NOTE_HEADER);
		store.files["Terms.md"] = "Mine";
		await ensureTermsNote(store, "Terms.md");
		expect(store.files["Terms.md"]).toBe("Mine");
	});
});

describe("moving 0.1.x's in-settings terms", () => {
	it("no note yet: writes the old list into a new note once and drops it from settings", async () => {
		const store = memoryStore();
		const settings: { terms?: string } = { terms: "Quillmate\n\n  Vecso \nTochal\n" };
		expect(await moveOldTerms(settings, store, DEFAULT_TERMS_PATH)).toBe("moved into the note");
		expect(settings.terms).toBeUndefined();
		expect(store.files[DEFAULT_TERMS_PATH]).toBe(NOTE_HEADER + "\nQuillmate\nVecso\nTochal\n");
		expect(parseTermsNote(store.files[DEFAULT_TERMS_PATH])).toEqual(["Quillmate", "Vecso", "Tochal"]);

		// Once: a second load has nothing to move and leaves the note alone.
		store.files[DEFAULT_TERMS_PATH] += "Darband\n";
		expect(await moveOldTerms(settings, store, DEFAULT_TERMS_PATH)).toBe("nothing to move");
		expect(parseTermsNote(store.files[DEFAULT_TERMS_PATH])).toEqual(["Quillmate", "Vecso", "Tochal", "Darband"]);
	});

	it("the note exists: touches neither, and the old list stays in settings", async () => {
		const store = memoryStore({ [DEFAULT_TERMS_PATH]: "Already here\n" });
		const settings: { terms?: string } = { terms: "Quillmate\nVecso" };
		expect(await moveOldTerms(settings, store, DEFAULT_TERMS_PATH)).toBe("kept: the note already exists");
		expect(settings.terms).toBe("Quillmate\nVecso");
		expect(store.files[DEFAULT_TERMS_PATH]).toBe("Already here\n");
	});

	it("an empty old list is dropped without creating a note", async () => {
		const store = memoryStore();
		const settings: { terms?: string } = { terms: " \n" };
		expect(await moveOldTerms(settings, store, DEFAULT_TERMS_PATH)).toBe("nothing to move");
		expect(settings.terms).toBeUndefined();
		expect(store.files).toEqual({});
	});
});
