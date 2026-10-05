"""Direct entry point: reads one JSON request from stdin, writes one JSON result to stdout."""
from __future__ import annotations

import asyncio
import base64
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.claim_analysis import analyze_claim  # noqa: E402
from app.services.document_scanner import extract_document_text  # noqa: E402
from app.services.procedure_results import calculate_procedure_results  # noqa: E402


class ServiceError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def analyze_document(payload: dict) -> dict:
    filename = Path(payload.get("filename") or "").name
    content = base64.b64decode(payload.get("content") or "")
    amount = payload.get("amount")
    if amount is not None and float(amount) < 0:
        raise ServiceError(422, "Claim amount must be non-negative.")

    try:
        text = extract_document_text(filename, content)
    except ValueError as error:
        raise ServiceError(415, str(error)) from error
    except RuntimeError as error:
        raise ServiceError(503, "OCR is unavailable; verify the Tesseract installation.") from error

    analysis = analyze_claim(
        text,
        claimant=payload.get("claimant"),
        policy_number=payload.get("policy_number"),
        provider=payload.get("provider"),
        diagnosis=payload.get("diagnosis"),
        amount=float(amount) if amount is not None else None,
    )
    fields = analysis["extracted_fields"]
    return {
        "filename": filename,
        "extracted_text": text,
        "extracted_fields": fields,
        "form_fields": {
            "claimant": fields["claimant"],
            "policyNumber": fields["policy_number"],
            "provider": fields["provider"],
            "amount": fields["amount"],
            "diagnosis": fields["diagnosis"],
        },
        "analysis": analysis,
    }


def procedure_results(payload: dict) -> dict:
    try:
        return asyncio.run(calculate_procedure_results(str(payload.get("codes") or "")))
    except ValueError as error:
        raise ServiceError(422, str(error)) from error


COMMANDS = {"analyze": analyze_document, "procedure-results": procedure_results}


def main() -> None:
    request = json.load(sys.stdin)
    try:
        handler = COMMANDS[request["command"]]
        result = {"ok": True, "data": handler(request.get("payload") or {})}
    except ServiceError as error:
        result = {"ok": False, "status": error.status, "message": error.message}
    sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
    main()
