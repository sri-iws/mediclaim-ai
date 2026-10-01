from __future__ import annotations

import re
from typing import Any

POLICY_PATTERN = re.compile(r"\bPOL[-\s][A-Z0-9][A-Z0-9-]{2,}\b", re.IGNORECASE)
DATE_PATTERN = re.compile(r"\b(?:\d{1,2}[/-]){2}\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b")
CLAIMANT_LABEL = re.compile(
    r"^(?:patient(?:['’]s)?|claimant|member|insured|policyholder|subscriber(?!\s+(?:id|number)\b)|customer|beneficiary|covered\s+(?:person|member)|"
    r"name\s+of\s+(?:patient|claimant|member))(?:\s+full)?(?:\s+name)?\s*(?:[:#=]\s*|[-–—]\s*|$)(.*)$",
    re.IGNORECASE,
)
PROVIDER_LABEL = re.compile(
    r"^(?:billing\s+provider|rendering\s+provider|servicing\s+provider|service\s+provider|performing\s+provider|"
    r"healthcare\s+provider|medical\s+provider|treating\s+provider|attending\s+physician|treating\s+physician|"
    r"pay[- ]to\s+provider|provider\s*/\s*facility|billing\s+entity|billing\s+organization|billed\s+by|"
    r"payee|vendor|supplier|name\s+of\s+(?:provider|facility)|physician|doctor|hospital|clinic|medical\s+center|facility|provider)"
    r"(?:\s+name)?\s*(?:[:#=]\s*|[-–—]\s*|$)(.*)$",
    re.IGNORECASE,
)
POLICY_LABEL = re.compile(
    r"^(?:account(?:\s+(?:no\.?|number))?\s*(?:#+\s*[:\-]?|[:\-])|"
    r"(?:policy(?:\s+(?:no\.?|number))?|member\s+(?:id|number)|insurance\s+(?:id|number)|"
    r"subscriber\s+(?:id|number)|health\s+plan\s+(?:id|number))\s*[:#-])\s*",
    re.IGNORECASE,
)
DATE_OF_SERVICE_LABEL = re.compile(r"\bDATE\s+OF\s+SERVICE\b\s*[:#-]?\s*", re.IGNORECASE)
INSURANCE_SECTION_LABEL = re.compile(r"^INSURANCE\b", re.IGNORECASE)
DIAGNOSIS_LABEL = re.compile(
    r"^(?:diagnosis\s*(?:[/&]|\band\b)\s*treatment|treatment\s*(?:[/&]|\band\b)\s*diagnosis|"
    r"diagnosis\s+(?:summary|details|description)|treatment\s+(?:summary|details|provided)|medical\s+necessity|"
    r"medical\s+(?:condition|diagnosis)|clinical\s+impression|chief\s+complaint|presenting\s+complaint|"
    r"primary\s+diagnosis|nature\s+of\s+illness|condition\s+treated|service\s+description|"
    r"description\s+of\s+(?:services?|treatment)|services?\s+rendered|procedure\s+performed|"
    r"diagnosis|treatment|procedure|assessment|reason\s+for\s+(?:visit|treatment|admission))\s*(?:[:#=]\s*|[-–—]\s*|\s+|$)(.*)$",
    re.IGNORECASE,
)
AMOUNT_LABEL = re.compile(
    r"^(?:total(?:\s+(?:amount|claim|bill|charges?))?|grand\s+total|invoice\s+total|"
    r"amount(?:\s+(?:claimed|due|billed|payable))?|claim(?:ed)?\s+amount|bill\s+amount|"
    r"balance\s+due|net\s+payable)\s*[:#-]?\s*",
    re.IGNORECASE,
)
AMOUNT_VALUE = re.compile(r"(?:USD\s*|[$₹€£]\s*)?([\d,]+(?:\.\d{1,2})?)", re.IGNORECASE)
CODE_PRICE_AMOUNT = re.compile(r"(?:USD\s*|[$₹€£]\s*)([\d,]+(?:\.\d{1,2})?)", re.IGNORECASE)
CPT_LABELED_CODE = re.compile(r"\bCPT(?:\s+code)?\s*[:#-]?\s*(\d{5}|\d{4}[FTU])\b", re.IGNORECASE)
CPT_BRACKETED_CODE = re.compile(r"[({]\s*(\d{5}|\d{4}[FTU])\s*[)}]", re.IGNORECASE)
LABELED_AMOUNT = re.compile(
    r"\b(?:claim(?:ed)?\s+amount|total(?:\s+(?:amount|claim|bill|charges?))?|"
    r"grand\s+total|invoice\s+total|amount\s+(?:claimed|due|billed|payable)|bill\s+amount|"
    r"balance\s+due|net\s+payable)\s*[:#-]?\s*"
    r"(?:USD\s*|[$₹€£]\s*)?([\d,]+(?:\.\d{1,2})?)",
    re.IGNORECASE,
)
DIAGNOSIS_CODE_PATTERN = re.compile(
    r"(?:ICD(?:\s*[- ]?\s*10(?:\s*[- ]?\s*CM)?)?(?:\s+code)?|diagnosis\s+code)"
    r"\s*[:#-]?\s*([A-Z0-9.-]{3,16})",
    re.IGNORECASE,
)
PROCEDURE_CODE_PATTERN = re.compile(
    r"(CPT|HCPCS|procedure\s+code)(?:\s+code)?\s*[:#-]?\s*([A-Z0-9]{1,6})",
    re.IGNORECASE,
)
DIAGNOSIS_CODE_FORMAT = re.compile(r"^[A-Z]\d[A-Z0-9](?:\.?[A-Z0-9]{1,4})?$", re.IGNORECASE)
PROCEDURE_CODE_FORMAT = re.compile(r"^(?:\d{5}|[A-Z]\d{4})$", re.IGNORECASE)
BARE_FIVE_DIGIT_CODE = re.compile(r"(?<![\d()])(\d{5})(?![\d()])")


