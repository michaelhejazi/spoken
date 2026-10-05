import { App, PluginSettingTab, Setting, SettingDefinitionItem } from "obsidian";
import type { ButtonComponent } from "obsidian";
import { DEFAULT_MODEL } from "./gemini";
import { DEFAULT_POLISH_MODEL, POLISH_LEVELS, PolishLevel } from "./polish";
import type SpokenPlugin from "./main";
import { PROVIDERS, Provider, ProviderSettings, visibleProviders } from "./provider";
import type { SignalPath } from "./signals";
import { linksPath } from "./links";
import { DEFAULT_TERMS_PATH, termsPath } from "./termsnote";

export interface SpokenSettings extends ProviderSettings {
	/** Longest recording, whole minutes 1–15. */
	maxMinutes: number;
	/** The vault path of the names-and-terms note. */
	termsPath: string;
	/** The second pass over the transcript (src/polish.ts). */
	polish: PolishLevel;
	/** The Gemini text model that polishes. */
	polishModel: string;
	/** Links: the first mention of each phrase in the link phrases note becomes a wiki-link. */
	links: boolean;
	/** The link phrases note's vault path; blank means Link phrases.md beside the terms note. */
	linksPath: string;
	/**
	 * 0.1.x's in-settings list, one per line. Never read for a take: moved into
	 * the terms note once, or kept here until the user chooses (src/termsnote.ts).
	 */
	terms?: string;
}

export const DEFAULT_SETTINGS: SpokenSettings = {
	provider: "gemini",
	geminiKey: "",
	geminiModel: DEFAULT_MODEL,
	maxMinutes: 5,
	termsPath: DEFAULT_TERMS_PATH,
	polish: "light",
	polishModel: DEFAULT_POLISH_MODEL,
	links: false,
	linksPath: "",
};

export const MIN_MINUTES = 1;
export const MAX_MINUTES = 15;

export function clampMinutes(n: unknown): number {
	const v = Math.round(Number(n));
	if (!Number.isFinite(v)) return DEFAULT_SETTINGS.maxMinutes;
	return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, v));
}

/**
 * Settings as saved, brought up to date. A saved provider this version doesn't
 * have becomes Gemini. `changed` says whether the result should be saved back.
 */
export function upgradeSettings(data: unknown): { settings: SpokenSettings; changed: boolean } {
	const saved = (data && typeof data === "object" ? data : {}) as Partial<SpokenSettings>;
	const settings: SpokenSettings = { ...DEFAULT_SETTINGS, ...saved };
	let changed = false;
	if (saved.provider !== undefined && !(visibleProviders() as string[]).includes(saved.provider)) {
		settings.provider = "gemini";
		changed = true;
	}
	if (!(settings.polish in POLISH_LEVELS)) {
		settings.polish = DEFAULT_SETTINGS.polish;
		changed = true;
	}
	settings.maxMinutes = clampMinutes(settings.maxMinutes);
	return { settings, changed };
}

/** The settings each provider shows, by name; the tab draws exactly these. */
export const PROVIDER_FIELDS: Record<Provider, string[]> = {
	gemini: ["Gemini API key", "Model", "Polish", "Polish model"],
};

/** What each saved field becomes when typed into, before it is saved. */
const NORMALISE: Partial<Record<keyof SpokenSettings, (v: unknown) => unknown>> = {
	geminiKey: (v) => String(v).trim(),
	geminiModel: (v) => String(v).trim() || DEFAULT_MODEL,
	maxMinutes: clampMinutes,
	termsPath: (v) => String(v).trim() || DEFAULT_TERMS_PATH,
	polishModel: (v) => String(v).trim() || DEFAULT_POLISH_MODEL,
	links: (v) => v === true || v === "true",
	linksPath: (v) => String(v).trim(),
};

/**
 * Declarative, so every row is in Obsidian's settings search (1.13+). Plain
 * fields are `control`s; the rows with a password field, a button or a link
 * are `render`s, which are searched by their name and description all the same.
 */
