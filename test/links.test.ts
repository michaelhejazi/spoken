import { describe, expect, it } from "vitest";
import { LINKS_NOTE_HEADER, Phrase, linkText, linksPath, parseLinksNote, readLinksNote, withNoteAliases } from "../src/links";
import type { NoteStore } from "../src/termsnote";

const p = (target: string, ...aliases: string[]): Phrase => ({ target, aliases });

describe("the link phrases note", () => {
	it("is Link phrases.md in the terms note's folder unless the setting says otherwise", () => {
		expect(linksPath("", "Dictation terms.md")).toBe("Link phrases.md");
		expect(linksPath("  ", "Lists/Spoken/Dictation terms.md")).toBe("Lists/Spoken/Link phrases.md");
		expect(linksPath("/Graph/nodes", "Lists/Dictation terms.md")).toBe("Graph/nodes.md");
	});

	it("is read with the terms note's rules: frontmatter, headings, comments, blank lines and list markers", () => {
		const note = [
			"---",
			"tags: [spoken]",
			"---",
			"%% a comment %%",
			"# People and places",
			"",
			"- Ridge loop",
			"1. Quillmate %% inline comment %%",
			"- [ ] Sales deck",
			"%% across",
			"Not a phrase",
			"lines %%",
		].join("\n");
		expect(parseLinksNote(note)).toEqual([p("Ridge loop"), p("Quillmate"), p("Sales deck")]);
	});

	it("a line is Target, or Target | alias, alias; without a pipe, commas separate targets", () => {
		expect(parseLinksNote("Ridge loop | the loop, ridge trail\nQuillmate, Sales deck\nOnboarding calls|onboarding call")).toEqual([
			p("Ridge loop", "the loop", "ridge trail"),
			p("Quillmate"),
			p("Sales deck"),
			p("Onboarding calls", "onboarding call"),
		]);
	});

	it("a target named twice is one target with both lines' aliases; a name no link can carry is skipped", () => {
		expect(parseLinksNote("Ridge loop | the loop\nridge loop | ridge trail\nC# notes\n | orphan alias")).toEqual([p("Ridge loop", "the loop", "ridge trail")]);
	});

	it("the note Spoken creates is two comment lines, so it holds no phrases", () => {
		expect(LINKS_NOTE_HEADER.trimEnd().split("\n")).toHaveLength(2);
		expect(parseLinksNote(LINKS_NOTE_HEADER)).toEqual([]);
	});

	it("a missing or unreadable note means no phrases", async () => {
		const store = (files: Record<string, string>, broken = false): NoteStore => ({
			exists: async (path) => path in files,
			read: async (path) => (broken ? Promise.reject(new Error("locked")) : files[path]),
			create: async () => {},
		});
		expect(await readLinksNote(store({}), "Link phrases.md")).toEqual([]);
		expect(await readLinksNote(store({ "Link phrases.md": "Quillmate" }, true), "Link phrases.md")).toEqual([]);
		expect(await readLinksNote(store({ "Link phrases.md": "Quillmate" }), "Link phrases.md")).toEqual([p("Quillmate")]);
	});

	it("a target's aliases include its note's own aliases frontmatter", () => {
		const aliases: Record<string, string[]> = { Quillmate: ["QM", "the app"] };
		expect(withNoteAliases([p("Quillmate", "quill"), p("Ridge loop")], (t) => aliases[t] ?? [])).toEqual([
			p("Quillmate", "quill", "QM", "the app"),
			p("Ridge loop"),
		]);
	});
});

