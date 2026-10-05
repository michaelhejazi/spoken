import { describe, expect, it } from "vitest";
import type { Editor, EditorTransaction } from "obsidian";
import { insertAtCursor, withLeadingSpace } from "../src/insert";

describe("the spacing rule", () => {
	it("adds nothing at the start of a line", () => {
		expect(withLeadingSpace("", "Walked the ridge.")).toBe("Walked the ridge.");
	});
	it("adds one space after a word", () => {
		expect(withLeadingSpace("Trail notes:", "Walked the ridge.")).toBe(" Walked the ridge.");
	});
	it("adds nothing after a space", () => {
		expect(withLeadingSpace("Trail notes: ", "Walked the ridge.")).toBe("Walked the ridge.");
	});
	it("adds nothing after a tab", () => {
		expect(withLeadingSpace("-\t", "Walked.")).toBe("Walked.");
	});
});

/** An editor over an array of lines, recording each transaction as one undo step. */
function fakeEditor(lines: string[], cursor: { line: number; ch: number }) {
	const transactions: EditorTransaction[] = [];
	const editor = {
		getCursor: () => cursor,
		getLine: (n: number) => lines[n],
		focus: () => undefined,
		transaction: (tx: EditorTransaction) => {
			transactions.push(tx);
			for (const c of tx.changes ?? []) {
				const line = lines[c.from.line];
				const joined = line.slice(0, c.from.ch) + c.text + line.slice(c.from.ch);
				lines.splice(c.from.line, 1, ...joined.split("\n"));
			}
		},
	};
	return { editor: editor as unknown as Editor, lines, transactions };
}

describe("insert at the cursor", () => {
	it("lands after a word with one space, as one transaction, cursor after the words", () => {
		const f = fakeEditor(["Walked the ridge loop", ""], { line: 0, ch: 21 });
		insertAtCursor(f.editor, "before the call.");
		expect(f.lines[0]).toBe("Walked the ridge loop before the call.");
		expect(f.transactions).toHaveLength(1);
		expect(f.transactions[0].selection).toEqual({ from: { line: 0, ch: 38 } });
	});

	it("lands at the start of a line with no space", () => {
		const f = fakeEditor(["Heading", ""], { line: 1, ch: 0 });
		insertAtCursor(f.editor, "New thought.");
		expect(f.lines[1]).toBe("New thought.");
	});

	it("lands after a space with no extra space, mid-line", () => {
		const f = fakeEditor(["Ask  today."], { line: 0, ch: 4 });
		insertAtCursor(f.editor, "Quillmate");
		expect(f.lines[0]).toBe("Ask Quillmate today.");
	});

	it("puts the cursor at the end of multi-line words", () => {
		const f = fakeEditor([""], { line: 0, ch: 0 });
		insertAtCursor(f.editor, "One.\n\nTwo more.");
		expect(f.transactions[0].selection).toEqual({ from: { line: 2, ch: 9 } });
	});
});
