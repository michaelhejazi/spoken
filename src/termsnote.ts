// The names-and-terms list lives in a note in the vault, so it syncs with the
// vault and can be edited anywhere. This file reads that note and moves a
// 0.1.x in-settings list into it once. It imports nothing from Obsidian; the
// plugin hands it a NoteStore over the vault.

export const DEFAULT_TERMS_PATH = "Dictation terms.md";

/** The two lines at the top of a note the plugin creates. Obsidian comments, so the parser skips them. */
export const NOTE_HEADER =
	"%% Names and terms Spoken should spell right: one per line, or several on a line separated by commas. %%\n" +
	"%% Headings, list markers, blank lines and these comment lines are ignored. The open note's title and headings are added on their own. %%\n";

export interface NoteStore {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	create(path: string, text: string): Promise<void>;
}

/** The setting as a vault path: trimmed, no leading slash, ending in .md. */
export function termsPath(setting: string): string {
	return notePath(setting) ?? DEFAULT_TERMS_PATH;
}

/** A path setting as a vault path, or null when it is blank. */
export function notePath(setting: string): string | null {
	const p = setting.trim().replace(/\\/g, "/").replace(/^\/+/, "");
	if (!p) return null;
	return /\.md$/i.test(p) ? p : `${p}.md`;
}

/**
 * The terms in a note: one per line; YAML frontmatter, headings, blank lines
 * and %% comments ignored; a leading list marker (-, *, +, 1., 1), a task box)
 * stripped; a line with commas is several terms.
 */
export function parseTermsNote(text: string): string[] {
	return noteLines(text).flatMap(splitCommas);
}

/** A line's comma-separated parts, trimmed, the empty ones dropped. */
export function splitCommas(line: string): string[] {
	return line
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
}

/** The lines of a list note that hold something: everything parseTermsNote ignores taken out, list markers stripped. */
export function noteLines(text: string): string[] {
	const lines = text.split(/\r?\n/);
	let i = 0;
	if (lines[0]?.trim() === "---") {
		const end = lines.findIndex((l, n) => n > 0 && (l.trim() === "---" || l.trim() === "..."));
		if (end > 0) i = end + 1;
	}
	const out: string[] = [];
	let inComment = false;
	for (; i < lines.length; i++) {
		let line = lines[i];
		// Obsidian comments, on one line or across several.
		line = line.replace(/%%.*?%%/g, "");
		if (inComment) {
			const close = line.indexOf("%%");
			if (close < 0) continue;
			line = line.slice(close + 2);
			inComment = false;
		}
		const open = line.indexOf("%%");
		if (open >= 0) {
			line = line.slice(0, open);
			inComment = true;
		}
		line = line.trim();
		if (!line || /^#{1,6}(\s|$)/.test(line)) continue;
		line = line.replace(/^(?:[-*+]|\d+[.)])\s+/, "").replace(/^\[.\]\s+/, "").trim();
		if (line) out.push(line);
	}
	return out;
}

/** The note's terms, or none when it doesn't exist or can't be read. */
export async function readTermsNote(store: NoteStore, path: string): Promise<string[]> {
	try {
		return (await store.exists(path)) ? parseTermsNote(await store.read(path)) : [];
	} catch {
		return [];
	}
}

/** Creates the note with its two explanatory lines, if it isn't there. */
export async function ensureTermsNote(store: NoteStore, path: string, header = NOTE_HEADER): Promise<void> {
	if (!(await store.exists(path))) await store.create(path, header);
}

export type TermsMove = "nothing to move" | "moved into the note" | "kept: the note already exists";

/**
 * 0.1.x kept the list in settings as `terms`. If the note doesn't exist, the
 * list is written into it once and dropped from settings. If the note exists,
 * neither is touched: the old list stays in settings, unread, until the user
 * has seen both and chooses in the settings tab.
 */
export async function moveOldTerms(settings: { terms?: string }, store: NoteStore, path: string): Promise<TermsMove> {
	if (settings.terms === undefined) return "nothing to move";
	const lines = settings.terms.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	if (!lines.length) {
		delete settings.terms;
		return "nothing to move";
	}
	if (await store.exists(path)) return "kept: the note already exists";
	await store.create(path, NOTE_HEADER + "\n" + lines.join("\n") + "\n");
	delete settings.terms;
	return "moved into the note";
}
