# MediClaim AI Testing Checklist

Date: 2026-09-27
Environment: Local Vite frontend, Node API, FastAPI AI service

## Automated Checks

- [x] JavaScript/Vitest: 31 tests passed.
- [x] ESLint: passed.
- [x] Production frontend build: passed.
- [x] Python/FastAPI tests: 28 passed, 1 skipped.
- [x] Node API health and AI service health: passed.
- [x] Authenticated procedure lookup proxy: passed.
- [x] Automated coverage for authentication, authorization, policies, claims, reviews, escalation, reconciliation, deletion, dashboard metrics, document proxy, OCR extraction, and code verification: passed.
- [x] Regression test confirms built-in demo administrator credentials stop authenticating after demo-account cleanup.

## Manual Browser Checks

Browser URL: http://localhost:5173

Manual test recording: `C:\Users\Sri\Desktop\mediclaim-ai-manual-testing.mp4` (27.93 seconds)

- [x] Landing page renders at desktop viewport.
- [x] Login and Register navigation controls are present.
- [x] Empty login submission displays an authentication error.
- [x] Malformed/incorrect credentials are rejected with a user-facing error.
- [x] Valid reviewer login redirects to `/dashboard`.
- [x] Dashboard navigation controls render and route to New claim, Claim verification, and Procedure results.
- [x] Empty claim submission is rejected with a validation message.
- [x] Claim form rejects a negative amount and reset clears unusual input values.
- [x] Claim verification loads a submitted claim and displays code-specific findings.
- [x] Procedure lookup accepts mixed valid/malformed codes and returns verified results while ignoring malformed input.
- [x] Desktop, tablet, and mobile viewport checks reported no horizontal overflow.
- [x] Manual test video recorded and saved to the Windows Desktop.
- [x] Valid claim creation with a supported image upload; browser OCR fallback completed and the claim was submitted, reviewed, and deleted after testing.
- [x] Unsupported and oversized document API handling returned HTTP 415 and 413 respectively.
- [ ] Claim search/status filters, policy-management/search/detail controls, and user-directory controls are not present in the current dashboard UI; corresponding API behavior is covered by automated tests.
- [x] Reviewer UI approve, reject, escalate, and reopen flows passed; reconciliation is covered by API tests but has no visible dashboard control.
- [x] Admin, reviewer, and auditor login/navigation controls checked. The unauthorized New claim CTA was hidden and direct-route access redirects; audit found the auditor still sees a Delete action that the API denies (HTTP 403).
- [x] Logout and protected-route behavior after logout.
- [x] UI snapshots inspected during the exercised flows; only expected HTTP 409 duplicate-registration and HTTP 503 OCR-unavailable responses appeared in the browser console.

## Notes

- Current run: 31 JavaScript tests passed; ESLint and production build passed; Python tests passed (28 passed, 1 skipped).
- Node API and FastAPI health endpoints both returned HTTP 200. Live mixed CPT/ICD lookup verified `99213` and `E11.9`.
- Live document analysis is blocked by missing Tesseract: `/api/analyze` returns HTTP 503 with `OCR is unavailable; verify the Tesseract installation.` The frontend fell back to browser OCR; the uploaded test image yielded no extracted fields, so manually entered values were used.
- Direct FastAPI upload checks returned HTTP 415 for an unsupported extension and HTTP 413 for a file exceeding 15 MiB.
- A temporary QA claim exercised escalation → rejection → reopen → approval, then was deleted. No test account was created; duplicate registration was rejected as expected.
- Python tests emit a Starlette `TestClient`/`httpx` deprecation warning and include one skipped test.
- Fixed the auditor dashboard's unauthorized `+ New claim` CTA in `src/pages/DashboardPage.jsx`; verified the CTA is now absent and the protected route redirects.
- Follow-up code audit findings, including production demo credentials, shared claim access, amount validation, and upload retention, are documented in `TEST_REPORT.md`.
- Production startup now removes the fixed built-in demo accounts and the frontend hides their credentials outside development; the production runtime/database branch still requires deployment-level verification.