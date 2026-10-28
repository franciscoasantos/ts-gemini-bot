---
name: commit-message
description: Generates standardized commit messages following Conventional Commits in English, analyzing the git context (diff, status, history). Use this skill whenever the user asks to create a commit, write a commit message, format a commit, or says "/commit". Also use it when the user asks "how do I commit this" or describes changes and asks to record them in git.
---

# Commit Message

Generates commit messages in the Conventional Commits standard in English, automatically analyzing
the repository changes.

## Execution flow

### 1. Collect git context

Run the three commands in parallel:

```bash
git status --short
git diff --staged
git diff
```

If `git diff --staged` is empty, use `git diff` (unstaged changes). If both have content,
prioritize the staged one — that's what goes into the commit.

Also check the latest commits to keep tone and scope consistent:
```bash
git log --oneline -8
```

### 2. Analyze the changes

From the diff and the modified files, answer mentally:

- **What changed?** (behavior, structure, config, text...)
- **Why does it matter?** (fixes a bug, adds a feature, clears tech debt...)
- **What's the breadth?** (a specific module vs. cross-cutting changes)

### 3. Pick type and scope

**Available types:**

| Type | When to use |
|---|---|
| `feat` | New user- or system-visible functionality |
| `fix` | Bug fix |
| `refactor` | Restructuring without behavior change |
| `style` | Formatting, color tokens, visual tweaks with no logic |
| `chore` | Dependencies, config, scripts, build files |
| `docs` | Documentation, comments, CLAUDE.md, README |
| `test` | Unit or integration tests |
| `perf` | Performance optimization |
| `ci` | Pipelines, GitHub Actions, deploy |

**Scope rule:**
- Use a scope when the changes are clearly concentrated in one module or feature: `feat(voice):`,
  `fix(manager):`, `refactor(audio):`
- Omit the scope when the changes are cross-cutting or touch many modules with no single theme
- Common scope examples here: `voice`, `gemini`, `manager`, `audio`, `i18n`, `tslib`

### 4. Write the message

The message follows this required structure:

```
type(scope): short summary

A paragraph explaining what changed and why this approach was chosen. Wrap lines at
100 characters. Separate paragraphs with a blank line.

Additional paragraphs if needed.
```

**Line 1 — summary:**
- Format: `type(scope): description`
- Imperative verb: *add*, *fix*, *remove*, *refactor*, *migrate*, *standardize*...
- No trailing period
- The scope represents the affected module, service or area (e.g. `voice`, `manager`, `audio`)
- Omit the scope if the changes are cross-cutting across many modules

**Line 2 — blank** (always)

**From line 3 — explanatory body:**
- What is being changed?
- Why was it done this way?
- Write in prose, not bullet points
- Wrap lines at 100 characters
- Separate paragraphs with a blank line
- Be clear and direct; avoid overly long text

### 5. Present and confirm

Show the proposed message clearly in a code block. If there are valid alternatives, present at most
2 options.

Ask whether the user wants to adjust before running the commit. If they confirm without changes,
run:

```bash
git commit -m "$(cat <<'EOF'
type(scope): description

Explanatory body here, wrapped at 100 characters.
EOF
)"
```

## Examples of good messages

```
fix(gemini): drop the voice assistant's bias toward music

The Live system instruction presented the bot as a music controller, which made it steer any
conversation toward playing something. It now chats normally about anything and only uses the
music tools when the person clearly asks.
```

```
refactor(voice): extract the voice pipeline from index.ts into voice.ts

index.ts concentrated connection, text and the whole voice pipeline. The pipeline now lives in
voice.ts, exposed by initVoice(client, { sendText, isIgnored }), leaving index.ts with connection,
text and orchestration.
```

```
chore: add oxlint, prettier and vitest with quality scripts

Linter (oxlint), formatter (Prettier) and test runner (Vitest), with lint/format/test scripts and a
single check (oxlint + tsc + vitest). The lint is syntactic because the project's typescript is the
native preview (tsgo), without the JS API typescript-eslint needs.
```

## Examples of bad messages (avoid)

```
feat: changes                          ← too vague
fix: bug fix                           ← no explanatory body
update stuff                           ← no type
feat: Added new import page.           ← trailing period, wrong verb tense
```
