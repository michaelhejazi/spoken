import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// The settings tab against a stand-in for Obsidian's declarative settings
// (1.13): draw() walks getSettingDefinitions() the way Obsidian renders it,
// skipping what is not visible, handing `render` rows a stand-in Setting and
// recording `control` rows with their value from getControlValue(). Each row
// keeps its name and controls, so the test sees what the tab draws.
const drawn: Row[] = [];
interface Row {
	name: string;
	desc: string;
	controls: Control[];
	controlEl: El;
	descEl: El;
}
interface Control {
	kind: string;
	key?: string;
	inputType?: string;
	value?: string;
	options?: string[];
	onChange?: (v: string) => unknown;
	onClick?: () => unknown;
}
/** Elements the tab creates inside a row, with their text, attributes and children. */
interface El {
	tag: string;
	cls: string;
	text: string;
	href?: string;
	attrs: Record<string, string>;
	children: El[];
	createEl(tag: string, o?: { text?: string; cls?: string; href?: string }): El;
	appendText(t: string): void;
	setText(t: string): void;
	setAttr(k: string, v: string): void;
}
function el(tag: string, o: { text?: string; cls?: string; href?: string } = {}): El {
	const e: El = {
		tag,
		cls: o.cls ?? "",
		text: o.text ?? "",
		href: o.href,
		attrs: {},
		children: [],
		createEl(t, oo) {
			const c = el(t, oo);
			e.children.push(c);
			return c;
		},
		appendText(t) {
			e.children.push(el("#text", { text: t }));
		},
		setText(t) {
			e.text = t;
		},
		setAttr(k, v) {
			e.attrs[k] = v;
		},
	};
	return e;
}
/** An element's whole text, its children's included. */
const textOf = (e: El): string => e.text + e.children.map(textOf).join("");
const links = (e: El): El[] => [...(e.tag === "a" ? [e] : []), ...e.children.flatMap(links)];
/** Every element under a row's description, depth first. */
const under = (e: El): El[] => e.children.flatMap((c) => [c, ...under(c)]);
vi.mock("obsidian", () => {
	const component = (c: Control) => {
		const self: Record<string, unknown> = {
			inputEl: {
				set type(t: string) {
					c.inputType = t;
				},
				autocomplete: "",
			},
		};
		const chain = (fn?: (...a: never[]) => void) => (...a: never[]) => (fn?.(...a), self);
		Object.assign(self, {
			setPlaceholder: chain(),
			setValue: chain((v: string) => (c.value = String(v))),
			onChange: chain((fn: (v: string) => unknown) => (c.onChange = fn)),
			setButtonText: chain((t: string) => (c.value = t)),
			onClick: chain((fn: () => unknown) => (c.onClick = fn)),
		});
		return self;
	};
	class Setting {
		row: Row = { name: "", desc: "", controls: [], controlEl: el("div"), descEl: el("div") };
		controlEl = this.row.controlEl;
		descEl = this.row.descEl;
		setName(n: string) {
			this.row.name = n;
			return this;
		}
		setDesc(d: string) {
			this.row.desc = d;
			this.descEl.children.splice(0);
			return this;
		}
		private add(kind: string, cb: (c: never) => void) {
			const c: Control = { kind };
			this.row.controls.push(c);
			cb(component(c) as never);
			return this;
		}
		addText(cb: (c: never) => void) {
			return this.add("text", cb);
		}
		addButton(cb: (c: never) => void) {
			return this.add("button", cb);
		}
	}
	class PluginSettingTab {
		refreshes = 0;
		refreshDomState() {
			this.refreshes++;
		}
	}
	return { Setting, PluginSettingTab };
});

const { Setting } = await import("obsidian");
const { SpokenSettingTab, upgradeSettings, DEFAULT_SETTINGS, PROVIDER_FIELDS, KEY_STEPS, KEY_PRICING, AI_STUDIO_KEYS_URL, GEMINI_PRICING_URL } =
	await import("../src/settings");
