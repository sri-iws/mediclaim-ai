from app.services.claim_analysis import analyze_claim, extract_fields


def test_extract_fields_from_document_text() -> None:
    fields = extract_fields("Policy POL-1108\nClaim Amount: USD 1,234.50\nDate: 2026-09-27")

    assert fields["policy_numbers"] == ["POL-1108"]
    assert fields["amounts"] == [1234.5]
    assert "2026-09-27" in fields["dates"]


def test_uses_na_for_missing_scalar_fields() -> None:
    fields = extract_fields("Unrelated document text")

    assert fields["claimant"] == "N/A"
    assert fields["policy_number"] == "N/A"
    assert fields["provider"] == "N/A"
    assert fields["amount"] == "N/A"
    assert fields["diagnosis"] == "N/A"
    assert fields["diagnosis_code"] == "N/A"
    assert fields["procedure_code"] == "N/A"
    assert fields["code_checks"] == {"diagnosis": None, "procedure": None}


def test_extracts_all_claim_fields_and_code_checks() -> None:
    fields = extract_fields(
        """Patient Name: Alex Morgan
Provider: Northside Clinic
Policy Number: POL-1108
Diagnosis: Acute bronchitis
Claim Amount: $1,234.50
ICD-10 Code: J20.9
CPT Code: 99213
Date: 2026-09-27"""
    )

    assert fields["claimant"] == "Alex Morgan"
    assert fields["provider"] == "Northside Clinic"
    assert fields["policy_number"] == "POL-1108"
    assert fields["diagnosis"] == "Acute bronchitis"
    assert fields["amount"] == "1234.50"
    assert fields["diagnosis_code"] == "J20.9"
    assert fields["procedure_code"] == "99213"
    assert fields["code_checks"]["diagnosis"] == {
        "system": "ICD-10-CM",
        "value": "J20.9",
        "format_valid": True,
    }
    assert fields["code_checks"]["procedure"] == {
        "system": "CPT",
        "value": "99213",
        "format_valid": True,
    }
    assert fields["dates"] == ["2026-09-27"]
    assert fields["amounts"] == [1234.5]


def test_extracts_currency_amount_adjacent_to_a_bracketed_cpt_code() -> None:
    fields = extract_fields("Line item: CPT (99213) $125.00")

    assert fields["procedure_amounts"] == [{"code": "99213", "amount": 125.0}]


def test_extracts_multiple_diagnosis_and_procedure_codes_from_document() -> None:
    fields = extract_fields(
        """ICD-10-CM code: J20.9
Secondary diagnosis code: E11.9
CPT code: 99213
HCPCS code: A0428"""
    )

    assert fields["diagnosis_codes"] == ["J20.9", "E11.9"]
    assert fields["diagnosis_code"] == "J20.9"
    assert fields["procedure_codes"] == ["99213", "A0428"]
    assert fields["cpt_codes"] == ["99213"]
    assert fields["hcpcs_codes"] == ["A0428"]
    assert fields["procedure_code"] == "99213"


def test_maps_patient_provider_name_and_total_labels_to_claim_fields() -> None:
    fields = extract_fields(
        """Patient: Alex Morgan
Provider Name: Northside Clinic
Total: USD 1,234.50"""
    )

    assert fields["claimant"] == "Alex Morgan"
    assert fields["provider"] == "Northside Clinic"
    assert fields["amount"] == "1234.50"
    assert fields["amounts"] == [1234.5]


def test_maps_common_document_aliases_to_claim_intake_fields() -> None:
    fields = extract_fields(
        """Subscriber Full Name: Jamie Rivera
Subscriber ID: SUB-00421
Billing Provider: Central Medical Center
Medical Necessity: Follow-up care for a wrist fracture
Invoice Total: $875.00"""
    )

    assert fields["claimant"] == "Jamie Rivera"
    assert fields["policy_number"] == "SUB-00421"
    assert fields["provider"] == "Central Medical Center"
    assert fields["diagnosis"] == "Follow-up care for a wrist fracture"
    assert fields["amount"] == "875.00"


