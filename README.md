<div align="center">
  <h1>Nightcode</h1>
  <p>An AI-powered Terminal UI (TUI) client and robust backend for next-generation developer tooling.</p>
</div>

Nightcode is a modern, full-stack application built for the terminal. It provides a rich React-based CLI interface to interact with various AI models (OpenAI, Anthropic, Google) powered by a fast Hono backend running on Bun.

## Features

- **Rich Terminal UI**: Built with React, React Router, and `@opentui/core` for an interactive command-line experience.
- **Multi-Model AI**: Seamless integration with the Vercel AI SDK to support Claude, Gemini, and ChatGPT.
- **High-Performance Backend**: A blazing fast REST API powered by Hono and Bun.
- **Authentication & Billing**: Integrated with Clerk for secure auth and Polar.sh for billing.
- **Type-Safe Database**: PostgreSQL persistence using Prisma ORM.
- **Monorepo Architecture**: Clean separation of concerns with `@nightcode/cli`, `@nightcode/server`, `@nightcode/database`, and `@nightcode/shared`.

## Prerequisites

- [Bun](https://bun.sh/) (v1.0 or later)
- PostgreSQL database
- API Keys for Clerk, Polar.sh, and your preferred AI providers (e.g., OpenAI, Anthropic, Google)

## Getting Started

> [!NOTE]
> Nightcode relies on several environment variables. Make sure to copy `.env.example` to `.env` and fill in your configuration before starting.

1. **Install dependencies**

   ```bash
   bun install
   ```

2. **Generate Database Client**

   ```bash
   cd packages/database && bun run db:generate
   ```

3. **Start the Development Servers**

   You can run the CLI and the Server in separate terminals using the root scripts:

   **Start the server:**
   ```bash
   bun run dev:server
   ```

   **Start the CLI client:**
   ```bash
   bun run dev:cli
   ```

## Architecture

Nightcode is structured as a Bun workspace with the following packages:

- `packages/cli`: The interactive Terminal UI (React + OpenTUI).
- `packages/server`: The Hono API backend handling chat streams, auth, billing, and session management.
- `packages/database`: Prisma schema and database client exports.
- `packages/shared`: Shared Zod schemas and TypeScript types.
