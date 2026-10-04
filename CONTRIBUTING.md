# Contributing to Spoken

Thank you for wanting to help. Bug reports, fixes and small improvements are
all welcome. For anything larger than a fix, please open an issue first so we
can agree on the shape before you spend the time.

## Build, test, lint

Needs Node 20 or later (developed on Node 24).

```sh
npm ci
npm run build    # type-checks src/, then bundles it into main.js
npm test         # type-checks the tests, then runs them with Vitest
npm run lint     # eslint-plugin-obsidianmd, the community directory's checks
npm run playground  # rebuilds design/playground/index.html from the sheet's code
```

CI runs all four on every push and pull request, and fails if the committed
playground differs from a fresh build
(`.github/workflows/ci.yml`). The tests need no device, no microphone and no
network: the transcriber is tested against a fake that serves real HTTP on a
local port (`test/fake-gemini.mjs`), and the
microphone, wake lock and vibration are fakes too.

`npm run lint` must report no errors. Its warnings are kept on purpose and
explained in [docs/submission.md](docs/submission.md); a new warning needs a
reason there too.

**Bundler: esbuild.** Obsidian's sample plugin uses esbuild, so
`esbuild.config.mjs` follows the sample's setup: a single CommonJS file, with
`obsidian`, Electron and CodeMirror left for the app to provide. Using the same
setup as the sample means Obsidian's documentation applies to this plugin as
written.

### What the tests cover

The fake Gemini (`test/fake-gemini.mjs`) serves the interactions endpoint and
model records; its key is `fake-gemini-key-not-a-secret`. Over it and the
other fakes, the tests cover:

- the request the Gemini provider builds: the JSON body with and without
  terms, the base64 audio and the MIME mapping for WebM and MP4
- the sentence shown for each error, and Gemini's vocabulary fallback
- Check key's request and its outcomes: the key works, refused, unknown model,
  Google unreachable
- the settings tab's rows, over a stand-in for Obsidian 1.13's declarative
  settings (`getSettingDefinitions()`) that draws only the visible rows
- the Report a problem link's body, and that it never carries a key
- opening the terms note without Obsidian's private settings API
- the terms note parsed from `test/fixtures/Dictation terms.md`, the vocabulary
  list and its caps, and the move from 0.1's settings
- the spacing rule for inserted words
- the sheet's state machine through every way out, over a fake microphone that
  checks it was released
- the screen wake lock and the three haptic moments
- that the README gives the key steps word for word as the settings do

## Try it in a vault

Use a test vault, not the one you keep your notes in.

1. `npm run build` (or `npm run dev` to rebuild on every change).
2. Copy `main.js`, `manifest.json` and `styles.css` into
   `<vault>/.obsidian/plugins/spoken/`. A symlink of the repository to
   that folder saves copying each time.
3. In Obsidian, Settings → Community plugins → enable **Spoken**.
4. Paste a Gemini API key in its settings and press Check key. A take in the
   vault needs a real key; the fake Gemini is for the tests only.

## Where things are written

Some things are written in exactly one place, and everything else reads them
from there. Change them there and nowhere else:

- **The haptic patterns**: `HAPTICS` in `src/signals.ts` (started, warning,
  cap), with the tone that replaces them where vibration isn't felt.
- **The names and terms**: what counts as a term in the note is
  `src/termsnote.ts`; how many are sent, and how long each may be, is
  `src/vocabulary.ts`.
- **The Polish prompt**: `polishPrompt()` in `src/polish.ts`, built from
  three constants beside it, with the guard's thresholds (`WORD_DRIFT`) and
  the default polish model.
- **The steps to a Gemini key**: `KEY_STEPS` and `KEY_PRICING` in
  `src/settings.ts`. The README repeats them, and a test fails if the two
  differ.

`src/session.ts`, the sheet's state machine, imports neither the DOM nor
`obsidian`, which is what lets every way out of a take be tested in Node.
Please keep it that way.

## How it is put together

