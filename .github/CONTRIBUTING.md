# Contributing to Jinn

Thanks for your interest in contributing. This guide covers the basics.

Read [AGENTS.md](../AGENTS.md) before opening a pull request. It is the review rubric this
repository is judged against -- how to verify a ticket's premise, which extension point to
reach for, what makes a test worth keeping, and what a plan has to show.

## Prerequisites

- Node.js **24.13.0**, pinned by `.nvmrc` (`package.json` requires `>=24 <25`). Native modules
  such as `better-sqlite3` are ABI-locked, so a different major will fail to load.
- pnpm 10.6+
- At least one engine CLI, e.g. [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
  (`npm install -g @anthropic-ai/claude-code`)

## Development Setup

1. Fork and clone the repository.
2. Install dependencies:
   ```bash
   pnpm install
   ```
3. Initialize Jinn (one-time - builds all packages and creates the instance home at `~/.jinn`):
   ```bash
   pnpm setup
   ```
   This is safe to re-run; it skips files that already exist.
4. Start development mode:
   ```bash
   pnpm dev
   ```
   This runs the gateway (port from your instance `config.yaml`, 7777 by default) alongside the
   Vite dev server for the web dashboard.
5. Open [http://localhost:5173](http://localhost:5173). Vite proxies `/api` and `/ws` through to
   the gateway; set `GATEWAY_PORT` if yours does not run on 7777.

## Submitting Pull Requests

- Create a feature branch from `main`.
- Keep commits focused and descriptive.
- Run all four gates before submitting. Each one is a required CI job, so a failure here is a
  failure there:
  ```bash
  pnpm typecheck
  pnpm lint
  pnpm test
  pnpm build
  ```
  `pnpm test` also runs on Windows in CI; if you touch filesystem paths or process spawning,
  expect that leg to have an opinion.
- Open a pull request against `main` with a clear description of your changes.

## Code Style

- TypeScript with strict mode enabled.
- ESM modules (no CommonJS).
- Tailwind CSS for styling in the web package.
- Follow existing patterns in the codebase.

## Project Layout

- `packages/jinn` -- Core gateway daemon and CLI (package dir).
- `packages/web` -- Web dashboard frontend.
- `packages/gateway-events` -- Shared event contract between the gateway and the dashboard.

## Questions?

Open an issue on GitHub if you have questions or run into problems.