const { makeTranscriber, visibleProviders } = await import("../src/provider");
const { GeminiTranscriber } = await import("../src/gemini");
type Settings = import("../src/settings").SpokenSettings;
type Tab = InstanceType<typeof SpokenSettingTab>;
type Def = import("obsidian").SettingDefinitionItem;

const shown = (v: boolean | (() => boolean) | undefined) => (typeof v === "function" ? v() : v !== false);

/** Draws the tab as Obsidian 1.13 would: visible rows only, in order. */
function draw(t: Tab): void {
	drawn.splice(0);
	const walk = (defs: Def[]) => {
		for (const d of defs) {
			if ("type" in d) {
				if (shown(d.visible) && d.items) walk(d.items as Def[]);
				continue;
			}
			if (!shown(d.visible)) continue;
			if ("render" in d && d.render) {
				const setting = new Setting({} as never) as unknown as { row: Row };
				drawn.push(setting.row);
				d.render(setting as never, {} as never);
			} else {
				const row: Row = { name: d.name, desc: String(d.desc ?? ""), controls: [], controlEl: el("div"), descEl: el("div") };
				if ("control" in d && d.control) {
					const c = d.control;
					row.controls.push({
						kind: c.type,
						key: c.key,
						value: String(t.getControlValue(c.key) ?? c.defaultValue ?? ""),
						options: c.type === "dropdown" ? Object.keys(c.options) : undefined,
						onChange: (v) => t.setControlValue(c.key, v),
					});
				}
				drawn.push(row);
			}
		}
	};
	walk(t.getSettingDefinitions());
}

let linksNoteThere = false;
function tab(settings: Settings) {
	const plugin = {
		settings,
		saveSettings: vi.fn(async () => {}),
		signals: { path: () => "vibration" as const },
		openTermsNote: vi.fn(async () => {}),
		linksNoteExists: vi.fn(async () => linksNoteThere),
		openLinksNote: vi.fn(async () => void (linksNoteThere = true)),
		appendOldTerms: vi.fn(async () => {}),
		checkGeminiKey: vi.fn(async () => ({ outcome: "refused", sentence: "Google refused this key." })),
		reportUrl: vi.fn(() => "https://github.com/michaelhejazi/spoken/issues/new?body=x"),
	};
	const t = new SpokenSettingTab({} as never, plugin as never);
	draw(t);
	return { t, plugin, refreshes: () => (t as unknown as { refreshes: number }).refreshes };
}
const names = () => drawn.map((r) => r.name);
const row = (name: string) => drawn.find((r) => r.name === name)!;

describe("settings as saved", () => {
	it("a fresh install defaults to Gemini", () => {
		expect(upgradeSettings(null)).toEqual({ settings: DEFAULT_SETTINGS, changed: false });
		expect(upgradeSettings({}).settings.provider).toBe("gemini");
		expect(upgradeSettings({ maxMinutes: 5 }).settings.provider).toBe("gemini");
	});

	it("a saved provider this version doesn't have becomes Gemini, saved, with everything else kept", () => {
		expect(upgradeSettings({ provider: "gemini" })).toMatchObject({ settings: { provider: "gemini" }, changed: false });
		const { settings, changed } = upgradeSettings({ provider: "elsewhere", maxMinutes: 7, geminiKey: "fake-gemini-key-not-a-secret" });
		expect(changed).toBe(true);
		expect(settings).toMatchObject({ provider: "gemini", maxMinutes: 7, geminiKey: "fake-gemini-key-not-a-secret" });
	});
});

describe("which providers are offered", () => {
	it("Gemini is the one provider, so there is no Transcribe with row", () => {
		expect(visibleProviders()).toEqual(["gemini"]);
		tab(upgradeSettings(null).settings);
		expect(names()).not.toContain("Transcribe with");
		expect(names()).toEqual(expect.arrayContaining(PROVIDER_FIELDS.gemini));
	});
});

