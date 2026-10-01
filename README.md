# MediClaim AI

A React/Vite claims dashboard with a Node/Express API and PostgreSQL-backed persistent storage.

## Run the app

1. Install dependencies with `npm install`.
2. Start PostgreSQL with Docker Compose: `docker compose up -d db`.
3. Copy `.env.example` to `.env` (the default connection string matches the Compose database).
4. Start the backend and frontend together with `npm run dev`.
5. Open the Vite URL printed in the terminal (normally `http://localhost:5173`).

### Run the APIs and database with Docker Compose

Install and start Docker Desktop, then from the repository root run `docker compose up --build -d`. Compose builds the Node API and Python AI service and starts them with PostgreSQL. The API waits for the database and AI service health checks before starting. The frontend remains a local Vite development server; start it separately with `npm run dev` if desired. The API is at `http://localhost:3001` (health check: `/api/health`), the AI service at `http://localhost:8000`, and PostgreSQL at `localhost:5432`.

Use `docker compose logs -f api ai-service db` to follow service logs and `docker compose down` to stop the stack. PostgreSQL data persists in the `mediclaim-postgres-data` volume; `docker compose down -v` also deletes that data. For deployment, set a strong unique `JWT_SECRET` in the environment instead of using the local-development default.

### Python document-analysis service

An independent FastAPI OCR and claim-review support service is available under `ai-service/`. Start it with `docker compose up -d ai-service`; it listens on `http://localhost:8000`. The create-claim form sends documents through the authenticated Node API, which proxies them to the Python service and fills detected claimant, policy, provider, amount, and diagnosis fields. See [ai-service/README.md](ai-service/README.md) for setup, request fields, and tests. Analysis is review assistance only and never makes an automated claim decision.

The API listens on `http://localhost:3001`; Vite proxies `/api` requests to it. On first startup, the API creates the PostgreSQL schema and seeds demo accounts and sample policies. PostgreSQL data is persisted in the `mediclaim-postgres-data` Docker volume.

### Migrate existing JSON data

After PostgreSQL is running and `.env` is configured, import the existing `server/data/mediclaim.json` data with `npm run db:migrate`. The import is safe to rerun: records with existing IDs or emails are left unchanged. Set `MEDICLAIM_JSON_IMPORT_PATH` in `.env` if the JSON source is stored elsewhere.

For a hosted PostgreSQL service, set `DATABASE_URL` to its connection string and set `DATABASE_SSL=true` if required by the provider. The bundled Compose credentials are for local development only; choose strong credentials and restrict network access outside development.

### Local development demo accounts

Demo accounts are seeded only when `NODE_ENV` is not `production`; startup removes the built-in demo accounts from the database in production. The frontend displays these credentials only in Vite development mode. Provision production administrator and staff accounts through a secure, out-of-band process.

- Admin: `admin@mediclaim.ai` / `admin123`
- Reviewer: `reviewer@mediclaim.ai` / `reviewer123`
- Auditor: `auditor@mediclaim.ai` / `auditor123`

New self-registered accounts receive the reviewer role. Passwords are stored as salted scrypt hashes. API sessions use signed bearer tokens.

## API services

All data endpoints require `Authorization: Bearer <token>` from the login or registration response.

| Method | Endpoint | Access | Description |
| --- | --- | --- | --- |
| `POST` | `/api/auth/login` | Public | Authenticate and return a token and user profile |
| `POST` | `/api/auth/register` | Public | Create a reviewer account |
| `GET` | `/api/users/me` | Signed in | Retrieve the current user profile |
| `GET` | `/api/users` | Admin | Retrieve the user directory (password hashes are never returned) |
| `GET` | `/api/claims` | Signed in | Retrieve claims; supports `status` and `q` filters |
| `GET` | `/api/claims/:claimId` | Signed in | Retrieve one claim |
| `POST` | `/api/claims` | Signed in | Validate and persist a claim submission |
| `PATCH` | `/api/claims/:claimId/review` | Reviewer or admin | Save approve, reject, or escalation decision and audit history |
| `GET` | `/api/policies` | Signed in | Retrieve policies; supports a `q` search query |
| `GET` | `/api/policies/:policyNumber` | Signed in | Retrieve one policy |
| `GET` | `/api/dashboard/metrics` | Signed in | Retrieve claim counts and evidence metrics |
| `GET` | `/api/health` | Public | Check API availability |

Claims, policies, and users are stored in PostgreSQL. Sample policy and demo account data are seeded locally; no external insurer, policy, or identity provider was specified, so these services are not connected to live third-party systems.

## Configuration

Copy `.env.example` to `.env` to configure `PORT`, `JWT_SECRET`, `DATABASE_URL`, and `DATABASE_SSL`. In production, set a unique strong `JWT_SECRET`, use HTTPS, and use a managed PostgreSQL database with backups and restricted access before storing real health or identity data. The bundled demo credentials are for local development only.

## Checks

- `npm run build` — production frontend build
- `npm run lint` — ESLint
- `npm test` — UI and backend API test suites
- `npm run server` — backend only (requires PostgreSQL)
- `npm run dev` — backend and frontend together (requires PostgreSQL)