export class SpokenSettingTab extends PluginSettingTab {
	/** Redraws the link phrases note's line when a path changes. */
	private linksNoteShown: (() => Promise<void>) | null = null;

	constructor(
		app: App,
		private readonly plugin: SpokenPlugin,
	) {
		super(app, plugin);
	}

	getControlValue(key: string): unknown {
		return this.plugin.settings[key as keyof SpokenSettings];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const k = key as keyof SpokenSettings;
		const normalise = NORMALISE[k];
		Object.assign(this.plugin.settings, { [k]: normalise ? normalise(value) : value });
		await this.plugin.saveSettings();
		// The provider decides which fields are shown, and Links whether its note's row is.
		if (k === "provider" || k === "links") this.refreshDomState();
		if (k === "termsPath" || k === "linksPath") await this.linksNoteShown?.();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const s = this.plugin.settings;
		const on = (p: Provider) => () => s.provider === p;
		// With one provider to offer there is nothing to choose, so no dropdown.
		const offered = visibleProviders();
		return [
			{
				name: "Transcribe with",
				desc: "Who turns the recording into words.",
				visible: offered.length > 1,
				control: { type: "dropdown", key: "provider", options: Object.fromEntries(offered.map((p) => [p, PROVIDERS[p]])) },
			},
			{
				name: PROVIDER_FIELDS.gemini[0],
				desc: GEMINI_KEY_DESC,
				aliases: ["Check key", "How to get a Gemini API key", "Google AI Studio"],
				visible: on("gemini"),
				render: (setting) => this.geminiKey(setting),
			},
			{
				name: PROVIDER_FIELDS.gemini[1],
				desc: `The Gemini model that transcribes. ${DEFAULT_MODEL} is Google's speech-to-text model; change this only when Google names a newer one.`,
				visible: on("gemini"),
				control: { type: "text", key: "geminiModel", placeholder: DEFAULT_MODEL },
			},
			{
				name: PROVIDER_FIELDS.gemini[2],
				desc: POLISH_DESC,
				aliases: ["Grammar", "Spelling", "Second pass"],
				visible: on("gemini"),
				control: { type: "dropdown", key: "polish", options: { ...POLISH_LEVELS } },
			},
			{
				name: PROVIDER_FIELDS.gemini[3],
				desc: `The Gemini text model that polishes. ${DEFAULT_POLISH_MODEL} is Google's fastest text model; change this only when Google names a newer one. Check key checks it too.`,
				visible: on("gemini"),
				control: { type: "text", key: "polishModel", placeholder: DEFAULT_POLISH_MODEL },
			},
			{
				name: "Dictate from the phone's toolbar",
				desc: "Settings → Toolbar → Add global command → Spoken: Dictate.",
				aliases: ["Mobile toolbar"],
			},
			{
				name: "Longest recording",
				desc: `Whole minutes, ${MIN_MINUTES}–${MAX_MINUTES}. Recording stops by itself at this length.`,
				control: { type: "slider", key: "maxMinutes", min: MIN_MINUTES, max: MAX_MINUTES, step: 1 },
			},
			{
				name: "Alerts",
				desc: signalLine(this.plugin.signals.path()),
				aliases: ["Vibration", "Haptics", "Tone"],
			},
			{
				name: "Names and terms note",
				desc: TERMS_NOTE_DESC,
				aliases: ["Vocabulary", "Spelling"],
				render: (setting) => {
					setting
						.setName("Names and terms note")
						.setDesc(TERMS_NOTE_DESC)
						.addText((t) =>
							t
								.setPlaceholder(DEFAULT_TERMS_PATH)
								.setValue(s.termsPath)
								.onChange((v) => this.setControlValue("termsPath", v)),
						)
						.addButton((b) => b.setButtonText("Open").onClick(() => void this.plugin.openTermsNote()));
				},
			},
			{
				name: "Links",
				desc: linksDesc(this.linksNotePath()),
				aliases: ["Wiki-links", "Graph", "Link phrases"],
				control: { type: "toggle", key: "links" },
			},
			{
				name: LINKS_NOTE_NAME,
				desc: LINKS_NOTE_DESC,
				visible: () => s.links,
				render: (setting) => this.linksNote(setting),
			},
			{
				name: OLD_TERMS_NAME,
				visible: () => s.terms !== undefined,
				render: (setting) => this.oldTerms(setting),
			},
			{
				name: "Report a problem",
				desc: REPORT_DESC,
				aliases: ["Bug", "Issue"],
				render: (setting) => {
					setting.setName("Report a problem").setDesc(REPORT_DESC);
					setting.controlEl.createEl("a", { text: "Open an issue", href: this.plugin.reportUrl() });
				},
			},
		];
	}