describe("getting to a working key", () => {
	it("Check key sits beside the key field and reports in place under it", async () => {
		const { plugin } = tab({ ...DEFAULT_SETTINGS, geminiKey: "fake-gemini-key-not-a-secret" });
		const key = row("Gemini API key");
		expect(key.controls.map((c) => [c.kind, c.value])).toEqual([
			["text", "fake-gemini-key-not-a-secret"],
			["button", "Check key"],
		]);
		const result = under(key.descEl).find((e) => e.cls.includes("spoken-keycheck"))!;
		expect(result.text).toBe("");
		await key.controls[1].onClick!();
		expect(plugin.checkGeminiKey).toHaveBeenCalledTimes(1);
		expect(result.text).toBe("Google refused this key.");
		expect(result.attrs["data-outcome"]).toBe("refused");
	});

	it("the key's steps fold under the key field, with AI Studio and the pricing page linked, and no prices", () => {
		tab({ ...DEFAULT_SETTINGS });
		const { descEl } = row("Gemini API key");
		const help = descEl.children.find((e) => e.tag === "details")!;
		expect(descEl.children.indexOf(help)).toBe(descEl.children.findIndex((e) => e.cls.includes("spoken-keycheck")) + 1);
		expect(help.children[0]).toMatchObject({ tag: "summary", text: "How to get a Gemini API key" });
		expect(help.children[1].children).toHaveLength(KEY_STEPS.length);
		expect(links(help).map((a) => a.href)).toEqual([AI_STUDIO_KEYS_URL, GEMINI_PRICING_URL]);
		expect(textOf(help)).not.toMatch(/[$€£]\s?\d/);
	});

	it("the README gives the same steps, word for word", () => {
		const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8").replace(/\s+/g, " ");
		const plain = (parts: (string | { text: string; href: string })[]) =>
			parts.map((p) => (typeof p === "string" ? p : `[${p.text}](${p.href})`)).join("");
		for (const step of KEY_STEPS) expect(readme).toContain(plain(step));
		expect(readme).toContain(plain(KEY_PRICING));
	});
});

describe("Report a problem", () => {
	it("is a link in the settings tab to the plugin's pre-filled issue", () => {
		const { plugin } = tab({ ...DEFAULT_SETTINGS });
		const report = row("Report a problem");
		expect(report.desc).toMatch(/Never your key or a recording/);
		expect(links(report.controlEl).map((a) => [a.text, a.href])).toEqual([["Open an issue", plugin.reportUrl()]]);
	});
});

