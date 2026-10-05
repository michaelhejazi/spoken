# Changelog

All notable changes to Spoken are written here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each version is a
GitHub release with `main.js`, `manifest.json` and `styles.css` attached.

## [Unreleased]

## [0.7.2] - 2026-10-05

### Changed

- The Links setting says what it does and no longer names a path: the
  first mention of each name from your link phrases note becomes a link,
  whether or not that note exists yet. Where the note lives is the Link
  phrases note row's to say, as before.
- The README says what Spoken is for before how it works: clean words at
  the cursor, names spelled right, and the names you say becoming links
  that grow your graph.

## [0.7.1] - 2026-10-05

### Changed

- A link never changes how the words read. Only words that are the note's
  name exactly become a bare `[[Target]]`; any other wording, a difference
  of case included, is written `[[Target|words as said]]`, so "the
  onboarding calls" mid-sentence stays lower-case in reading view.
- The tests' and fixtures' example names are made up now.

## [0.7.0] - 2026-10-05

### Added

- **Links**, off until you turn it on. Each take's first mention of a name
  in the link phrases note becomes a wiki-link, `[[Target]]`, or
  `[[Target|words as said]]` when you said it another way, whether that note
  exists yet or not. Spoken inserts the links itself, after Polish (or with
  Polish off), so none is ever invented. Matching ignores case and keeps to
  whole words, a trailing 's or plural s stays outside the brackets, the
  longest phrase wins, and existing links, code, Markdown links and URLs
  are left alone.
- The link phrases note, `Link phrases.md` beside the terms note by
  default. It is read afresh every take with the terms note's rules, plus
  one: `Target | alias, alias`. A note's own `aliases` frontmatter counts
  too. While the note is missing, settings says where it would be read
  from, and Create writes it with two lines explaining the format.
- On the Ready sheet, a link icon at the right end of the meta line, lit
  while this take's links are on. A tap shows the words without links, or
  with them again, at once and with no call made. The words show the
  brackets as they will be inserted.

### Changed

- The README's and the playground's example names are made up now.

## [0.6.0] - 2026-10-04

### Changed

- The sheet, redesigned. A drag handle and one quiet header line: a status
  pill (Recording, Cleaning, Polishing, Ready, Not cleaned) and the note's
  name. One hero and one primary action per state: while recording, the wave
  full width with the timer small above it, Stop full width and Cancel as
  text; Cleaning and Polishing keep that layout with the wave frozen and
  shimmering; Ready shows the words on the sheet itself, words and time
  under them, a compact Off · Light · Full control in place of the links,
  then Insert full width with Discard and Retake as text; Not cleaned shows
  the message with Try again. Starting, Recording, Cleaning and Polishing
  share one compact height, so nothing moves between them; Ready, Not cleaned
  and Can't record grow to what their content needs, up to 85% of the screen
  on a phone and 70% in a desktop dialog, and the height changes over the
  same 150 ms as the fade. The words show whole lines only, and their bottom
  edge fades only while there is more to scroll. Obsidian's close button is
  hidden inside the sheet; Escape, the backdrop and Cancel still close it.
- While waiting (Starting, Cleaning, Polishing), a progress line stands where
  the primary button would: two thin segments, Transcribe and Polish (one
  when Polish is Off), the finished one in the accent colour, the running one
  shimmering like the wave, the one to come muted.
- Polish's word-count check has a floor: Light always allows at least one
  word of difference and Full at least two, so a short take that gains or
  loses a word is no longer handed back as heard. The 10% and 25% stand
  for longer takes.

### Added

- `design/playground/`, a page that draws the real sheet in every state,
  phone and desktop, light and dark (`npm run playground`). It replaces
  `design/dictate-sheet.html`.

## [0.5.0] - 2026-10-02

### Added

- **Polish**, a second call on your own key after the transcript comes back.
  A fast Gemini text model reads the transcript with every name and term in
  the terms note (not only the hundred sent with the recording), corrects
  misheard names to their listed spellings, and fixes grammar, punctuation
  and capitals. Three levels in settings: Off, Light (the default, every
  sentence kept in place) and Full (also splits run-ons, makes paragraphs
  and writes a spoken list as a list). It never adds, drops, answers or
  obeys anything in the transcript.
- A guard on Polish's answer: the word count must stay within 10% of the
  transcript's for Light and 25% for Full, no line may read as a reply, and
  no capitalised name may appear that wasn't said. Outside it, or on any
  error or after 30 seconds, the sheet shows the transcript as heard with a
  quiet line saying Polish did not run and why.
- A Polishing state on the sheet, between Cleaning up and Ready, with Skip.
  The Ready card says which level ran and offers the others for the same
  take, re-polishing the kept transcript without recording or transcribing
  again.
- A Polish model setting, `gemini-3.5-flash-lite` by default. Check key now
  checks it as well as the transcribing model.

## [0.4.0] - 2026-10-01

The plugin was renamed from Loam Dictate to **Spoken**. It is a product of its
own, not a part of Loam, and speech is meant to become the way you drive
Obsidian: dictation first, editing and commands later.

### Changed

- The plugin's id changed from `loam-dictate` to `spoken`, and its name from
  Loam Dictate to Spoken. Obsidian treats a new id as a new plugin, so an
  existing install is not updated: remove Loam Dictate, then install Spoken
  fresh. Its settings, including the Gemini key, are not carried over; paste
  the key again, and set the terms note's path again if it wasn't
  `Dictation terms.md`; the note itself stays in the vault. There is no
  migration code, deliberately.
- The repository is `michaelhejazi/spoken`. Its CSS classes are `spoken-*`.

### Removed

