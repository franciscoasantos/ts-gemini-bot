# Rule: Documentation and comments

## The principle

**Docs are a photograph; git is the movie.** Every doc, rule and code comment records the
**current state**. History is the version control system's job: deleting it from the docs loses
nothing, because `git log -p <file>`, `git blame` and `git log -S"<term>"` return the previous
state, the date, the author and the commit that explained the change, with a precision prose can't
match.

Editing means **overwriting the passage**, never appending a paragraph next to the old one. A doc
that piles up versions ages, contradicts the code, and nobody knows when to delete the line.

> Every file must be readable by someone who never saw the previous version.

**Where the diff voice is correct:** commit messages, PR descriptions and release notes. Only there.

## Banned constructions

`was` / `were` · `used to` · `became` · `no longer` · `removed` · `doesn't exist anymore` ·
`before … now …` · `replaced` · `the old` · `legacy` · `previously` · `formerly` ·
`in favor of` · `the first version` · `journey note` · `what changed` · `started as` ·
`migrated from` · `changed from`.

`before` as ordering is fine: "tell the Live API the utterance ended before closing the turn".

## The why stays; the anchor to the past goes

It's not cutting the justification, it's unanchoring it from the previous state.

| Instead of | Write |
|---|---|
| "The wake word was 'ok gemini' and became 'ok google' because whisper-base couldn't get it." | "The wake word is 'ok google': whisper-base transcribes 'gemini' unreliably in PT." |
| "The idle was 15s, then 5s, now 12s." | "The conversation idle is 12s (`CONVO_IDLE_MS`)." |
| "We swapped ESLint for oxlint, which doesn't need the TS API." | "Lint with oxlint: the project's `typescript@7` is the native `tsgo`, without the JS API typescript-eslint needs." |

**An alternative considered and dropped** becomes a prohibition in the present, next to the rule it
protects: not "@discordjs/opus was tested and dropped", but "Don't use `@discordjs/opus`: it
doesn't build on Node/Windows nor easily on ARM64; use `opusscript` (WASM)".

**Names aren't defined by what they replaced.** `voice.ts` isn't "what came out of `index.ts`"; it's
"the voice/conversation pipeline, wired by `initVoice` and attached to the TS client".

## Code comments

A comment says what the code does and why it's that way, never what changed. A comment that only
makes sense to someone who knows the previous version is debt.

```ts
// BANNED
// Became optional when we stopped locking the conversation to the caller.
let listener: number | null = null;

// CORRECT
// null = idle; clid of whoever triggered = conversation locked to that person (only their voice goes to Gemini).
let listener: number | null = null;
```

A deliberate shortcut with a known ceiling is marked with `ponytail:`, stating the ceiling and the
upgrade — it's not history, it's intent in the present (e.g. `// ponytail: one decoder+VAD per
clid, never freed; prune on notifyclientleftview if it grows`).

## Sections that don't exist in a rule or doc

`Status` · `Preconditions` · `What Was Implemented` · `Files Created/Modified` ·
`Completion Criteria [x]` · `Deviations` · `Pending` · `Journey note` · `What was removed` ·
a `| Today | Becomes |` table · struck-through item (`~~text~~`) · constant changelog ·
incident post-mortem.

A real pending item becomes a `TODO` in the code or an issue, not a doc line that rots.
