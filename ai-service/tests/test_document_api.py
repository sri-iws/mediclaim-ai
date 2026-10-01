from fastapi.testclient import TestClient

from app.api import routes
from app.main import app


def test_analyze_endpoint_scans_document_and_returns_claim_fields(monkeypatch) -> None:
    document_text = """Patient Name: Alex Morgan
Provider: Northside Clinic
Policy Number: POL-1108
Diagnosis: Acute bronchitis
Claim Amount: $1,234.50
ICD-10 Code: J20.9
CPT Code: 99213
Date: 2026-09-27"""
    monkeypatch.setattr(routes, "extract_document_text", lambda _filename, _content: document_text)

    with TestClient(app) as client:
        response = client.post(
            "/api/analyze",
            files={"file": ("claim.pdf", b"test document", "application/pdf")},
            data={
                "claimant": "Alex Morgan",
                "provider": "Northside Clinic",
                "policy_number": "POL-1108",
                "diagnosis": "Acute bronchitis",
                "amount": "1234.50",
            },
        )

    assert response.status_code == 200
    result = response.json()
    assert result["extracted_fields"]["claimant"] == "Alex Morgan"
    assert result["extracted_fields"]["provider"] == "Northside Clinic"
    assert result["extracted_fields"]["policy_number"] == "POL-1108"
    assert result["extracted_fields"]["diagnosis"] == "Acute bronchitis"
    assert result["extracted_fields"]["amount"] == "1234.50"
    assert result["extracted_fields"]["diagnosis_code"] == "J20.9"
    assert result["extracted_fields"]["procedure_code"] == "99213"
    assert result["extracted_fields"]["dates"] == ["2026-09-27"]
    assert result["form_fields"] == {
        "claimant": "Alex Morgan",
        "policyNumber": "POL-1108",
        "provider": "Northside Clinic",
        "amount": "1234.50",
        "diagnosis": "Acute bronchitis",
    }
    assert result["analysis"]["recommendation"] == "manual_review"
    assert result["analysis"]["automated_decision"] is None


def test_procedure_results_endpoint_accepts_plain_cpt_codes(monkeypatch) -> None:
    async def fake_calculate(codes: str) -> dict:
        assert codes == "CPT 99213"
        return {
            "procedures": [{"system": "CPT", "code": "99213", "description": "Office visit", "is_valid_code": True}],
            "ignored_codes": [],
            "engine": "licensed_cpt_reference",
            "reference": "Licensed CPT reference",
            "reference_version": "2026-release",
            "reference_status": "verified",
            "verified_count": 1,
            "ignored_count": 0,
            "disclaimer": "Reference verification only.",
        }

    monkeypatch.setattr(routes, "calculate_procedure_results", fake_calculate)
    with TestClient(app) as client:
        response = client.post(
            "/api/procedure-results",
            json={"codes": "CPT 99213"},
        )

    assert response.status_code == 200
    result = response.json()
    assert result["procedures"][0]["description"] == "Office visit"
    assert result["procedures"][0]["is_valid_code"] is True
    assert result["engine"] == "licensed_cpt_reference"
    assert result["procedures"][0]["system"] == "CPT"


def test_procedure_results_endpoint_rejects_blank_input() -> None:
    with TestClient(app) as client:
        response = client.post("/api/procedure-results", json={"codes": "   "})

    assert response.status_code == 422


def test_procedure_results_endpoint_accepts_icd10_codes() -> None:
    with TestClient(app) as client:
        response = client.post("/api/procedure-results", json={"codes": "ICD-10-CM E11.9"})

    assert response.status_code == 200
    assert response.json()["diagnoses"][0]["code"] == "E11.9"