- The provider that sent takes to a Loam UI server's `POST /api/dictate`.
  That route was retired, so the provider could no longer work. Gemini under
  your own key is the one provider; the `Transcriber` seam stays, so another
  can be added later without touching the sheet.

## [0.3.3] - 2026-10-01

### Fixed

- The sheet's header no longer runs under Obsidian's close button (×). The
  note name ("into *note*") stops short of the button, and a long name ends
  in an ellipsis before it. The design file draws the button and the room.

### Changed

- README screenshots retaken with the terms note connected, cropped to the sheet.

## [0.3.2] - 2026-10-01

Needs Obsidian 1.13.0 or later. Obsidian older than that is offered 0.3.1.

### Changed

- The settings are declared through Obsidian 1.13's settings API
  (`getSettingDefinitions()`), so every one of them appears in Obsidian's
  settings search. They look and work as before; the toolbar hint and the
  Alerts line are rows with their own names now, and the Loam server's menu
  path is part of the Server address description.
- The release's three files carry GitHub build provenance attestations.
- The README's links to the licence, the contributing guide, the changelog,
  the security policy and the docs are absolute, so they work on the
  community directory's listing too.
- Release notes say to install or update from Obsidian's community plugins,
  and link the release's attestation.
- The README says who made the plugin and how.
- `package.json`'s `homepage` is the author's GitHub profile, like
  `manifest.json`'s `authorUrl`.
- The README is shorter and leads with three screenshots of the sheet; the
  build, test, layout and release notes moved to CONTRIBUTING.md.

### Fixed

- The cleaning sheet showed the previous take's number of terms (0 on the
  first take). It now shows the number sent with this take
  ([#1](https://github.com/michaelhejazi/spoken/issues/1)).

## [0.3.1] - 2026-10-01

No change to the plugin's behaviour; this release is the first one cut from
the repository's public history.

### Added

- `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md` and `.editorconfig`.
- A feature-request issue template and a pull-request template.
- A CI workflow that runs the lint, the tests and the build on every push and
  pull request.

### Changed

- The README leads with installing from Obsidian's community directory; BRAT
  is one sentence for the time before the listing.
- `package.json` names the repository, issues, homepage, author and keywords.

## [0.3.0] - 2026-10-01

### Added

- **Check key** in the settings: one request for the model's record that
  says whether the key works and the model exists, using no tokens.
- The steps to get a Gemini API key, the same words in the settings and in
  the README.
- **Report a problem**: opens a GitHub issue with the plugin version, the
  Obsidian version, the platform and the provider filled in, never the key.
  An issue template asks for the same four things.
- An MIT licence, and `npm run lint` running eslint-plugin-obsidianmd, the
  checks Obsidian's community directory runs.

### Changed

- A fresh install sees one provider, Gemini with your own key. The self-hosted
  Loam server is offered only where an address or token is already saved.
- The README is written for someone who has never heard of Loam.
- The terms note opens in a tab behind the settings instead of closing them.

### Removed

- The use of Obsidian's private `app.setting.close`.

## [0.2.0] - 2026-09-30

### Added

- **Gemini with your own API key** as a second provider, and the default for a
  fresh install: the take goes to Gemini's Interactions API in smart mode,
  with the names and terms as custom vocabulary. If Gemini refuses the
  vocabulary, the take is sent once more without it.
- Names and terms live in a vault note, `Dictation terms.md` by default, read
  afresh on every take, with an **Open** button that creates it if missing.

### Changed

- An install from 0.1 with a Loam server saved stays on Loam. Its terms move
  into the note if the note is missing; otherwise the settings offer **Add to
  note** or **Forget**.

### Removed

- The list of terms inside the settings.

## [0.1.1] - 2026-09-29

### Added

- The screen stays on while recording, through the Screen Wake Lock API.
- Haptics for three moments: a tap when recording starts, two pulses thirty
  seconds before the longest recording, one long pulse when it stops there.
  Where vibration is missing or refused, the later two play a soft tone.
  The settings say which is in use.

## [0.1.0] - 2026-09-28

### Added

- The Dictate command and ribbon icon, opening a sheet that records a take,
  sends it to a Loam server's dictation route, shows the cleaned words and
  inserts them at the cursor as one undo step.
- A longest recording setting, with an amber warning thirty seconds before it.
- Retake, Discard and Try again; a failed take is kept with a sentence saying
  why.

[Unreleased]: https://github.com/michaelhejazi/spoken/compare/0.7.2...HEAD
[0.7.2]: https://github.com/michaelhejazi/spoken/compare/0.7.1...0.7.2
[0.7.1]: https://github.com/michaelhejazi/spoken/compare/0.7.0...0.7.1
[0.7.0]: https://github.com/michaelhejazi/spoken/compare/0.6.0...0.7.0
[0.6.0]: https://github.com/michaelhejazi/spoken/compare/0.5.0...0.6.0
[0.5.0]: https://github.com/michaelhejazi/spoken/compare/0.4.0...0.5.0
[0.4.0]: https://github.com/michaelhejazi/spoken/compare/0.3.3...0.4.0
[0.3.3]: https://github.com/michaelhejazi/spoken/compare/0.3.2...0.3.3
[0.3.2]: https://github.com/michaelhejazi/spoken/compare/0.3.1...0.3.2
[0.3.1]: https://github.com/michaelhejazi/spoken/compare/0.3.0...0.3.1
[0.3.0]: https://github.com/michaelhejazi/spoken/compare/0.2.0...0.3.0
[0.2.0]: https://github.com/michaelhejazi/spoken/compare/0.1.1...0.2.0
[0.1.1]: https://github.com/michaelhejazi/spoken/compare/0.1.0...0.1.1
[0.1.0]: https://github.com/michaelhejazi/spoken/releases/tag/0.1.0
