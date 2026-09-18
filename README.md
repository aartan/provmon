# ProvMon

Multi-retailer product price & stock monitoring platform. Paste a product
URL, configure your conditions, and get email notifications when a product
comes back in stock or drops to your target price.

## Stack

- **Frontend/backend**: Next.js 16 (App Router), TypeScript
- **UI**: Tailwind CSS v4, shadcn/ui (radix-nova preset)
- **Database**: PostgreSQL via Prisma ORM 7 (driver adapter)
- **Background jobs**: Redis + BullMQ
- **Email**: Resend (dev delivery via Mailpit)
- **Validation**: Zod v4
- **Auth**: Auth.js v5 (credentials, JWT sessions, bcrypt)
- **Tests**: Vitest

## Architecture

Retailer integrations are isolated behind a common adapter interface in
`src/modules/retailers`. The monitoring engine, scheduler, and notification
rules only ever see normalised product data — adding a retailer means adding
an adapter module and registering it, with no changes to core code.

Domain modules live in `src/modules/` and are free of Next.js imports so they
can be tested in isolation. The web app is a thin layer in `src/app`.

## Getting started

### 1. Infrastructure

A `docker-compose.yml` provides PostgreSQL, Redis, and Mailpit (local email
testing at <http://localhost:8025>).

```bash
docker compose up -d          # Docker
podman-compose up -d          # Podman (no Docker required)
```

If port 5432 is already taken on your machine, set `POSTGRES_PORT=5433` in
`.env` before starting the stack.

### 2. Environment

```bash
cp .env.example .env
# set AUTH_SECRET: openssl rand -base64 32
```

### 3. Database

```bash
npm install        # runs `prisma generate` via postinstall
npm run db:migrate # applies migrations (creates tables)
```

### 4. Run

```bash
npm run dev        # web app on http://localhost:3000
```

## Scripts

| Command              | Purpose                          |
| -------------------- | -------------------------------- |
| `npm run dev`        | Dev server (Next.js)             |
| `npm run build`      | Production build                 |
| `npm run lint`       | ESLint                           |
| `npm test`           | Vitest (single run)              |
| `npm run test:watch` | Vitest (watch mode)              |
| `npm run db:migrate` | Create/apply Prisma migrations   |
| `npm run db:generate`| Regenerate the Prisma client     |
