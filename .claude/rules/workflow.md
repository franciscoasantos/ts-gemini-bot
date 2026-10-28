# Rule: Implementation workflow

## When finishing any feature

Every feature (a new module, Gemini tool, music command, event handler) closes with these steps,
**in this order**:

```
implementation → tests → docs → `npm run check` clean
```

Don't wrap up without the three.

### 1. Tests

- Non-trivial logic gets or updates **one** Vitest test in `src/*.test.ts` (e.g. `audio.test.ts`).
  What to test and what stays out is in `conventions.md` — only pure functions; anything that
  depends on the network/server doesn't go in.
- `npm run check` (oxlint + `tsc --noEmit` + Vitest) must pass before wrapping up. `sherpa-onnx-node`
  is a native binary that only exists in the container, so locally only lint/tsc/tests run (the
  tests don't import it).

### 2. Documentation

> Every doc records the **current state**. Updating means **overwriting** the part the code made
> false, never appending the new next to the old — history is git's job. When you touch a section
> or comment, rewrite only that part in the present voice. See `documentation.md`.

- Sync the affected docs — `CLAUDE.md`, the rules, `README.md` and `.env.example` when the
  contract (env, commands, tools) changes. No divergence between code and docs.
- A new critical rule goes into `CLAUDE.md` in ~80 words, with the detail in the matching rule.
  `CLAUDE.md` target: **under ~150 lines** — beyond that it costs context every session and erodes
  how well Claude follows its own rules.
- A `CLAUDE.md` bullet that grows is a bullet that should become a rule.

## Git

- **Commit only when the user asks.** Never on your own initiative.
- Messages in **Conventional Commits**, in English (use the `commit-message` skill).
- `git status` before every commit, confirming no secret is staged (see `security.md`).

## Testing the voice

The voice uses the Live API (small, separate free-tier quota). If the voice doesn't respond, check
the logs for `exceeded your current quota` before suspecting the code — text (`!gemini`) uses a
different quota and keeps working.
