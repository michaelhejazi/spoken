# The Gemini request

With the Gemini provider the plugin calls Google's Interactions API directly,
under the user's own key. This is what it sends and how it reads the answer;
`src/gemini.ts` implements it and `test/fake-gemini.mjs` is the fake the tests
run against.

*Written 2026-09-30 from Google's docs as they read that day:
[transcribe](https://ai.google.dev/gemini-api/docs/transcribe),
[gemini-3.5-transcribe](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-transcribe),
[Interactions API](https://ai.google.dev/api/interactions-api).*

## Request

```
POST https://generativelanguage.googleapis.com/v1beta/interactions
x-goog-api-key: <the user's key>
Content-Type: application/json

{
  "model": "gemini-3.5-transcribe",
  "input": [{ "type": "audio", "mime_type": "audio/webm", "data": "<the take, base64>" }],
  "generation_config": {
    "transcription_config": { "mode": "smart", "custom_vocabulary": ["Simin", "Flyo"] }
  }
}
```

- `model` is the Model setting, `gemini-3.5-transcribe` when blank.
- `custom_vocabulary` is the list built in `src/vocabulary.ts` (the terms note,
  then the open note's title and headings, at most 100). It is left out when
  the list is empty. Google's model page allows up to 1,000 terms and advises
  up to 100 for best results; the Interactions reference states no limit.
- `mime_type` is the recording's type with its parameters dropped
  (`audio/webm;codecs=opus` → `audio/webm`). iOS records `audio/mp4`, which is
  not on Gemini's list; it is sent as `audio/m4a`. That mapping has not been
  proved on an iPhone.
- `mode: "smart"` is the string form the transcribe guide shows. The
  Interactions reference describes the mode as an object with `"type": "smart"`
  or an enum; the string is kept, because it is the form already proven
  against Gemini.
- The plugin waits up to 150 s. The request goes through Obsidian's
  `requestUrl`, so no browser CORS applies.

## Answer

The text is every `content[]` item of `type: "text"` in every `steps[]` item
of `type: "model_output"`, joined in order and trimmed. A `status` other than
`completed` is an error, and so is completed with no text.

## Failures, as sentences

| What happened | Sentence (constants in `src/gemini.ts`) |
|---|---|
| no key in settings (nothing is sent) | `NO_KEY` |
| 401, 403, or any error whose message mentions the API key (Google answers a wrong key with 400 `API key not valid`) | `BAD_KEY` |
| 429 or `RESOURCE_EXHAUSTED` | `RATE_LIMITED` |
| 413, or a message saying the payload is too large | `TOO_LARGE` |
| 404 | `unknownModel(model)` |
| 503 | `OVERLOADED` |
| 504, or no answer within 150 s | `TOO_SLOW` |
| other 5xx | `MODEL_FAILED` |
| `status` not `completed` | `NOT_FINISHED` |
| completed with no text | `NO_WORDS` |
| Google not reached | `UNREACHABLE` |
| any other error | Google's own message after "Gemini couldn't transcribe the recording:" |

**The vocabulary fallback.** If Gemini answers 400 with a message mentioning
vocabulary, the plugin sends the same take once more without
`custom_vocabulary` and reports `biased: false`. It does not retry again.

## Polish

When Polish is Light or Full (the setting, Light by default), the transcript
goes back to Gemini as text, once per take and once for each level chosen on
the Ready card. `src/polish.ts` implements it.

*The model was chosen 2026-10-02 from Google's
[models page](https://ai.google.dev/gemini-api/docs/models) (last updated
2026-10-01): `gemini-3.5-flash-lite`, stable, "our fastest, most
cost-effective 3.5 model"; its
[model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite)
calls it "low-latency, cost-effective". The text form of the request follows the
[Interactions API reference](https://ai.google.dev/api/interactions-api):
`input` as a string, `system_instruction` a string, `store` a boolean.*

```
POST https://generativelanguage.googleapis.com/v1beta/interactions
x-goog-api-key: <the user's key>
Content-Type: application/json

{
  "model": "gemini-3.5-flash-lite",
  "system_instruction": "<polishPrompt(level)>",
  "input": "<terms>\nSimin\nFlio\n…\n</terms>\n\n<transcript>\n…\n</transcript>",
  "store": false
}
```

- `model` is the Polish model setting, `gemini-3.5-flash-lite` when blank.
- `system_instruction` is `polishPrompt("light")` or `polishPrompt("full")`,
  the one place the prompt is written.
- The terms are every term in the terms note, then the open note's title and
  headings, each once (`allTerms()` in `src/vocabulary.ts`). No cap: the
  hundred applies to the recording's `custom_vocabulary` only.
- `store: false` asks Google not to keep the interaction.
- The plugin waits up to 30 s. No `thinking_level` is sent; the model's
  default applies.

The answer is read like a transcript (every `model_output` text, in order);
a reply wrapped in `<transcript>` tags is unwrapped. It is then guarded, and
shown only if it passes:

| Check | Light | Full |
|---|---|---|
| Word count (words have a letter or digit, so list dashes don't count) within this fraction of the transcript's | 10% | 25% |
| ...but never held to fewer words of difference than | 1 | 2 |
| No line opening like a reply ("Sure,", "Here's the polished transcript", "As an AI", a `<transcript>` tag…) unless the transcript itself has those words | ✓ | ✓ |
| No capitalised word that is in neither the transcript nor the terms (an answer such as "Paris.") | ✓ | ✓ |

Any error, a status other than `completed`, no answer within 30 s, or a failed
check shows the transcript as heard, with "Polish did not run: *why*." Polish
never makes a take fail.

## Check key

Settings → Check key sends one request per model, which proves the key and the
model names together without spending tokens. It checks the transcribing model
first and, if that works, the Polish model in the same press: it reads the model's own record
([models.get](https://ai.google.dev/api/models), read 2026-10-01).
`src/keycheck.ts` implements it; the fake serves it too.

```
GET https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-transcribe
x-goog-api-key: <the user's key>
```

The model is the Model setting (`gemini-3.5-transcribe` when blank, a leading
`models/` dropped), URL-encoded. The key goes in the header, never in the
URL's `?key=`, so it stays out of any URL log. The check waits 15 s.

| Answer | Outcome shown |
|---|---|
| 200 | the key works and the model exists |
| 401, 403, or any error whose message mentions the API key (Google's 400 `API key not valid`) | the key is refused |
| 404 | the key works but there is no such model |
| no answer, or none within 15 s | Google couldn't be reached |
| anything else (429, 5xx…) | Google's own message |

Google checks the key before the model, so a wrong key with a wrong model
reads as a refused key. Since 2026-05-28 AI Studio makes "auth keys", sent the
same way in `x-goog-api-key`.
