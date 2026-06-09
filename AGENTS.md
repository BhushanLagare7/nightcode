# AGENTS.md

## Project Overview

Nightcode is an AI-powered Terminal UI (TUI) client and robust backend for next-generation developer tooling. It is built as a monorepo using Bun workspaces.

### Architecture
- **Monorepo**: Clean separation of concerns with four packages (`packages/cli`, `packages/server`, `packages/database`, `packages/shared`).
- **CLI (`@nightcode/cli`)**: Rich Terminal UI built with React, React Router, and `@opentui/core`. Interacts with various AI models via the Vercel AI SDK.
- **Server (`@nightcode/server`)**: A fast REST API backend powered by Hono and Bun. Handles chat streams, auth (Clerk), and billing (Polar.sh).
- **Database (`@nightcode/database`)**: PostgreSQL persistence using Prisma ORM.
- **Shared (`@nightcode/shared`)**: Shared Zod schemas and TypeScript types.

## Setup Commands

- **Install dependencies**: `bun install`
- **Database Setup**: `cd packages/database && bun run db:generate` (Requires a running PostgreSQL database and configured `.env`)
- **Environment**: Copy `.env.example` to `.env` and fill in necessary configuration (API Keys for Clerk, Polar.sh, OpenAI, Anthropic, Google).

## Development Workflow

- **Start backend server (with hot reload)**: `bun run dev:server`
- **Start CLI client (with watch mode)**: `bun run dev:cli`
- **Build CLI**: `bun run build:cli`
- **Link local CLI**: `bun run link:cli`

*Tip: You can use `bun run --filter <package_name> <command>` to run commands for specific workspace packages.*

## Code Style & Linting

- **Lint all files**: `bun run lint`
- **Auto-fix lint errors**: `bun run lint:fix`
- The project uses ESLint with `typescript-eslint` and `eslint-plugin-react`. See `eslint.config.mts` at the root for configuration details.

## Monorepo Considerations

- Always run `bun install` at the root to resolve workspace dependencies.
- Use the provided root-level `package.json` scripts (`dev:cli`, `dev:server`, `build:cli`, `link:cli`, `lint`) for standard workflows.
- Shared types and schemas from `@nightcode/shared` and the Prisma client from `@nightcode/database` are heavily utilized across both the CLI and Server. Make sure to run `db:generate` if the schema changes.

## Pull Request Guidelines

- Ensure both the CLI and Server start successfully.
- Run `bun run lint` and verify there are no errors.
- Follow conventional commits if possible, but keep commit messages concise.
