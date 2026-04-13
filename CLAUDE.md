# Salon-Bot — Project Overview

Multi-tenant SaaS salon management platform. Two completely separate deployments that work together.

## Two Parts

| Part | Folder | Deploy | Purpose |
|------|--------|--------|---------|
| Backend | `src/` | Railway | Express API, SQLite DB, WhatsApp/Instagram/Facebook webhooks, Gemini voice, chat bot |
| Frontend | `frontend/` | Vercel | Next.js admin dashboard UI |

## How They Connect

The frontend never calls Railway directly. Next.js rewrites in `next.config.ts` proxy all API calls server-side:

**frontend has now been moved to**   `D:\vs self code\frontend`
```
Browser → Vercel (Next.js) → [rewrite proxy] → Railway (Express :3000)
```

This keeps cookies same-origin and avoids CORS entirely.

**The only env var needed to wire them together:**
```
BACKEND_URL=https://your-app.railway.app   ← set on Vercel
```

## Key Env Vars

### Railway (src/)
```
TENANT_JWT_SECRET=        # 32-byte hex, REQUIRED — server exits without it
GEMINI_API_KEY=           # for chat bot + voice calls
META_VERIFY_TOKEN=        # legacy webhook verify token
DB_PATH=                  # default: ./salon.db
SUPER_DB_PATH=            # default: ./super.db
SALON_DATA_KEY=           # key for /salon-data.json endpoint (default: adminkey123)
NO_SHOW_GRACE_MIN=        # minutes after appointment before auto-no-show (default: 30)
PORT=                     # default: 3000
```

### Vercel (frontend/)
```
BACKEND_URL=              # Railway URL, used in next.config.ts rewrites
```

## Databases

Two SQLite files on Railway:
- `salon.db` — all tenant data (bookings, services, staff, etc.) in prefixed tables
- `super.db` — super admin accounts + tenant registry

## Detailed Docs

- Backend routes, DB schema, auth: `src/CLAUDE.md`
- Frontend pages, API calls, deploy: `frontend/CLAUDE.md`

## graphify

This project has a graphify knowledge graph at `d:/vs self code/salon-bot/graphify-out/`.

The frontend also has a separate graphify knowledge graph at `d:/vs self code/frontend/graphify-out/`.

Rules:
- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If the task requires making changes to the frontend, read `d:/vs self code/frontend/graphify-out/GRAPH_REPORT.md` before touching frontend files
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- After modifying code files in this session, run `python3 -c "from graphify.watch import _rebuild_code; from pathlib import Path; _rebuild_code(Path('.'))"` to keep the graph current
