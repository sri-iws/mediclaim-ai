# MediClaim AI

A React/Vite claims dashboard with a Node/Express API and SQLite-backed persistent storage.

## Run the app

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env` if you want to configure the SQLite file path or token secret.
3. Start the backend and frontend together with `npm run dev`.
4. Open the Vite URL printed in the terminal (normally `http://localhost:5173`). SQLite is created automatically on first startup; no database server is required.

### Run the APIs and database with Docker Compose

Install and start Docker Desktop, then from the repository root run `docker compose up --build -d`. Compose builds one API image with the Python analysis methods and Tesseract bundled directly alongside the Node backend. SQLite is stored in the `mediclaim-sqlite-data` volume. The frontend remains a local Vite development server; start it separately with `npm run dev` if desired. The API is at `http://localhost:3001` (health check: `/api/health`).

Use `docker compose logs -f api` to follow service logs and `docker compose down` to stop the stack. SQLite data persists in the `mediclaim-sqlite-data` volume; `docker compose down -v` also deletes that data. Set `NODE_ENV=production` and a strong unique `JWT_SECRET` for production. The Compose file's default environment is for local development; production should use a private volume and regular backups.

### Python document-analysis service

The Python AI implementation lives under `ai-service/`. The Node backend invokes its runner directly as a local method through a Python subprocess; it does not make an HTTP request to a separate AI service. For local development, install the Python requirements and Tesseract OCR, then set `PYTHON_BIN` if the Python environment is not discoverable. See [ai-service/README.md](ai-service/README.md) for setup and tests. Analysis is review assistance only and never makes an automated claim decision.

The API invokes `analyze_document` and `procedure_results` through `ai-service/app/runner.py`. Keep the `ai-service/` source folder available beside the backend when deploying; the Docker images include it with Python dependencies and Tesseract. `PYTHON_BIN` can point to a specific Python executable when needed.

The API listens on `http://localhost:3001`; Vite proxies `/api` requests to it. On first startup, the API creates or updates the SQLite schema and seeds demo accounts and sample policies. By default the local database is `server/data/mediclaim.sqlite`; set `SQLITE_DB_PATH` to choose another file. SQLite schema updates are applied automatically during startup.

### Migrate existing JSON data

To import existing JSON records into SQLite, run `npm run db:import-json`. The import is safe to rerun: records with existing IDs, emails, or policy numbers are left unchanged. Set `MEDICLAIM_JSON_IMPORT_PATH` and `SQLITE_DB_PATH` if the source or destination is stored elsewhere. This command imports JSON data; it does not migrate records directly from a PostgreSQL server.

For production, set `NODE_ENV=production`, configure a strong unique `JWT_SECRET`, and set `SQLITE_DB_PATH` to durable storage writable by the Node process. Keep the SQLite file on local persistent disk and run one API instance; SQLite is not intended for multiple API replicas sharing a network-mounted database. Back up the database file and its WAL state using a consistent backup procedure.

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

Claims, policies, and users are stored in SQLite. Sample policy and demo account data are seeded locally; no external insurer, policy, or identity provider was specified, so these services are not connected to live third-party systems.

## Configuration

Copy `.env.example` to `.env` to configure `PORT`, `JWT_SECRET`, and `SQLITE_DB_PATH`. In production, set a unique strong `JWT_SECRET`, use HTTPS, store the SQLite file on persistent private storage, and establish tested backups before storing real health or identity data. The bundled demo credentials are for local development only.

## Checks

- `npm run build` — production frontend build
- `npm run lint` — ESLint
- `npm test` — UI and backend API test suites
- `npm start` — start the backend (set `NODE_ENV=production` and `JWT_SECRET` for production)
- `npm run server` — backend only
- `npm run dev` — backend and frontend together
