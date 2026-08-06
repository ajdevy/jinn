# Contributing to Jinn

Thanks for your interest in contributing. This guide covers the basics.

## Prerequisites

- Node.js 22 or later
- pnpm 10+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`npm install -g @anthropic-ai/claude-code`)

## Development Setup

1. Fork and clone the repository.
2. Install dependencies:
   ```bash
   pnpm install
   ```
3. Initialize Jinn (one-time - builds all packages and creates `~/.jinn`):
   ```bash
   pnpm setup
   ```
   This is safe to re-run; it skips files that already exist.
4. Start development mode:
   ```bash
   pnpm dev
   ```
   Then open [http://localhost:3000](http://localhost:3000). The Next.js dev
   server proxies API requests to the gateway on `:7777` automatically.

## Submitting Pull Requests

- Create a feature branch from `main`.
- Keep commits focused and descriptive.
- Run `pnpm typecheck` and `pnpm build` before submitting.
- Open a pull request against `main` with a clear description of your changes.

## Code Style

- TypeScript with strict mode enabled.
- ESM modules (no CommonJS).
- Tailwind CSS for styling in the web package.
- Follow existing patterns in the codebase.

## Footgun Checks

CI runs `scripts/check-footguns.mjs` over the lines your change **adds**. It
covers six things this project has actually shipped by accident: an absolute
`/Users/` path, a `.jinn` home built from `os.homedir()` instead of
`resolveJinnHome()`, an email on a real domain, a literal `7777`/`7788` port, a
`process.env` read outside the config layer, and a `child_process` spawn with no
explicit `stdio`. Each finding prints the fix.

- `pnpm footguns` checks your branch against `origin/main`.
- `node scripts/check-footguns.mjs --staged` checks what you are about to commit.
- `node scripts/check-footguns.mjs --all` audits the whole tree, including the
  debt that predates the check. CI never reads that debt.
- `node scripts/check-footguns.mjs --list` prints the six rules and their fixes.

Suppress a single line by ending it with `// footgun: ok <reason>` (or
`# footgun: ok <reason>` in YAML and shell). The reason is the point — a
suppression without one still suppresses, but the run lists it as unaudited, so
`git grep 'footgun: ok'` stays a document rather than noise.

The privacy rule ships structural checks only. A committed list of real names
would itself be the leak, so personal terms are read at run time from
`scripts/.footgun-terms.local` (gitignored) or from `$FOOTGUN_TERMS_FILE`.

## Project Layout

- `packages/jinn` -- Core gateway daemon and CLI (package dir).
- `packages/web` -- Web dashboard frontend.

## Questions?

Open an issue on GitHub if you have questions or run into problems.