	/** The key as a password field, Check key beside it, its answer and the steps to a key folded under it. */
	private geminiKey(setting: Setting): void {
		const s = this.plugin.settings;
		setting.setName(PROVIDER_FIELDS.gemini[0]).setDesc(GEMINI_KEY_DESC);
		const result = setting.descEl.createEl("p", { cls: "setting-item-description spoken-keycheck" });
		this.keyHelp(setting.descEl);
		setting
			.addText((t) => {
				t.inputEl.type = "password";
				t.inputEl.autocomplete = "off";
				t.setValue(s.geminiKey).onChange((v) => this.setControlValue("geminiKey", v));
			})
			.addButton((b) =>
				b.setButtonText("Check key").onClick(async () => {
					result.setText("Checking…");
					result.setAttr("data-outcome", "checking");
					const check = await this.plugin.checkGeminiKey();
					result.setText(check.sentence);
					result.setAttr("data-outcome", check.outcome);
				}),
			);
	}

	/** The steps to a key, folded under the key field. The README repeats KEY_STEPS word for word. */
	private keyHelp(parent: HTMLElement): void {
		const details = parent.createEl("details", { cls: "spoken-keyhelp" });
		details.createEl("summary", { text: "How to get a Gemini API key" });
		const list = details.createEl("ol");
		for (const step of KEY_STEPS) {
			const li = list.createEl("li");
			for (const part of step) {
				if (typeof part === "string") li.appendText(part);
				else li.createEl("a", { text: part.text, href: part.href });
			}
		}
		const pricing = details.createEl("p");
		for (const part of KEY_PRICING) {
			if (typeof part === "string") pricing.appendText(part);
			else pricing.createEl("a", { text: part.text, href: part.href });
		}
	}

	/** Where the link phrases note is read from. */
	private linksNotePath(): string {
		return linksPath(this.plugin.settings.linksPath, termsPath(this.plugin.settings.termsPath));
	}

	/**
	 * The link phrases note's path, and Open beside it; while the note is
	 * missing, one quiet line says where it would be read from and the button
	 * is Create.
	 */
	private linksNote(setting: Setting): void {
		const s = this.plugin.settings;
		setting.setName(LINKS_NOTE_NAME).setDesc(LINKS_NOTE_DESC);
		const missing = setting.descEl.createEl("p", { cls: "setting-item-description spoken-links-missing" });
		let button: ButtonComponent | null = null;
		const show = async () => {
			const path = this.linksNotePath();
			const exists = await this.plugin.linksNoteExists();
			missing.setText(exists ? "" : `No note at ${path} yet, so nothing is linked.`);
			button?.setButtonText(exists ? "Open" : "Create");
		};
		this.linksNoteShown = show;
		setting
			.addText((t) =>
				t
					.setPlaceholder(this.linksNotePath())
					.setValue(s.linksPath)
					.onChange((v) => this.setControlValue("linksPath", v)),
			)
			.addButton((b) => {
				button = b.setButtonText("Open").onClick(() => void this.plugin.openLinksNote().then(show));
			});
		void show();
	}