def test_maps_account_number_and_date_of_service_section() -> None:
    fields = extract_fields(
        """Patient: Alex Morgan
Account ##: AC-88421
DATE OF SERVICE
2026-09-27 - Office consultation and wound dressing
Follow-up instructions provided
INSURANCE
Plan: Example Health"""
    )

    assert fields["policy_number"] == "AC-88421"
    assert fields["diagnosis"] == (
        "2026-09-27 - Office consultation and wound dressing Follow-up instructions provided"
    )


def test_ignores_tablet_lines_in_date_of_service_section() -> None:
    fields = extract_fields(
        """DATE OF SERVICE
Consultation for migraine
Prescribed ExampleMed 10 mg tablets
Rest and hydration recommended
INSURANCE
Plan: Example Health"""
    )

    assert fields["diagnosis"] == "Consultation for migraine Rest and hydration recommended"


def test_parenthesizes_five_digit_codes_in_diagnosis_summary() -> None:
    fields = extract_fields("Diagnosis: Office visit 99213 and follow-up (99214)")

    assert fields["diagnosis"] == "Office visit (99213) and follow-up (99214)"


def test_extracts_provider_and_diagnosis_treatment_from_common_document_labels() -> None:
    fields = extract_fields(
        """Attending Physician: Dr. Jamie Lee
Diagnosis / Treatment: Sprained ankle; compression wrap and follow-up"""
    )

    assert fields["provider"] == "Dr. Jamie Lee"
    assert fields["diagnosis"] == "Sprained ankle; compression wrap and follow-up"


def test_extracts_claimant_provider_and_treatment_from_bill_label_variants() -> None:
    fields = extract_fields(
        """Beneficiary Full Name = Alex Morgan
Rendering Provider - Northside Medical Center
Description of Services: Emergency evaluation and wound repair"""
    )

    assert fields["claimant"] == "Alex Morgan"
    assert fields["provider"] == "Northside Medical Center"
    assert fields["diagnosis"] == "Emergency evaluation and wound repair"


def test_reads_values_after_standalone_bill_field_labels() -> None:
    fields = extract_fields(
        """Patient's Name
Alex Morgan
Facility Name
Northside Clinic
Chief Complaint
Persistent cough and shortness of breath
Invoice Total: $425.00"""
    )

    assert fields["claimant"] == "Alex Morgan"
    assert fields["provider"] == "Northside Clinic"
    assert fields["diagnosis"] == "Persistent cough and shortness of breath"


def test_maps_provider_role_and_payee_aliases_without_capturing_identifiers() -> None:
    cases = {
        "Servicing Provider: Northside Clinic": "Northside Clinic",
        "Billed By: Central Medical Center": "Central Medical Center",
        "Vendor Name: Example Health Services": "Example Health Services",
    }
    for document_line, expected_provider in cases.items():
        assert extract_fields(document_line)["provider"] == expected_provider

    for identifier_line in (
        "Billing Provider Tax ID: 12-3456789",
        "Provider NPI: 1234567890",
        "Facility Charges: $425.00",
    ):
        assert extract_fields(identifier_line)["provider"] == "N/A"

    subscriber = extract_fields("Subscriber ID: SUB-00421")
    assert subscriber["claimant"] == "N/A"
    assert subscriber["policy_number"] == "SUB-00421"


def test_analysis_includes_extracted_fields_and_flags_unexpected_code_format() -> None:
    result = analyze_claim("Diagnosis code: invalid-code")

    assert result["extracted_fields"]["diagnosis_code"] == "INVALID-CODE"
    assert result["findings"][0]["code"] == "diagnosis_code_format_unexpected"


def test_analysis_flags_claim_values_not_found_and_never_decides() -> None:
    result = analyze_claim(
        "Policy POL-1108. Claim Amount: $200.00",
        policy_number="POL-1108",
        provider="Northside Clinic",
        amount=250.0,
    )

    assert result["recommendation"] == "manual_review"
    assert result["automated_decision"] is None
    assert {finding["code"] for finding in result["findings"]} == {"claim_value_not_found", "amount_mismatch"}


def test_analysis_reports_empty_document_text() -> None:
    result = analyze_claim("")

    assert result["recommendation"] == "manual_review"
    assert result["findings"][0]["code"] == "no_text_extracted"