describe("linkText: deterministic and conservative", () => {
	it("an exact match stays bare: [[Target]]", () => {
		expect(linkText("Walked the Ridge loop today.", [p("Ridge loop")])).toBe("Walked the [[Ridge loop]] today.");
	});

	it("matching ignores case, but the words keep theirs: [[Target|words as said]] when only case differs", () => {
		expect(linkText("Walked the RIDGE LOOP today.", [p("Ridge loop")])).toBe("Walked the [[Ridge loop|RIDGE LOOP]] today.");
		expect(linkText("Booked the onboarding calls.", [p("Onboarding calls")])).toBe("Booked the [[Onboarding calls|onboarding calls]].");
	});

	it("an alias said: [[Target|words as said]]", () => {
		expect(linkText("Walked The Loop today.", [p("Ridge loop", "the loop")])).toBe("Walked [[Ridge loop|The Loop]] today.");
	});

	it("whole words only", () => {
		expect(linkText("Ridged, unridge, ridgeline, ridge_x, ridge2.", [p("Ridge")])).toBe("Ridged, unridge, ridgeline, ridge_x, ridge2.");
		expect(linkText("A ridge, then (ridge).", [p("Ridge")])).toBe("A [[Ridge|ridge]], then (ridge).");
	});

	it("a possessive 's or plural s is tolerated and kept outside the brackets", () => {
		expect(linkText("Quillmate's pricing.", [p("Quillmate")])).toBe("[[Quillmate]]'s pricing.");
		expect(linkText("Quillmate’s pricing.", [p("Quillmate")])).toBe("[[Quillmate]]’s pricing.");
		expect(linkText("Two ridges.", [p("Ridge")])).toBe("Two [[Ridge|ridge]]s.");
		expect(linkText("The loop's end.", [p("Ridge loop", "the loop")])).toBe("[[Ridge loop|The loop]]'s end.");
	});

	it("longest match first: a longer target wins over a shorter one inside it", () => {
		expect(linkText("The ridge loop.", [p("Ridge"), p("Ridge loop")])).toBe("The [[Ridge loop|ridge loop]].");
	});

	it("one target's alias never links inside a longer target that matched, even where that one isn't linked again", () => {
		const phrases = [p("Ridgeway Dental"), p("Ridgeway", "the ridge")];
		expect(linkText("Ridgeway Dental called. Ridgeway Dental again. Then Ridgeway.", phrases)).toBe(
			"[[Ridgeway Dental]] called. Ridgeway Dental again. Then [[Ridgeway]].",
		);
	});

	it("only the first mention of each target per take, whichever form comes first", () => {
		expect(linkText("The loop, then the ridge loop, then the loop.", [p("Ridge loop", "the loop")])).toBe(
			"[[Ridge loop|The loop]], then the ridge loop, then the loop.",
		);
	});

	it("nothing inside existing [[links]] or embeds is touched", () => {
		expect(linkText("See [[Ridge loop notes]] and ![[ridge loop.png]], then ridge loop.", [p("Ridge loop")])).toBe(
			"See [[Ridge loop notes]] and ![[ridge loop.png]], then [[Ridge loop|ridge loop]].",
		);
	});

	it("nothing inside backticks, inline or fenced", () => {
		expect(linkText("Run `quillmate sync` then ```\nquillmate\n``` then Quillmate.", [p("Quillmate")])).toBe(
			"Run `quillmate sync` then ```\nquillmate\n``` then [[Quillmate]].",
		);
	});

	it("nothing inside a URL or a Markdown link", () => {
		expect(linkText("Go to https://quillmate.example/quillmate or www.quillmate.example, [quillmate](x) then Quillmate.", [p("Quillmate")])).toBe(
			"Go to https://quillmate.example/quillmate or www.quillmate.example, [quillmate](x) then [[Quillmate]].",
		);
	});

	it("a common word listed on purpose as an alias links once, and only as a whole word", () => {
		// "deck" is an alias of Sales deck: Decked is another word, and every later deck, decks or sales deck stays as said.
		const text = "Decked out the deck today; the deck needs a page. Two decks, and the sales deck is done.";
		expect(linkText(text, [p("Sales deck", "deck")])).toBe(
			"Decked out the [[Sales deck|deck]] today; the deck needs a page. Two decks, and the sales deck is done.",
		);
	});

	it("words across a line break are not one phrase, and spacing within one is kept", () => {
		expect(linkText("ridge\nloop", [p("Ridge loop")])).toBe("ridge\nloop");
		expect(linkText("ridge  loop", [p("Ridge loop")])).toBe("[[Ridge loop|ridge  loop]]");
	});

	it("two targets claiming one alias: the first listed keeps it", () => {
		expect(linkText("Call the clinic.", [p("Ridgeway Dental", "the clinic"), p("Bay Clinic", "the clinic")])).toBe(
			"Call [[Ridgeway Dental|the clinic]].",
		);
	});

	it("no phrases, no change; letters beyond ASCII are letters", () => {
		expect(linkText("Ridge loop.", [])).toBe("Ridge loop.");
		expect(linkText("Café Noir and Cafés and écafé.", [p("Café")])).toBe("[[Café]] Noir and Cafés and écafé.");
	});
});
