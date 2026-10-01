import asyncio

import httpx
import pytest

from app.services import procedure_results


def test_requires_at_least_one_recognized_code() -> None:
    with pytest.raises(ValueError, match="Enter CPT, HCPCS Level II, or ICD-10-CM codes"):
        procedure_results._extract_cpt_codes("Office visit")


def test_extracts_and_deduplicates_procedure_codes() -> None:
    codes, ignored = procedure_results._extract_cpt_codes("CPT code (99213), follow-up (CPT 99214), repeat (99213)")

    assert codes == ["99213", "99214"]
    assert ignored == []


def test_extracts_cpt_shapes_hcpcs_and_diagnosis_codes() -> None:
    procedures, diagnoses, ignored = procedure_results._extract_codes(
        "CPT (0001F) (0123T) (0001U), HCPCS A0428 R0070, ICD-10-CM E11.9"
    )

    assert procedures == ["0001F", "0123T", "0001U", "A0428", "R0070"]
    assert diagnoses == ["E11.9"]
    assert ignored == []


def test_invalid_values_are_ignored_but_supported_codes_are_extracted() -> None:
    procedures, diagnoses, ignored = procedure_results._extract_codes(
        "diagnosis (E11.9), ambulance (A0428), unsupported (invalid)"
    )

    assert procedures == ["A0428"]
    assert diagnoses == ["E11.9"]
    assert [item["value"] for item in ignored] == ["invalid"]


def test_rejects_more_than_ten_codes() -> None:
    procedure_codes = " ".join(f"({index:05})" for index in range(11))

    with pytest.raises(ValueError, match="no more than 10 unique procedure and diagnosis codes"):
        procedure_results._extract_cpt_codes(procedure_codes)


def test_licensed_cpt_csv_validates_exact_code(monkeypatch, tmp_path) -> None:
    reference = tmp_path / "cpt-reference.csv"
    reference.write_text("code,description\n11111,Licensed procedure\n", encoding="utf-8")
    monkeypatch.setattr(procedure_results, "CPT_REFERENCE_CSV", str(reference))
    monkeypatch.setattr(procedure_results, "CPT_REFERENCE_VERSION", "2026-release")

    assert procedure_results._lookup_cpt_code("11111") == "Licensed procedure"
    assert procedure_results._lookup_cpt_code("11112") is None


def test_live_reference_verifies_exact_hcpcs_and_icd10_codes(monkeypatch) -> None:
    async def fake_lookup(code, system):
        entries = {
            ("A0428", "HCPCS Level II"): ("A0428", "Ambulance service"),
            ("E11.9", "ICD-10-CM"): ("E11.9", "Type 2 diabetes mellitus without complications"),
        }
        return entries.get((code, system))

    monkeypatch.setattr(procedure_results, "_query_reference_api", fake_lookup)
    result = asyncio.run(procedure_results.calculate_procedure_results("A0428, E11.9"))

    assert result["engine"] == "nlm_clinical_tables_api"
    assert result["api_status"] == "available"
    assert result["verified_count"] == 2
    assert result["procedures"][0]["reference"] == "NLM Clinical Tables HCPCS API"
    assert result["diagnoses"][0]["description"].startswith("Type 2 diabetes")
    assert result["code_relationships"] == []


def test_api_failure_falls_back_to_exact_workbook_diagnosis(monkeypatch) -> None:
    async def unavailable(*_args):
        raise httpx.ConnectError("offline")

    monkeypatch.setattr(procedure_results, "_query_reference_api", unavailable)
    monkeypatch.setattr(
        procedure_results,
        "_lookup_workbook_code",
        lambda code, system: {
            "ICD-10 Code": "E11.9",
            "Diagnosis Description": "Type 2 diabetes example",
        } if (code, system) == ("E11.9", "ICD-10-CM") else None,
    )

    result = asyncio.run(procedure_results.calculate_procedure_results("E11.9"))

    assert result["api_status"] == "unavailable"
    assert result["reference_status"] == "fallback"
    assert result["fallback_count"] == 1
    assert result["diagnoses"][0]["verification_status"] == "verified_fallback"
    assert result["diagnoses"][0]["reference"] == "medical_codes.xlsx (fallback; historical/example data)"
    assert result["diagnoses"][0]["description"] == "Type 2 diabetes example"
    assert result["ignored_codes"] == []


def test_api_failure_finds_real_codes_in_medical_codes_workbook(monkeypatch) -> None:
    async def unavailable(*_args):
        raise httpx.ConnectError("offline")

    monkeypatch.setattr(procedure_results, "_query_reference_api", unavailable)

    result = asyncio.run(procedure_results.calculate_procedure_results("87426, J09.X2"))

    assert result["api_status"] == "unavailable"
    assert result["reference_status"] == "fallback"
    assert result["fallback_count"] == 2
    assert result["procedures"][0]["description"] == "COVID-19 antigen test"
    assert result["diagnoses"][0]["description"] == "Influenza due to identified novel influenza A virus"
    assert all(item["verification_status"] == "verified_fallback" for item in result["procedures"] + result["diagnoses"])