| File | What it does |
|---|---|
| `src/main.ts` | The plugin: the Dictate command and ribbon icon, settings, reading the terms note through the vault, Check key and the Report a problem link. |
| `src/transcriber.ts` | `Transcriber.transcribe(audio, mimeType, terms) → {text, biased}`, the only thing the sheet knows about transcribing. |
| `src/provider.ts` | The provider setting, the providers there are, and `makeTranscriber()`, the one place a transcriber is constructed. |
| `src/gemini.ts` | `GeminiTranscriber`: the take to Gemini's Interactions API under the user's key. |
| `src/polish.ts` | Polish: the second call, a fast text model reading the transcript with every term, the prompt, and the guard that decides whether its answer is shown or the transcript is. |
| `src/keycheck.ts` | Check key: one GET for each model's record (transcribing, then polishing), and what the answer means. |
| `src/http.ts` | What the requests share: Obsidian's `requestUrl` (so no browser CORS applies) and the wait. |
| `src/feedback.ts` | The Report a problem link and its four facts. |
| `src/settings.ts` | The settings, their upgrade from 0.1, the settings tab and the key steps. |
| `src/termsnote.ts` | The terms note: parsing it, creating it, moving 0.1's list into it. |
| `src/session.ts` | The sheet's state machine: starting, recording, cleaning, polishing, ready, not cleaned, unsupported, closed. It keeps the transcript as heard until Insert or Discard, so another polish level re-polishes it. It uses no DOM and no Obsidian, so it can be tested on its own. |
| `src/recorder.ts` | `MediaRecorder` over `getUserMedia`. It asks for Opus in WebM at 32 kbit/s where the platform offers it, and the recording's real MIME type is what gets sent. |
| `src/signals.ts` | The three haptic patterns by name (`HAPTICS`), and the soft-tone fallback where vibration isn't felt. |
| `src/wakelock.ts` | `ScreenWake`: keeps the screen on while the session is recording, asking again whenever the page is shown. |
| `src/modal.ts` | The sheet, an Obsidian `Modal`. It draws the session's phase; `design/playground/` renders it in every state. |
| `src/insert.ts`, `src/vocabulary.ts` | The spacing rule and the terms list. |

Another way to transcribe, such as a hosted service, is another `Transcriber`
added to `PROVIDERS` and chosen in `makeTranscriber()`. The sheet does not
change; with two providers the settings show the Transcribe with dropdown.

Everything the plugin creates is released when it closes: the microphone, the
screen wake lock, the clock, the drawing loop and the listeners. Unloading the
plugin closes any open sheet.

`design/playground/index.html` is the sheet's design reference: one page, no
network, that draws the real sheet in every state, in a phone frame
(390 × 844) and at desktop width, light or dark. Open it in a browser; the bar
switches state, the arrow keys step through them, and a state can be linked
(`index.html#ready-long`, `#failed/light`). It is not a drawing: `npm run
playground` bundles `src/modal.ts` against `design/playground/obsidian-stub.ts`
(a stand-in for the few Obsidian APIs the sheet touches: `Modal`, `App`,
`TFile`, `MarkdownView`, `Notice` and the DOM helpers Obsidian adds to every
element) and inlines the real `styles.css`, with Obsidian's default theme
variables approximated in `design/playground/shell.html`. The page is
committed so a copy can be opened without building; edit `shell.html` or
`main.ts` beside it, never `index.html`, and rebuild after any change to the
sheet's code or `styles.css`. Switching state redraws the open sheet, so a
change of height animates as in the app; each frame sets `--spoken-vh` to 1%
of its own height, so the sheet's vh caps are the frame's, not the page's.
`docs/` holds the contract of
the requests to Gemini, the notes for submitting to the community directory, and
the README's screenshots (`docs/images/`).

## A good pull request

- One change, with a title that says what it does for someone using the
  plugin.
- Tests for the behaviour it changes, and `npm test`, `npm run lint` and
  `npm run build` passing.
- The README updated where it describes what you changed, and a line under
  *Unreleased* in [CHANGELOG.md](CHANGELOG.md).
- Works on mobile: no Node or Electron APIs, no inline styles, no regex
  lookbehind (older iOS), as Obsidian's
  [plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
  ask.
- No keys or tokens anywhere: in code, tests, screenshots or
  the description. The fakes' credentials are fixtures that say they are not
  secrets.

If a change touches the requests to Gemini, update the contract in
`docs/gemini-request.md` and the fake that implements it.

## Releases

Releases are cut by the maintainer:

1. `npm version <x.y.z> --no-git-tag-version` updates `package.json`, the
   `manifest.json` version and `versions.json`. `versions.json` maps each
   version to the minimum Obsidian version it needs. Add the version to
   [CHANGELOG.md](CHANGELOG.md) and commit.
2. Tag with the manifest version exactly (no `v`) and push the tag:
   `git tag <x.y.z> && git push origin main <x.y.z>`.
3. `.github/workflows/release.yml` checks that the tag matches the manifest,
   then tests, builds, and creates the GitHub release with `main.js`,
   `manifest.json` and `styles.css` attached, each with a GitHub build
   provenance attestation (`actions/attest-build-provenance`), so a download
   can be checked with `gh attestation verify main.js --repo michaelhejazi/spoken`.
   It then writes the release URL, the asset sizes, the SHA-256 of each asset
   and the attestation's URL as a git note on the tagged commit, which you can
   read without GitHub access:
   `git fetch origin refs/notes/release:refs/notes/release && git notes --ref=release show <x.y.z>`.

Submitting to Obsidian's community directory is done by hand on
community.obsidian.md; [docs/submission.md](docs/submission.md) has the entry
and the steps.
