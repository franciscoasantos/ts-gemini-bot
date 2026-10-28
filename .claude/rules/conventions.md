# Code conventions

## Architecture

- **One module per concern, flat.** One file, one responsibility: `index.ts` (connection + text
  + orchestration), `voice.ts` (voice/conversation pipeline), `gemini.ts` (AI), `manager.ts` (TS6
  Manager API), `audio.ts` (DSP/Opus), `filetransfer.ts` (avatar), `i18n.ts` (reply language),
  `tslib/` (TS3 protocol, vendored).
- **No layers, DI, factories or speculative interfaces.** It's a single-process bot;
  over-engineering here is a regression. Reuse what exists before adding an abstraction.
- `tslib/` is third-party code (clusterzx/ts6-manager, MIT). Don't edit unless necessary; if you
  do, keep the license notice.

## Style

- **ESM** with the **`.js`** extension on relative imports (`./audio.js`), even in `.ts` — required
  by `module: nodenext`.
- `strict` on. Avoid `any`; when unavoidable (sherpa N-API, Gemini tools) it's a conscious, local cast.
- **Language**: code, comments, logs and docs are in **English**. What the bot **says/writes to
  users** follows `BOT_LANGUAGE` — Gemini's replies via the system prompt, and the few
  bot-written strings via `src/i18n.ts`. Never hardcode a user-facing string in one language.
- Logging with `console.*` prefixed by context: `[live]`, `[tool]`, `[voice]`, `[ts]`, `[avatar]`.
- Errors: `try/catch` + `console.error`. An empty `catch {}` only when the silence is intentional
  and there's a comment explaining it.
- A deliberate shortcut with a known ceiling gets a `ponytail:` comment stating the ceiling and
  the upgrade path.

## Quality

- Run `npm run format` (Prettier) and `npm run lint` (oxlint). The linter is **syntactic**: the
  project's `typescript@7` is the native preview (`tsgo`), without the JS API that typescript-eslint
  needs, so it isn't type-aware.
- Non-trivial logic leaves **one** runnable check: a Vitest test in `src/*.test.ts` (e.g.
  `audio.test.ts`). No heavy frameworks or fixtures. Only pure functions are tested; anything that
  depends on the network/server stays out.
- Before committing: `npm run check` (lint + `tsc --noEmit` + tests).
