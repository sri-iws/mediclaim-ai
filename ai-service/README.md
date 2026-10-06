# MediClaim AI service

A standalone FastAPI service for extracting text from medical claim documents, producing transparent human-review signals, and checking supported diagnosis/procedure codes. The authenticated Node API proxies requests to this service.

## Layout

- `app/api/` — HTTP routes and upload validation
- `app/services/document_scanner.py` — PDF text extraction and Tesseract OCR
- `app/services/claim_analysis.py` — extracted-field checks and explainable findings
- `app/services/procedure_results.py` — live NLM Clinical Tables checks for ICD-10-CM and HCPCS Level II, plus an optional licensed CPT CSV
- `tests/` — unit tests for analysis behavior

## Run locally

Use Python 3.10 or newer. Install Tesseract OCR separately and ensure `tesseract` is on `PATH`; on Windows install the Tesseract executable and English language data. From the repository root in PowerShell:

```powershell
Set-Location .\mediclaim-ai\ai-service
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements-dev.txt
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

If PowerShell blocks activation, run the environment's executable directly instead: `.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000`. Use `requirements.txt` rather than `requirements-dev.txt` for a runtime-only local install.

The service is also available through the root Compose configuration at `http://localhost:8000` after starting the `ai-service` service. The frontend uploads through the authenticated Node API, which forwards files here. `GET /health` checks availability. Interactive API documentation is at `/docs`.

## Standalone Docker and CI/CD

From the repository root, build and run the standalone image with:

```powershell
docker build -t mediclaim-ai-service:local .\mediclaim-ai\ai-service
docker run --rm --name mediclaim-ai-service -p 8000:8000 mediclaim-ai-service:local
```

Check `http://localhost:8000/health` and open `http://localhost:8000/docs` for the interactive API. To stop the container, press Ctrl+C in the run terminal. The image honors the platform-provided `PORT`, includes Tesseract OCR and English language data, runs as a non-root user, and has a `/health` Docker health check. It builds from the `ai-service/` directory alone; optional reference data must be mounted or provided by the deployment. `MEDICAL_CODES_REFERENCE_XLSX` can point to a mounted workbook for historical/example fallbacks; without one, unavailable or unconfigured references are reported as gaps rather than causing startup or lookup failures.

To run the application API and AI service together instead, run `docker compose up --build -d` from the repository root. The AI service is reachable on port 8000 and the Node API on port 3001. Run `docker compose logs -f ai-service` to inspect startup and `docker compose down` to stop the stack.

The repository GitHub Actions workflow runs the AI-service tests and builds the production Docker image on pull requests that touch the service. After tests pass, pushes to `main` publish `ghcr.io/<owner>/<repository>/ai-service:main` and `:latest`; tags named `ai-service-v*` publish a matching version tag. Images also receive a commit-SHA tag. Deployment platforms should pull the desired immutable SHA or version tag; configure package visibility/access in GitHub Container Registry for the deployment environment. The workflow requires no registry password because it publishes using the repository-scoped `GITHUB_TOKEN`.

## Analyze a document

`POST /api/analyze` accepts `multipart/form-data` with required `file` and optional `claimant`, `policy_number`, `provider`, `diagnosis`, and numeric `amount` fields. It extracts readable text from PDF and common image files using embedded text/OCR, and from DOCX, XLSX/XLSM, CSV/TSV, TXT/Markdown, JSON, XML, HTML, and RTF documents. Claimant, provider, policy number, diagnosis/treatment, and amount labels are mapped to the matching claim intake fields; ICD-10-CM diagnosis codes, CPT/HCPCS procedure codes, dates, and code-format checks are also returned where detectable. The response includes `extracted_fields`, a camelCase `form_fields` mapping for the claim form, and `analysis.findings`. Uploads are limited to 15 MiB by default (`MAX_UPLOAD_BYTES`); PDFs are limited to 25 pages.

Example request fields:

- `file`: document (`.pdf`, `.png`, `.jpg`, `.jpeg`, `.tif`, `.tiff`, `.webp`, `.bmp`, `.docx`, `.xlsx`, `.xlsm`, `.csv`, `.tsv`, `.txt`, `.md`, `.json`, `.xml`, `.html`, `.htm`, or `.rtf`)
- `policy_number`, `provider`, `diagnosis`, `amount`: values to compare with the extracted text

The initial analysis is deliberately rules-based and returns `recommendation: manual_review` with no automated claim decision. It is not a substitute for policy validation or a qualified reviewer. OCR output and heuristic findings can be incomplete or incorrect.

## CPT procedure-code results

`POST /api/procedure-results` accepts JSON with a `codes` string (up to 5,000 characters), and processes plain, comma-separated, parenthesized, or brace-wrapped CPT, HCPCS Level II, and ICD-10-CM values; for example `99213, A0428, E11.9`. It checks up to 10 unique codes. ICD-10-CM diagnosis and HCPCS Level II procedure codes are looked up online against the U.S. National Library of Medicine (NLM) Clinical Tables APIs (`https://clinicaltables.nlm.nih.gov/api/icd10cm/v3/search` and `https://clinicaltables.nlm.nih.gov/api/hcpcs/v3/search`) using an exact returned-code match. The response includes descriptions, the reference source, API availability, and verified/ignored counts. The API does not expose a dataset release version, so results say that the dataset is live and its release is not exposed.

CPT is a licensed code set and is not included in the public NLM code APIs. CPT codes are checked first against an authorized, versioned CSV configured using `CPT_REFERENCE_CSV` and `CPT_REFERENCE_VERSION`; the CSV must contain `code` and `description` columns. Price-to-range verification uses a separate CSV configured by `CPT_PRICING_REFERENCE_CSV`, `CPT_PRICING_REFERENCE_SOURCE`, and `CPT_PRICING_REFERENCE_VERSION`; it must contain `code`, `reference_min`, `reference_max`, and `currency` columns. The administrator must explicitly set `CPT_PRICING_REFERENCE_AUTHORIZED=true` only after verifying the source license and applicability. With Compose, authorized files can be mounted from `licensed-reference/`. Do not commit or redistribute CPT data unless its license permits it. If no authorized pricing source is configured, the service can show active CPT ranges from `public/medical_codes.xlsx` only as historical examples. These are tagged `historical_example`, include source and version provenance, and cannot support an approval recommendation. If the ICD-10-CM API is unavailable or returns no exact match, or neither NLM nor a licensed CPT CSV can verify a CPT code, the service checks the corresponding code sheet in the workbook. HCPCS is checked against the NLM API; the workbook has no HCPCS reference sheet. Workbook code matches are returned with `verification_status: verified_fallback` and an overall `reference_status` of `fallback` (or a partial status when other codes remain unresolved). If no exact workbook match is found either, the response sets `reference_status: reference_gap` (or `partial_reference_gap`) and lists the unresolved code for reviewer escalation. Set `MEDICAL_CODES_REFERENCE_XLSX` to override the workbook location. CPT-to-diagnosis relationships are not inferred. Code membership and example price comparisons do not establish medical necessity, coverage, reimbursement, or clinical appropriateness; a qualified coding professional must review results.

## Tests

Install `requirements-dev.txt`, then run `pytest` from this directory.

## Privacy and deployment

Files are processed in memory and are not persisted by this service. Do not expose the service publicly as-is: it has no authentication, authorization, rate limiting, or audit integration. In production, route calls through the authenticated Node API and apply the organization's health-data security, retention, and access-control requirements. Avoid logging document contents or sending real claimant data to unapproved external models.