	/** 0.1.x's list, still in settings because the note already existed. Nothing reads it. */
	private oldTerms(setting: Setting): void {
		const count = (this.plugin.settings.terms ?? "").split(/\r?\n/).filter((l) => l.trim()).length;
		setting
			.setName(OLD_TERMS_NAME)
			.setDesc(
				`${count} ${count === 1 ? "term is" : "terms are"} still in this plugin's settings and not used, because the terms note already existed. Add them to the end of the note, or forget them.`,
			)
			.addButton((b) => b.setButtonText("Add to note").onClick(() => void this.plugin.appendOldTerms().then(() => this.refreshDomState())))
			.addButton((b) =>
				b.setButtonText("Forget").onClick(async () => {
					delete this.plugin.settings.terms;
					await this.plugin.saveSettings();
					this.refreshDomState();
				}),
			);
	}
}

const GEMINI_KEY_DESC =
	"Recordings go from this device to Google under your key and nowhere else. The key is stored in plain text in this plugin's settings file inside the vault.";
const POLISH_DESC =
	"A second call on your key after the transcript comes back. Light corrects names to the terms note's spellings and fixes grammar, punctuation and casing, keeping every sentence in place. Full also reshapes sentences, makes paragraphs and turns a spoken list into a list. Nothing is ever added, dropped or answered; if the result doesn't hold up, the transcript is shown as heard.";
const TERMS_NOTE_DESC =
	"A note in this vault of names and terms you want spelled right, one per line. It is read on every take, with the open note's title and headings added.";
const LINKS_NOTE_NAME = "Link phrases note";
const LINKS_NOTE_DESC =
	"Note names to link, one per line. After a pipe come other ways you say it: Ridge loop | the loop, ridge trail. A note's own aliases count too.";
const OLD_TERMS_NAME = "Names and terms from before 0.2";
const REPORT_DESC =
	"Opens a new issue on GitHub with the plugin version, Obsidian version, platform and provider filled in. Never your key or a recording.";

type Part = string | { text: string; href: string };

export const AI_STUDIO_KEYS_URL = "https://aistudio.google.com/apikey";
export const GEMINI_PRICING_URL = "https://ai.google.dev/gemini-api/docs/pricing";

/** Google AI Studio's steps as Google's API key page described them on 2026-10-01. */
export const KEY_STEPS: Part[][] = [
	["Open ", { text: "Google AI Studio's API keys page", href: AI_STUDIO_KEYS_URL }, " and sign in with a Google account."],
	[
		"Select Create API key. The first time, Google asks you to accept its terms of service, and AI Studio may then create a Google Cloud project and a key for you.",
	],
	["Copy the key, paste it into Gemini API key in Spoken's settings, and press Check key."],
	["Treat the key like a password: anyone who has it can use your quota."],
];
export const KEY_PRICING: Part[] = [
	"Whether you pay, and how much, is on ",
	{ text: "Google's Gemini API pricing page", href: GEMINI_PRICING_URL },
	".",
];

/** The Links row: what it does, and which note it reads. */
export function linksDesc(path: string): string {
	return `Turns the first mention of each name in ${path} into a [[link]] in the words that insert, whether that note exists yet or not, so your graph grows as you dictate. The terms note is never linked.`;
}

/** The Alerts row: how the three moments reach this device; no setting, just what is in use. */
export function signalLine(path: SignalPath): string {
	switch (path) {
		case "vibration":
			return "Vibration: a tap when recording starts, two pulses thirty seconds before the longest recording, one long pulse when it stops there.";
		case "tone: no vibration":
			return "A soft tone thirty seconds before the longest recording and when it stops there, because Obsidian has no vibration on this device.";
		case "tone: vibration refused":
			return "A soft tone thirty seconds before the longest recording and when it stops there, because this device refused to vibrate for Obsidian.";
	}
}