describe("the provider's fields", () => {
	it("Gemini shows the key as a password field and the model with its default", () => {
		tab({ ...DEFAULT_SETTINGS });
		expect(names()).toEqual(expect.arrayContaining(PROVIDER_FIELDS.gemini));
		expect(row("Gemini API key").controls[0].inputType).toBe("password");
		expect(row("Model").controls[0].value).toBe("gemini-3.5-transcribe");
		expect(row("Model").desc).toMatch(/speech-to-text/);
	});

	it("Polish is Off, Light or Full, Light by default, with its model beside it", async () => {
		const settings: Settings = { ...DEFAULT_SETTINGS };
		const { t } = tab(settings);
		expect(row("Polish").controls[0]).toMatchObject({ kind: "dropdown", value: "light", options: ["off", "light", "full"] });
		expect(row("Polish").desc).toMatch(/second call on your key/);
		expect(row("Polish model").controls[0].value).toBe("gemini-3.5-flash-lite");
		await t.setControlValue("polishModel", "  ");
		expect(settings.polishModel).toBe("gemini-3.5-flash-lite");
	});

	it("a saved polish level this version doesn't have becomes Light", () => {
		expect(upgradeSettings({ polish: "loud" })).toMatchObject({ settings: { polish: "light" }, changed: true });
		expect(upgradeSettings({ polish: "full" })).toMatchObject({ settings: { polish: "full" }, changed: false });
	});

	it("the terms note is one path setting with an Open button, and no in-settings list", () => {
		const { plugin } = tab({ ...DEFAULT_SETTINGS });
		expect(row("Names and terms note").controls.map((c) => [c.kind, c.value])).toEqual([
			["text", "Dictation terms.md"],
			["button", "Open"],
		]);
		expect(drawn.some((r) => r.controls.some((c) => c.kind === "textarea"))).toBe(false);
		expect(names()).not.toContain("Names and terms from before 0.2");
		expect(plugin.openTermsNote).not.toHaveBeenCalled();
	});

	it("old terms kept because the note existed are shown, with Add to note and Forget", () => {
		tab({ ...DEFAULT_SETTINGS, terms: "Quillmate\nVecso\n" });
		const old = row("Names and terms from before 0.2");
		expect(old.desc).toMatch(/^2 terms are still in this plugin's settings and not used/);
		expect(old.controls.map((c) => c.value)).toEqual(["Add to note", "Forget"]);
	});

	it("Forget drops the old terms, saves, and the row goes", async () => {
		const settings: Settings = { ...DEFAULT_SETTINGS, terms: "Quillmate\n" };
		const { t, plugin, refreshes } = tab(settings);
		await row("Names and terms from before 0.2").controls[1].onClick!();
		expect(settings.terms).toBeUndefined();
		expect(plugin.saveSettings).toHaveBeenCalled();
		expect(refreshes()).toBe(1);
		draw(t);
		expect(names()).not.toContain("Names and terms from before 0.2");
	});

	it("Open opens the terms note", async () => {
		const { plugin } = tab({ ...DEFAULT_SETTINGS });
		await row("Names and terms note").controls[1].onClick!();
		expect(plugin.openTermsNote).toHaveBeenCalledTimes(1);
	});

	it("constructs the class for the provider chosen", () => {
		const http = vi.fn();
		expect(makeTranscriber(() => ({ ...DEFAULT_SETTINGS }), http)).toBeInstanceOf(GeminiTranscriber);
	});

	it("the constructed transcriber reads its key at send time, so a new key applies to Try again", async () => {
		const settings = { ...DEFAULT_SETTINGS, geminiKey: "" };
		const http = vi.fn(async () => ({ status: 200, text: '{"status":"completed","steps":[{"type":"model_output","content":[{"type":"text","text":"ok"}]}]}' }));
		const t = makeTranscriber(() => settings, http);
		await expect(t.transcribe(new ArrayBuffer(1), "audio/webm", [])).rejects.toThrow(/API key/);
		settings.geminiKey = "fake-gemini-key-not-a-secret";
		await expect(t.transcribe(new ArrayBuffer(1), "audio/webm", [])).resolves.toEqual({ text: "ok", biased: false });
		expect(http.mock.calls[0]).toBeDefined();
	});
});

describe("Links", () => {
	const flush = () => new Promise((r) => setTimeout(r, 0));

	it("off on a fresh install, and the note's row shows only once it is on", () => {
		expect(DEFAULT_SETTINGS.links).toBe(false);
		tab({ ...DEFAULT_SETTINGS });
		expect(row("Links").controls).toMatchObject([{ kind: "toggle", key: "links", value: "false" }]);
		expect(names()).not.toContain("Link phrases note");
		tab({ ...DEFAULT_SETTINGS, links: true });
		expect(names()).toContain("Link phrases note");
	});

	it("the description says what it does and names the note, beside the terms note by default", () => {
		tab({ ...DEFAULT_SETTINGS });
		expect(row("Links").desc).toMatch(/^Turns the first mention of each name in Link phrases\.md into a \[\[link\]\]/);
		tab({ ...DEFAULT_SETTINGS, termsPath: "Lists/Dictation terms.md" });
		expect(row("Links").desc).toContain(" Lists/Link phrases.md ");
		tab({ ...DEFAULT_SETTINGS, termsPath: "Lists/Dictation terms.md", linksPath: "Graph/nodes" });
		expect(row("Links").desc).toContain(" Graph/nodes.md ");
	});

	it("turning it on saves a boolean and shows the note's row", async () => {
		const settings = { ...DEFAULT_SETTINGS };
		const { t, refreshes } = tab(settings);
		await t.setControlValue("links", true);
		expect(settings.links).toBe(true);
		expect(refreshes()).toBe(1);
	});

	it("a missing note: one quiet line saying where it would be read from, and Create writes it", async () => {
		linksNoteThere = false;
		const { plugin } = tab({ ...DEFAULT_SETTINGS, links: true, termsPath: "Lists/Dictation terms.md" });
		await flush();
		const r = row("Link phrases note");
		expect(textOf(r.descEl)).toBe("No note at Lists/Link phrases.md yet, so nothing is linked.");
		expect(r.controls.map((c) => [c.kind, c.value])).toEqual([
			["text", ""],
			["button", "Create"],
		]);
		await r.controls[1].onClick!();
		await flush();
		expect(plugin.openLinksNote).toHaveBeenCalledTimes(1);
		expect(textOf(r.descEl)).toBe("");
		expect(r.controls[1].value).toBe("Open");
	});
});

describe("settings search (Obsidian 1.13's declarative settings)", () => {
	it("the tab is declared, not drawn: no display() of its own", () => {
		expect(Object.getOwnPropertyNames(SpokenSettingTab.prototype)).not.toContain("display");
		expect(Object.getOwnPropertyNames(SpokenSettingTab.prototype)).toContain("getSettingDefinitions");
	});

	it("every row the tab can show is a named, searchable definition, including the hidden ones", () => {
		const { t } = tab({ ...DEFAULT_SETTINGS, terms: "Quillmate" });
		const defs = t.getSettingDefinitions();
		const declared = defs.map((d) => ("name" in d ? d.name : ""));
		expect(declared).toEqual([
			"Transcribe with",
			...PROVIDER_FIELDS.gemini,
			"Dictate from the phone's toolbar",
			"Longest recording",
			"Alerts",
			"Names and terms note",
			"Links",
			"Link phrases note",
			"Names and terms from before 0.2",
			"Report a problem",
		]);
		for (const d of defs) expect("searchable" in d && d.searchable === false).toBe(false);
	});

	it("a drawn row's name and description, which search reads from the definition, are the ones it draws", () => {
		for (const settings of [{ ...DEFAULT_SETTINGS }, { ...DEFAULT_SETTINGS, terms: "Quillmate" }]) {
			const { t } = tab(settings);
			const declared = t.getSettingDefinitions().filter((d) => "name" in d && "render" in d && names().includes(d.name));
			expect(declared.length).toBeGreaterThan(0);
			for (const d of declared) if ("name" in d && d.desc !== undefined) expect(row(d.name).desc).toBe(d.desc);
		}
	});

	it("Longest recording is a 1–15 slider holding the saved minutes, and a typed value is clamped", async () => {
		const settings = { ...DEFAULT_SETTINGS, maxMinutes: 7 };
		const { plugin } = tab(settings);
		expect(row("Longest recording").controls[0]).toMatchObject({ kind: "slider", key: "maxMinutes", value: "7" });
		await row("Longest recording").controls[0].onChange!("40");
		expect(settings.maxMinutes).toBe(15);
		expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
	});

	it("what is typed is saved as before: the key trimmed, a blank model or note path back to its default", async () => {
		const settings: Settings = { ...DEFAULT_SETTINGS };
		const { t } = tab(settings);
		await t.setControlValue("geminiKey", "  fake-gemini-key-not-a-secret ");
		await t.setControlValue("geminiModel", "   ");
		await row("Names and terms note").controls[0].onChange!("  ");
		expect(settings).toMatchObject({
			geminiKey: "fake-gemini-key-not-a-secret",
			geminiModel: "gemini-3.5-transcribe",
			termsPath: "Dictation terms.md",
		});
	});

	it("the Alerts line says how this device will be told, under its own name", () => {
		tab({ ...DEFAULT_SETTINGS });
		expect(row("Alerts").desc).toMatch(/^Vibration: a tap when recording starts/);
		expect(row("Alerts").controls).toEqual([]);
	});
});