def _normalize(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.casefold())


def _normalize_five_digit_codes(value: str) -> str:
    return BARE_FIVE_DIGIT_CODE.sub(r"(\1)", value)


def _field_from_lines(lines: list[str], label: re.Pattern[str]) -> str:
    for index, line in enumerate(lines):
        match = label.match(line)
        if match:
            value = match.group(1).strip() if match.lastindex else label.sub("", line, count=1).strip()
            if value:
                return value
            if index + 1 < len(lines) and not any(
                candidate.match(lines[index + 1])
                for candidate in (CLAIMANT_LABEL, PROVIDER_LABEL, POLICY_LABEL, DIAGNOSIS_LABEL, AMOUNT_LABEL)
            ):
                return lines[index + 1].strip()
    return ""


def _extract_procedure_amounts(lines: list[str]) -> list[dict[str, str | float]]:
    """Pair a CPT code with a nearby currency amount on the same OCR line."""
    procedure_amounts: list[dict[str, str | float]] = []
    seen: set[tuple[str, float]] = set()
    for line in lines:
        code_matches = [*CPT_LABELED_CODE.finditer(line), *CPT_BRACKETED_CODE.finditer(line)]
        for code_match in code_matches:
            code = code_match.group(1).upper()
            before = line[max(0, code_match.start() - 32):code_match.start()]
            after = line[code_match.end():code_match.end() + 32]
            price_matches = [
                (len(before) - match.end(), match)
                for match in CODE_PRICE_AMOUNT.finditer(before)
            ] + [
                (match.start(), match)
                for match in CODE_PRICE_AMOUNT.finditer(after)
            ]
            if not price_matches:
                continue
            _distance, price_match = min(price_matches, key=lambda candidate: candidate[0])
            amount = float(price_match.group(1).replace(",", ""))
            key = (code, amount)
            if key not in seen:
                seen.add(key)
                procedure_amounts.append({"code": code, "amount": amount})
    return procedure_amounts


def _section_between_headings(lines: list[str], start: re.Pattern[str], end: re.Pattern[str]) -> str:
    section: list[str] = []
    in_section = False
    for line in lines:
        if not in_section:
            match = start.search(line)
            if not match:
                continue
            in_section = True
            remainder = line[match.end():].strip()
            if remainder and not re.search(r"\btablets?\b", remainder, re.IGNORECASE):
                section.append(remainder)
            continue
        if end.search(line):
            break
        if not re.search(r"\btablets?\b", line, re.IGNORECASE):
            section.append(line)
    return " ".join(section).strip()


