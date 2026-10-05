import { Editor, MarkdownFileInfo, Notice, Platform, Plugin, TFile, apiVersion, normalizePath, parseFrontMatterAliases, requestUrl } from "obsidian";
import { issueUrl, platformName } from "./feedback";
import { HttpClient } from "./http";
import { CHECK_WAIT_MS, KeyCheck, MODELS_ENDPOINT, checkGeminiKey } from "./keycheck";
import { LINKS_NOTE_HEADER, Phrase, linksPath, readLinksNote, withNoteAliases } from "./links";
import { DictateModal } from "./modal";
import { PROVIDERS, makePolisher, makeTranscriber } from "./provider";
import { mediaRecorderFactory } from "./recorder";
import { realClock } from "./session";
import { Signals, browserSignalEnv } from "./signals";
import { DEFAULT_SETTINGS, SpokenSettingTab, SpokenSettings, clampMinutes, upgradeSettings } from "./settings";
import { NoteStore, ensureTermsNote, moveOldTerms, readTermsNote, termsPath } from "./termsnote";
import { allTerms, buildTerms } from "./vocabulary";
import { ScreenWake, browserWakeEnv } from "./wakelock";

export default class SpokenPlugin extends Plugin {
	settings: SpokenSettings = { ...DEFAULT_SETTINGS };
	private open = new Set<DictateModal>();
	/** Shared by every take, so the settings tab can say how the moments reach this device. */
	readonly signals = new Signals(browserSignalEnv);

