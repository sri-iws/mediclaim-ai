from __future__ import annotations

import os
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

from app.services.claim_analysis import analyze_claim
from app.services.procedure_results import calculate_procedure_results
from app.services.document_scanner import extract_document_text

router = APIRouter(prefix="/api", tags=["AI analysis"])
MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_BYTES", str(15 * 1024 * 1024)))


class ProcedureResultsRequest(BaseModel):
    codes: str = Field(min_length=1, max_length=5000)


@router.post("/analyze")
async def analyze_document(
    file: UploadFile = File(...),
    claimant: str | None = Form(default=None),
    policy_number: str | None = Form(default=None),
    provider: str | None = Form(default=None),
    diagnosis: str | None = Form(default=None),
    amount: float | None = Form(default=None),
) -> dict:
    filename = Path(file.filename or "").name
    content = await file.read(MAX_UPLOAD_BYTES + 1)
    await file.close()
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="The uploaded document exceeds the size limit.")
    if amount is not None and amount < 0:
        raise HTTPException(status_code=422, detail="Claim amount must be non-negative.")

    try:
        text = extract_document_text(filename, content)
    except ValueError as error:
        raise HTTPException(status_code=415, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail="OCR is unavailable; verify the Tesseract installation.") from error

    analysis = analyze_claim(
        text,
        claimant=claimant,
        policy_number=policy_number,
        provider=provider,
        diagnosis=diagnosis,
        amount=amount,
    )
    return {
        "filename": filename,
        "extracted_text": text,
        "extracted_fields": analysis["extracted_fields"],
        "form_fields": {
            "claimant": analysis["extracted_fields"]["claimant"],
            "policyNumber": analysis["extracted_fields"]["policy_number"],
            "provider": analysis["extracted_fields"]["provider"],
            "amount": analysis["extracted_fields"]["amount"],
            "diagnosis": analysis["extracted_fields"]["diagnosis"],
        },
        "analysis": analysis,
    }


@router.post("/procedure-results")
async def calculate_procedures(request: ProcedureResultsRequest) -> dict:
    try:
        return await calculate_procedure_results(request.codes)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