def extract_fields(text: str) -> dict[str, Any]:
    """Extract common claim details and code checks from OCR text."""
    missing_field = "N/A"
    lines = [" ".join(line.split()) for line in text.splitlines() if line.strip()]
    claimant = _field_from_lines(lines, CLAIMANT_LABEL)
    provider = _field_from_lines(lines, PROVIDER_LABEL)
    policy_number = _field_from_lines(lines, POLICY_LABEL)
    diagnosis = _field_from_lines(lines, DIAGNOSIS_LABEL) or _section_between_headings(
        lines, DATE_OF_SERVICE_LABEL, INSURANCE_SECTION_LABEL
    )
    diagnosis = _normalize_five_digit_codes(diagnosis)

    amount_line = next((line for line in lines if AMOUNT_LABEL.search(line)), "")
    amount_match = AMOUNT_VALUE.search(AMOUNT_LABEL.sub("", amount_line, count=1)) if amount_line else None
    amount = amount_match.group(1).replace(",", "") if amount_match else ""
    diagnosis_code_matches = [match for line in lines for match in DIAGNOSIS_CODE_PATTERN.finditer(line)]
    procedure_code_matches = [match for line in lines for match in PROCEDURE_CODE_PATTERN.finditer(line)]
    diagnosis_codes = list(dict.fromkeys(match.group(1).upper() for match in diagnosis_code_matches))
    procedure_codes = list(dict.fromkeys(match.group(2).upper() for match in procedure_code_matches))
    cpt_codes = list(dict.fromkeys(
        match.group(2).upper() for match in procedure_code_matches if match.group(1).upper() == "CPT"
    ))
    hcpcs_codes = list(dict.fromkeys(
        match.group(2).upper() for match in procedure_code_matches if match.group(1).upper() == "HCPCS"
    ))
    diagnosis_code_value = diagnosis_codes[0] if diagnosis_codes else ""
    procedure_code_value = procedure_codes[0] if procedure_codes else ""
    diagnosis_code = diagnosis_code_value or missing_field
    procedure_code = procedure_code_value or missing_field
    procedure_system_label = procedure_code_matches[0].group(1).upper() if procedure_code_matches else ""

    diagnosis_check = (
        {
            "system": "ICD-10-CM",
            "value": diagnosis_code_value,
            "format_valid": bool(DIAGNOSIS_CODE_FORMAT.fullmatch(diagnosis_code_value)),
        }
        if diagnosis_code_value
        else None
    )
    procedure_check = (
        {
            "system": "HCPCS"
            if procedure_system_label == "HCPCS"
            or (procedure_system_label == "PROCEDURE CODE" and procedure_code_value[:1].isalpha())
            else "CPT",
            "value": procedure_code_value,
            "format_valid": bool(PROCEDURE_CODE_FORMAT.fullmatch(procedure_code_value)),
        }
        if procedure_code_value
        else None
    )

    policy_numbers = list(dict.fromkeys(
        value.upper().replace(" ", "")
        for value in (policy_number, *POLICY_PATTERN.findall(text))
        if value
    ))
    amounts = [float(value.replace(",", "")) for value in LABELED_AMOUNT.findall(text)]
    if amount and float(amount) not in amounts:
        amounts.insert(0, float(amount))
    procedure_amounts = _extract_procedure_amounts(lines)

    return {
        "claimant": claimant or missing_field,
        "provider": provider or missing_field,
        "policy_number": policy_number or missing_field,
        "diagnosis": diagnosis or missing_field,
        "amount": amount or missing_field,
        "diagnosis_code": diagnosis_code,
        "diagnosis_codes": diagnosis_codes,
        "procedure_code": procedure_code,
        "procedure_codes": procedure_codes,
        "cpt_codes": cpt_codes,
        "hcpcs_codes": hcpcs_codes,
        "code_checks": {"diagnosis": diagnosis_check, "procedure": procedure_check},
        "policy_numbers": policy_numbers,
        "dates": list(dict.fromkeys(DATE_PATTERN.findall(text))),
        "amounts": list(dict.fromkeys(amounts)),
        "procedure_amounts": procedure_amounts,
    }


def analyze_claim(
    text: str,
    *,
    claimant: str | None = None,
    policy_number: str | None = None,
    provider: str | None = None,
    diagnosis: str | None = None,
    amount: float | None = None,
) -> dict[str, Any]:
    """Return explainable review signals; this does not approve or deny claims."""
    fields = extract_fields(text)
    findings: list[dict[str, str]] = []
    normalized_text = _normalize(text)

    if not text.strip():
        findings.append({
            "code": "no_text_extracted",
            "severity": "warning",
            "field": "document",
            "message": "No readable text was extracted; verify the document manually.",
        })

    for field, value in (
        ("claimant", claimant),
        ("policy_number", policy_number),
        ("provider", provider),
        ("diagnosis", diagnosis),
    ):
        if value and _normalize(value) not in normalized_text:
            findings.append({
                "code": "claim_value_not_found",
                "severity": "review",
                "field": field,
                "message": f"The submitted {field.replace('_', ' ')} was not found in the document text.",
            })

    if policy_number and fields["policy_numbers"]:
        expected_policy = _normalize(policy_number)
        if not any(_normalize(value) == expected_policy for value in fields["policy_numbers"]):
            findings.append({
                "code": "policy_number_mismatch",
                "severity": "review",
                "field": "policy_number",
                "message": "The policy number found in the document differs from the submitted policy number.",
            })

    if amount is not None and fields["amounts"]:
        if not any(abs(document_amount - amount) <= 0.01 for document_amount in fields["amounts"]):
            findings.append({
                "code": "amount_mismatch",
                "severity": "review",
                "field": "amount",
                "message": "The submitted amount does not match any labeled amount found in the document.",
            })
    elif amount is not None:
        findings.append({
            "code": "amount_not_found",
            "severity": "info",
            "field": "amount",
            "message": "No labeled claim amount was extracted; the amount needs manual verification.",
        })

    for code_type, code_check in fields["code_checks"].items():
        if code_check and not code_check["format_valid"]:
            findings.append({
                "code": f"{code_type}_code_format_unexpected",
                "severity": "review",
                "field": f"{code_type}_code",
                "message": f"The extracted {code_check['system']} code has an unexpected format; verify it against an authoritative code set.",
            })

    return {
        "extracted_fields": fields,
        "recommendation": "manual_review",
        "automated_decision": None,
        "findings": findings,
        "disclaimer": "Analysis is assistive only. A qualified reviewer must make the claim decision.",
    }
