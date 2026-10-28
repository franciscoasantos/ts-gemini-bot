# Security (public repo)

This repository is **public**. Nothing sensitive may ever enter git.

- **Secrets are gitignored, never commit them**: `.env` (Gemini key, TS6 Manager
  username/password) and `identity.json`. Don't paste those values into any versioned file —
  README, CLAUDE.md, rules, tests or comments.
- **The server's SSH host/user does not enter the repo.** It stays outside (e.g. in the session
  memory or in `.claude/settings.local.json`, which is gitignored). In repo examples, use a
  placeholder (`<server>`).
- `identity.json` is the bot's cryptographic identity on the TS server; if it leaks or is
  replaced, the bot becomes a different client. It is persisted in the `./data` volume in Docker.
- **Before any commit, run `git status`** and confirm no secret is staged. When in doubt, don't
  commit.
- Commits only happen **when the user asks** (see `workflow.md`).