	async onload(): Promise<void> {
		await this.loadSettings();
		// The vault's files are known once the layout is ready.
		this.app.workspace.onLayoutReady(() => void this.moveOldTerms());

		this.addCommand({
			id: "dictate",
			name: "Dictate",
			icon: "mic",
			editorCallback: (editor, ctx) => void this.dictate(editor, ctx),
		});

		this.addRibbonIcon("mic", "Dictate", () => {
			// The same command, so the ribbon behaves exactly as the toolbar does.
			const editor = this.app.workspace.activeEditor;
			if (editor?.editor) void this.dictate(editor.editor, editor);
			else new Notice("Spoken: open a note in edit mode first.");
		});

		this.addSettingTab(new SpokenSettingTab(this.app, this));

		// Leaving the note throws the take away, the same rule as the app.
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				const file = this.app.workspace.activeEditor?.file ?? null;
				for (const m of [...this.open]) if (m.file !== file) m.leftTarget();
			}),
		);
	}

	onunload(): void {
		// Closing each sheet releases its microphone.
		for (const m of [...this.open]) m.close();
		this.open.clear();
	}

	private async dictate(editor: Editor, ctx: MarkdownFileInfo): Promise<void> {
		const file = ctx.file;
		if (!file) {
			new Notice("Spoken: open a note in edit mode first.");
			return;
		}
		const terms = () => this.termsFor(file);
		const http = this.http;
		const termCount = (await terms()).length;
		const modal = new DictateModal(
			this.app,
			{ editor, ctx, file },
			{
				recorders: mediaRecorderFactory(),
				transcriber: makeTranscriber(() => this.settings, http),
				terms,
				polisher: makePolisher(() => this.settings, http),
				polishLevel: () => this.settings.polish,
				polishTerms: () => this.polishTermsFor(file),
				links: () => this.settings.links,
				linkPhrases: () => this.phrasesFor(file),
				capMs: clampMinutes(this.settings.maxMinutes) * 60_000,
				clock: realClock,
				signal: (m) => this.signals.signal(m),
				awake: new ScreenWake(browserWakeEnv()),
			},
			termCount,
			(m) => this.open.delete(m),
		);
		this.open.add(modal);
		modal.open();
	}

	/** Obsidian's requestUrl, so no browser CORS applies on phone or desktop. */
	private readonly http: HttpClient = (req) => requestUrl(req);

	/** Settings → Check key: one request for the configured model's record, under the key. */
	checkGeminiKey(): Promise<KeyCheck> {
		return checkGeminiKey(this.settings.geminiKey, this.settings.geminiModel, this.http, CHECK_WAIT_MS, MODELS_ENDPOINT, this.settings.polishModel);
	}

	/** Settings → Report a problem: a new issue with the four facts filled in, and nothing else. */
	reportUrl(): string {
		return issueUrl({
			pluginVersion: this.manifest.version,
			obsidianVersion: apiVersion,
			platform: platformName(Platform),
			provider: PROVIDERS[this.settings.provider],
		});
	}

	/** Read fresh from the note on every take: the note's terms, then this note's title and headings. */
	private async termsFor(file: TFile): Promise<string[]> {
		const headings = this.app.metadataCache.getFileCache(file)?.headings?.map((h) => h.heading) ?? [];
		return buildTerms(await readTermsNote(this.notes, this.termsPath()), file.basename, headings);
	}

	/** Every name and term for Polish, uncapped, read fresh like the take's. */
	private async polishTermsFor(file: TFile): Promise<string[]> {
		const headings = this.app.metadataCache.getFileCache(file)?.headings?.map((h) => h.heading) ?? [];
		return allTerms(await readTermsNote(this.notes, this.termsPath()), file.basename, headings);
	}

	/**
	 * The link phrases note's targets, read fresh like the terms, each with the
	 * aliases of the vault's note of that name. The open note is left out: it
	 * would only link to itself.
	 */
	private async phrasesFor(file: TFile): Promise<Phrase[]> {
		const cache = this.app.metadataCache;
		const phrases = (await readLinksNote(this.notes, this.linksPath())).filter((p) => {
			const dest = cache.getFirstLinkpathDest(p.target, file.path);
			return dest !== file && p.target.toLocaleLowerCase() !== file.basename.toLocaleLowerCase();
		});
		return withNoteAliases(phrases, (target) => {
			const dest = cache.getFirstLinkpathDest(target, file.path);
			return (dest && parseFrontMatterAliases(cache.getFileCache(dest)?.frontmatter)) || [];
		});
	}

	private linksPath(): string {
		return normalizePath(linksPath(this.settings.linksPath, this.termsPath()));
	}

	/** Settings → Link phrases note: whether it is there yet. */
	linksNoteExists(): Promise<boolean> {
		return this.app.vault.adapter.exists(this.linksPath());
	}

	/** Settings → Link phrases note → Create or Open: as for the terms note, with the format's two lines. */
	openLinksNote(): Promise<void> {
		return this.openNote(this.linksPath(), LINKS_NOTE_HEADER);
	}

	private termsPath(): string {
		return normalizePath(termsPath(this.settings.termsPath));
	}

	/** The vault as src/termsnote.ts sees it. Reads go to the disk, so an edit synced a moment ago counts. */
	private readonly notes: NoteStore = {
		exists: (path) => this.app.vault.adapter.exists(path),
		read: (path) => this.app.vault.adapter.read(path),
		create: async (path, text) => {
			const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
			if (folder && !(await this.app.vault.adapter.exists(folder))) await this.app.vault.createFolder(folder);
			await this.app.vault.create(path, text);
		},
	};

	private async moveOldTerms(): Promise<void> {
		const had = this.settings.terms !== undefined;
		const moved = await moveOldTerms(this.settings, this.notes, this.termsPath());
		if (had && this.settings.terms === undefined) await this.saveSettings();
		if (moved === "moved into the note") {
			new Notice(`Spoken: your names and terms are now in the note ${this.termsPath()}.`);
		}
	}

	/**
	 * Opens the terms note in a new tab, creating it first if it isn't there.
	 * Obsidian's public API has no way to close the settings window, so it stays
	 * open over the note and a notice says where the note is.
	 */
	openTermsNote(): Promise<void> {
		return this.openNote(this.termsPath());
	}

	private async openNote(path: string, header?: string): Promise<void> {
		await ensureTermsNote(this.notes, path, header);
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		await this.app.workspace.getLeaf("tab").openFile(file);
		new Notice(`Spoken: ${path} is open in a new tab. Close settings to see it.`);
	}

	/** Adds 0.1.x's list to the end of the terms note and drops it from settings. */
	async appendOldTerms(): Promise<void> {
		const lines = (this.settings.terms ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
		const path = this.termsPath();
		await ensureTermsNote(this.notes, path);
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		if (lines.length) await this.app.vault.process(file, (text) => text.replace(/\n*$/, "\n") + lines.join("\n") + "\n");
		delete this.settings.terms;
		await this.saveSettings();
	}

	async loadSettings(): Promise<void> {
		const { settings, changed } = upgradeSettings(await this.loadData());
		this.settings = settings;
		if (changed) await this.saveSettings();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
