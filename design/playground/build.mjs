// `npm run playground`: builds design/playground/index.html, one self-contained
// page (no network) that draws the real sheet. src/modal.ts is bundled against
// obsidian-stub.ts in place of the `obsidian` package, the real styles.css is
// inlined, and shell.html supplies the frames and Obsidian's default theme
// variables. The page is committed on purpose; CI rebuilds it and fails if the
// committed copy differs.
import esbuild from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

const result = await esbuild.build({
	entryPoints: [here("./main.ts")],
	bundle: true,
	write: false,
	format: "iife",
	target: "es2020",
	alias: { obsidian: here("./obsidian-stub.ts") },
	legalComments: "none",
	logLevel: "warning",
});

// Neither file may end the element it is inlined into.
const inline = (text, tag) => text.replace(new RegExp(`</${tag}`, "gi"), `<\\/${tag}`);
const script = inline(result.outputFiles[0].text, "script");
const styles = inline(readFileSync(here("../../styles.css"), "utf8"), "style");

const page = readFileSync(here("./shell.html"), "utf8")
	.replace("/* STYLES.CSS */", () => styles)
	.replace("/* PLAYGROUND.JS */", () => script);
writeFileSync(here("./index.html"), page);
console.log("design/playground/index.html");
