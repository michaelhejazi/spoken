// Links: the names in a take that are nodes in the vault become wiki-links.
// The list is a note of its own (the terms note holds spellings that should
// never be linked), read fresh for every take. Code puts the links in, over
// the final text, so no link is ever invented and Polish can be off. Imports
// nothing from Obsidian; the plugin adds each note's own aliases.

import { NoteStore, noteLines, notePath, splitCommas } from "./termsnote";

/** The note's name when the setting is blank; it sits in the terms note's folder. */
export const DEFAULT_LINKS_NAME = "Link phrases.md";

/** The two lines at the top of a note the plugin creates. Obsidian comments, so the parser skips them. */
export const LINKS_NOTE_HEADER =
	"%% Names Spoken turns into links in each take, one note name per line or several separated by commas. After a pipe come other ways you say it: Ridge loop | the loop, ridge trail %%\n" +
	"%% The first mention of each in a take becomes a link, whether the note exists yet or not, and a note's own aliases count too. Headings, list markers, blank lines and these comment lines are ignored. %%\n";

export interface Phrase {
	/** The note the link points at, as written in the note. */
	target: string;
	/** Other ways of saying it; the link shows the words as said. */
	aliases: string[];
}

/** The setting as a vault path: blank means Link phrases.md in the terms note's folder. */
export function linksPath(setting: string, terms: string): string {
	const p = notePath(setting);
	if (p) return p;
	const slash = terms.lastIndexOf("/");
	return (slash >= 0 ? terms.slice(0, slash + 1) : "") + DEFAULT_LINKS_NAME;
}

/** Characters a note name can't carry into a link. */
const UNLINKABLE = /[[\]|#^]/;

/**
 * The phrases in a note, read with the terms note's rules (frontmatter,
 * headings, %% comments and blank lines ignored, list markers stripped), and
 * then: a line is `Target`, or `Target | alias, alias`. Without a pipe, commas
 * separate several targets, as in the terms note. A target named twice is one
 * target with both lines' aliases.
 */
export function parseLinksNote(text: string): Phrase[] {
	const out: Phrase[] = [];
	const add = (target: string, aliases: string[]) => {
		if (!target || UNLINKABLE.test(target)) return;
		const known = out.find((p) => same(p.target, target));
		if (known) known.aliases.push(...aliases);
		else out.push({ target, aliases });
	};
	for (const line of noteLines(text)) {
		const pipe = line.indexOf("|");
		if (pipe < 0) for (const target of splitCommas(line)) add(target, []);
		else add(line.slice(0, pipe).trim(), splitCommas(line.slice(pipe + 1)));
	}
	return out;
}

/** The note's phrases, or none when it doesn't exist or can't be read. */
export async function readLinksNote(store: NoteStore, path: string): Promise<Phrase[]> {
	try {
		return (await store.exists(path)) ? parseLinksNote(await store.read(path)) : [];
	} catch {
		return [];
	}
}

/** Each target's aliases with those of the vault's note of that name added (its `aliases` frontmatter), if there is one. */
export function withNoteAliases(phrases: Phrase[], noteAliases: (target: string) => string[]): Phrase[] {
	return phrases.map((p) => ({ target: p.target, aliases: [...p.aliases, ...noteAliases(p.target)] }));
}

// The text that must not change: existing wiki-links and embeds, code in
// backticks (inline or fenced), Markdown links, and URLs.
const PROTECTED = /!?\[\[[\s\S]*?\]\]|(`+)[\s\S]*?\1|\[[^\]\n]*\]\([^)\n]*\)|\b[a-z][a-z0-9+.-]*:\/\/\S+|\bwww\.\S+/gi;
const WORD = /[\p{L}\p{N}_]/u;
/** Tolerated after a phrase and kept outside the brackets: a possessive, or a plural s. */
const SUFFIX = /^(?:['’]s|s)/i;

interface Match {
	start: number;
	/** Where the phrase ends; the suffix, if any, runs to `stop`. */
	end: number;
	stop: number;
	target: string;
}

/**
 * The text with the first mention of each target linked: `[[Target]]` when
 * the words said are the target's name in any case, `[[Target|words said]]`
 * otherwise. Matching ignores case and holds to whole words; a trailing 's
 * or s is allowed and left outside the link. Longer phrases are matched
 * first, and nothing shorter links inside a longer one, linked or not.
 * Existing links, code and URLs are left alone.
 */
export function linkText(text: string, phrases: Phrase[]): string {
	if (!phrases.length || !text) return text;
	const blocked: Array<[number, number]> = [];
	for (const m of text.matchAll(PROTECTED)) blocked.push([m.index, m.index + m[0].length]);

	// Every way of saying each target, once: the first target to claim a form keeps it.
	const forms = new Map<string, string>();
	for (const p of phrases) {
		for (const form of [p.target, ...p.aliases]) {
			const f = form.trim();
			if (f && !/[[\]|\n]/.test(f) && !forms.has(f.toLocaleLowerCase())) forms.set(f.toLocaleLowerCase(), p.target);
		}
	}

	const found: Match[] = [];
	for (const [form, target] of forms) {
		const pattern = new RegExp(escape(form).replace(/\s+/g, "[^\\S\\n]+"), "giu");
		for (const m of text.matchAll(pattern)) {
			const start = m.index, end = start + m[0].length;
			if (WORD.test(form[0]) && start > 0 && WORD.test(text[start - 1])) continue;
			let stop = end;
			if (WORD.test(form[form.length - 1])) {
				const suffix = SUFFIX.exec(text.slice(end));
				if (suffix && !WORD.test(text[end + suffix[0].length] ?? "")) stop = end + suffix[0].length;
				else if (WORD.test(text[end] ?? "")) continue;
			}
			found.push({ start, end, stop, target });
		}
	}

	// Longest first, then earliest; a match overlapping one already taken, or protected text, is dropped.
	found.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
	const taken: Match[] = [];
	for (const m of found) {
		const overlaps = (s: number, e: number) => m.start < e && s < m.stop;
		if (blocked.some(([s, e]) => overlaps(s, e)) || taken.some((t) => overlaps(t.start, t.stop))) continue;
		taken.push(m);
	}

	// The first mention of each target is linked; later ones stay as said.
	taken.sort((a, b) => a.start - b.start);
	const linked = new Set<string>();
	let out = "", at = 0;
	for (const m of taken) {
		const key = m.target.toLocaleLowerCase();
		if (linked.has(key)) continue;
		linked.add(key);
		const said = text.slice(m.start, m.end);
		out += text.slice(at, m.start) + (same(said, m.target) ? `[[${m.target}]]` : `[[${m.target}|${said}]]`);
		at = m.end;
	}
	return out + text.slice(at);
}

function same(a: string, b: string): boolean {
	return a.toLocaleLowerCase() === b.toLocaleLowerCase();
}

function escape(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