def test_api_no_match_checks_workbook_before_verifying_diagnosis(monkeypatch) -> None:
    async def no_api_match(*_args):
        return None

    monkeypatch.setattr(procedure_results, "_query_reference_api", no_api_match)
    monkeypatch.setattr(
        procedure_results,
        "_lookup_workbook_code",
        lambda code, system: {
            "ICD-10 Code": "J09.X2",
            "Diagnosis Description": "Influenza example",
        } if (code, system) == ("J09.X2", "ICD-10-CM") else None,
    )

    result = asyncio.run(procedure_results.calculate_procedure_results("J09.X2"))

    assert result["api_status"] == "available"
    assert result["reference_status"] == "fallback"
    assert result["workbook_checked_count"] == 1
    assert result["diagnoses"][0]["verification_status"] == "verified_fallback"
    assert result["diagnoses"][0]["description"] == "Influenza example"


def test_cpt_uses_workbook_as_fallback_when_public_api_does_not_cover_it(monkeypatch) -> None:
    monkeypatch.setattr(procedure_results, "CPT_REFERENCE_CSV", "")
    monkeypatch.setattr(procedure_results, "CPT_REFERENCE_VERSION", "unspecified")
    monkeypatch.setattr(
        procedure_results,
        "_lookup_workbook_code",
        lambda code, system: {"Description": "Office visit example"} if (code, system) == ("99213", "CPT") else None,
    )

    result = asyncio.run(procedure_results.calculate_procedure_results("99213"))

    assert result["api_status"] == "not_used"
    assert result["reference_status"] == "fallback"
    assert result["fallback_count"] == 1
    assert result["procedures"][0]["verification_status"] == "verified_fallback"
    assert result["procedures"][0]["description"] == "Office visit example"
    assert result["procedures"][0]["reference_version"] == "2024 example data"


def test_cpt_is_unverified_without_a_licensed_reference(monkeypatch) -> None:
    monkeypatch.setattr(procedure_results, "CPT_REFERENCE_CSV", "")
    monkeypatch.setattr(procedure_results, "CPT_REFERENCE_VERSION", "unspecified")
    monkeypatch.setattr(procedure_results, "_lookup_workbook_code", lambda *_args: None)

    result = asyncio.run(procedure_results.calculate_procedure_results("99213"))

    assert result["procedures"] == []
    assert result["verified_count"] == 0
    assert result["ignored_codes"][0]["system"] == "CPT"
    assert "not included in the public NLM API" in result["ignored_codes"][0]["reason"]
    assert result["api_status"] == "not_used"


def test_licensed_cpt_csv_can_verify_cpt_without_workbook_data(monkeypatch, tmp_path) -> None:
    reference = tmp_path / "cpt-reference.csv"
    reference.write_text("code,description\n99213,Office or other outpatient visit\n", encoding="utf-8")
    monkeypatch.setattr(procedure_results, "CPT_REFERENCE_CSV", str(reference))
    monkeypatch.setattr(procedure_results, "CPT_REFERENCE_VERSION", "2026-release")
    monkeypatch.setattr(procedure_results, "_query_reference_api", lambda *_args: pytest.fail("CPT must not use NLM API"))

    result = asyncio.run(procedure_results.calculate_procedure_results("99213"))

    assert result["procedures"][0]["reference"] == "Licensed CPT reference CSV"
    assert result["procedures"][0]["reference_version"] == "2026-release"
    assert result["verified_count"] == 1


def test_api_failure_is_reported_as_unavailable(monkeypatch) -> None:
    async def unavailable(*_args):
        raise httpx.ConnectError("offline")

    monkeypatch.setattr(procedure_results, "_query_reference_api", unavailable)
    monkeypatch.setattr(procedure_results, "_lookup_workbook_code", lambda *_args: None)
    result = asyncio.run(procedure_results.calculate_procedure_results("E11.9"))

    assert result["reference_status"] == "reference_gap"
    assert result["api_status"] == "unavailable"
    assert result["verified_count"] == 0
    assert "temporarily unavailable" in result["ignored_codes"][0]["reason"]


def test_unmatched_code_sets_reference_gap_after_api_and_workbook_checks(monkeypatch) -> None:
    async def no_exact_match(*_args):
        return None

    monkeypatch.setattr(procedure_results, "_query_reference_api", no_exact_match)
    workbook_lookups = []

    def no_workbook_match(code, system):
        workbook_lookups.append((code, system))
        return None

    monkeypatch.setattr(procedure_results, "_lookup_workbook_code", no_workbook_match)
    result = asyncio.run(procedure_results.calculate_procedure_results("Z99.9"))

    assert result["api_status"] == "available"
    assert result["reference_status"] == "reference_gap"
    assert result["workbook_checked_count"] == 1
    assert workbook_lookups == [("Z99.9", "ICD-10-CM")]
    assert result["ignored_codes"][0]["value"] == "Z99.9"
    assert "either" in result["ignored_codes"][0]["reason"]
    assert "medical_codes.xlsx" in result["message"]


def test_empty_input_requires_a_supported_code() -> None:
    with pytest.raises(ValueError, match="Enter CPT, HCPCS Level II, or ICD-10-CM codes"):
        asyncio.run(procedure_results.calculate_procedure_results("   "))
