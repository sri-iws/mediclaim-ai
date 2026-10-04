from __future__ import annotations
import asyncio
import csv
import math
import os
import re
from functools import lru_cache
from pathlib import Path
from zipfile import BadZipFile

import httpx
from openpyxl import load_workbook
from openpyxl.utils.exceptions import InvalidFileException


DISCLAIMER = (
    "ICD-10-CM diagnosis and HCPCS Level II procedure codes are checked against the live U.S. National Library of Medicine (NLM) Clinical Tables API; if unavailable, exact matches may fall back to historical/example entries in medical_codes.xlsx. "
    "CPT is a licensed code set and is not available from that public API; CPT membership is checked against an authorized, versioned CPT CSV when configured, otherwise only historical/example workbook matches may be shown as fallback. "
    "Workbook fallback data is not authoritative current coding guidance. An unavailable online source or no match is not evidence that a code is invalid. Code membership does not establish medical necessity, coverage, reimbursement, or clinical appropriateness. "
    "Confirm coding and pricing with authoritative current sources and a qualified reviewer."
)
CPT_CODE_PATTERN = re.compile(r"^(?:\d{5}|\d{4}[FTU])$", re.IGNORECASE)
HCPCS_CODE_PATTERN = re.compile(r"^[A-HJ-NPRSTV]\d{4}$", re.IGNORECASE)
ICD10_CODE_PATTERN = re.compile(r"^[A-Z]\d{2}(?:\.[A-Z0-9]{1,4})?$", re.IGNORECASE)
CODE_SEARCH_PATTERN = re.compile(
    r"(?<![A-Z0-9])(?:\d{5}|\d{4}[FTU]|[A-HJ-NPRSTV]\d{4}|[A-Z]\d{2}(?:\.[A-Z0-9]{1,4})?)(?![A-Z0-9])",
    re.IGNORECASE,
)
CPT_REFERENCE_CSV = os.getenv("CPT_REFERENCE_CSV", "").strip()
CPT_REFERENCE_VERSION = os.getenv("CPT_REFERENCE_VERSION", "unspecified").strip()
CPT_PRICING_REFERENCE_CSV = os.getenv("CPT_PRICING_REFERENCE_CSV", "").strip()
CPT_PRICING_REFERENCE_SOURCE = os.getenv("CPT_PRICING_REFERENCE_SOURCE", "").strip()
CPT_PRICING_REFERENCE_VERSION = os.getenv("CPT_PRICING_REFERENCE_VERSION", "unspecified").strip()
CPT_PRICING_REFERENCE_AUTHORIZED = os.getenv("CPT_PRICING_REFERENCE_AUTHORIZED", "false").strip().lower() == "true"
NLM_ICD10_API = "https://clinicaltables.nlm.nih.gov/api/icd10cm/v3/search"
NLM_HCPCS_API = "https://clinicaltables.nlm.nih.gov/api/hcpcs/v3/search"
NLM_API_TIMEOUT_SECONDS = 8.0
_configured_medical_codes_xlsx = os.getenv("MEDICAL_CODES_REFERENCE_XLSX", "").strip()
MEDICAL_CODES_REFERENCE_XLSX = Path(_configured_medical_codes_xlsx) if _configured_medical_codes_xlsx else next(
    (
        candidate
        for candidate in (
            Path(__file__).resolve().parents[3] / "public" / "medical_codes.xlsx",
            Path(__file__).resolve().parents[2] / "public" / "medical_codes.xlsx",
        )
        if candidate.is_file()
    ),
    Path(__file__).resolve().parents[3] / "public" / "medical_codes.xlsx",
)


def _has_cpt_reference() -> bool:
    return bool(CPT_REFERENCE_CSV and CPT_REFERENCE_VERSION and CPT_REFERENCE_VERSION.lower() != "unspecified")


def _has_cpt_pricing_reference() -> bool:
    return bool(
        CPT_PRICING_REFERENCE_CSV
        and CPT_PRICING_REFERENCE_SOURCE
        and CPT_PRICING_REFERENCE_VERSION
        and CPT_PRICING_REFERENCE_VERSION.lower() != "unspecified"
        and CPT_PRICING_REFERENCE_AUTHORIZED
    )


def _extract_codes(code_text: str) -> tuple[list[str], list[str], list[dict[str, str]]]:
    procedure_codes: list[str] = []
    icd10_codes: list[str] = []
    ignored: list[dict[str, str]] = []

    def add_code(value: str) -> bool:
        normalized = value.strip().upper()
        if CPT_CODE_PATTERN.fullmatch(normalized) or HCPCS_CODE_PATTERN.fullmatch(normalized):
            if normalized not in procedure_codes:
                procedure_codes.append(normalized)
            return True
        if ICD10_CODE_PATTERN.fullmatch(normalized):
            if normalized not in icd10_codes:
                icd10_codes.append(normalized)
            return True
        return False

    grouped_values = re.findall(r"\(([^()]*)\)|\{([^{}]*)\}", code_text)
    for parenthesized, braced in grouped_values:
        grouped_value = (parenthesized or braced).strip()
        value = re.sub(r"^CPT(?:\s+CODE)?\s*[:#-]?\s*", "", grouped_value, flags=re.IGNORECASE)
        value = re.sub(r"^ICD(?:\s*[- ]?\s*10(?:\s*[- ]?\s*CM)?)?(?:\s+CODE)?\s*[:#-]?\s*", "", value, flags=re.IGNORECASE)
        if not add_code(value):
            ignored.append({"value": grouped_value, "reason": "Not a supported CPT or ICD-10-CM code format; ignored."})

    for match in CODE_SEARCH_PATTERN.findall(code_text):
        add_code(match)

    if not procedure_codes and not icd10_codes and not ignored:
        raise ValueError("Enter CPT, HCPCS Level II, or ICD-10-CM codes directly, for example 99213 or E11.9.")
    if len(procedure_codes) + len(icd10_codes) > 10:
        raise ValueError("Enter no more than 10 unique procedure and diagnosis codes per verification request.")
    return procedure_codes, icd10_codes, ignored


def _extract_cpt_codes(code_text: str) -> tuple[list[str], list[dict[str, str]]]:
    """Keep the existing CPT-only parser interface for callers and tests."""
    cpt_codes, _icd10_codes, ignored = _extract_codes(code_text)
    return cpt_codes, ignored


def _lookup_cpt_code(code: str) -> str | None:
    """Read a CPT description only from an explicitly configured licensed CSV."""
    if not _has_cpt_reference():
        return None

    with Path(CPT_REFERENCE_CSV).open(encoding="utf-8-sig", newline="") as reference_file:
        reader = csv.DictReader(reference_file)
        if not reader.fieldnames or not {"code", "description"}.issubset(set(reader.fieldnames)):
            raise ValueError("The CPT reference CSV must have 'code' and 'description' columns.")
        for row in reader:
            if str(row.get("code", "")).strip().upper() == code.upper():
                return str(row.get("description", "")).strip() or None
    return None


def _lookup_cpt_price_range(code: str) -> dict | None:
    """Read an exact range from an explicitly authorized, versioned CPT pricing CSV."""
    if not _has_cpt_pricing_reference():
        return None

    with Path(CPT_PRICING_REFERENCE_CSV).open(encoding="utf-8-sig", newline="") as reference_file:
        reader = csv.DictReader(reference_file)
        required_columns = {"code", "reference_min", "reference_max", "currency"}
        if not reader.fieldnames or not required_columns.issubset(set(reader.fieldnames)):
            raise ValueError("The CPT pricing reference CSV must contain code, reference_min, reference_max, and currency columns.")
        matches = [row for row in reader if str(row.get("code", "")).strip().upper() == code.upper()]
    if not matches:
        return None
    if len(matches) != 1:
        raise ValueError(f"The CPT pricing reference contains duplicate rows for {code}.")

    row = matches[0]
    try:
        minimum = float(row["reference_min"])
        maximum = float(row["reference_max"])
    except (TypeError, ValueError) as error:
        raise ValueError(f"The CPT pricing reference contains an invalid range for {code}.") from error
    currency = str(row.get("currency", "")).strip().upper()
    if not math.isfinite(minimum) or not math.isfinite(maximum) or minimum < 0 or maximum < minimum:
        raise ValueError(f"The CPT pricing reference contains an invalid range for {code}.")
    if not re.fullmatch(r"[A-Z]{3}", currency):
        raise ValueError(f"The CPT pricing reference contains an invalid currency for {code}.")
    return {
        "reference_min": minimum,
        "reference_max": maximum,
        "currency": currency,
        "reference": CPT_PRICING_REFERENCE_SOURCE,
        "reference_version": CPT_PRICING_REFERENCE_VERSION,
        "reference_status": "verified_authoritative",
        "source_note": str(row.get("source_note") or "").strip(),
        "authoritative": True,
    }


@lru_cache(maxsize=4)
def _load_medical_codes_reference(reference_path: str) -> dict[str, dict[str, dict]]:
    """Load the supplemental example code descriptions used only as a fallback."""
    workbook = load_workbook(reference_path, read_only=True, data_only=True)
    try:
        cpt_rows = workbook["CPT Codes"].iter_rows(values_only=True)
        cpt_headers = [str(value).strip() for value in next(cpt_rows)]
        cpt: dict[str, dict] = {}
        for row in cpt_rows:
            item = dict(zip(cpt_headers, row, strict=False))
            code = str(item.get("CPT Code") or "").strip().upper()
            description = str(item.get("Description") or "").strip()
            if code and description:
                cpt[code] = item

        diagnosis_rows = workbook["Diagnosis Codes"].iter_rows(values_only=True)
        diagnosis_headers = [str(value).strip() for value in next(diagnosis_rows)]
        icd10: dict[str, dict] = {}
        for row in diagnosis_rows:
            item = dict(zip(diagnosis_headers, row, strict=False))
            code = str(item.get("ICD-10 Code") or "").strip().upper()
            description = str(item.get("Diagnosis Description") or "").strip()
            if code and description:
                icd10[code] = item
        return {"cpt": cpt, "icd10": icd10}
    finally:
        workbook.close()


def _medical_codes_reference() -> dict[str, dict[str, dict]]:
    return _load_medical_codes_reference(str(MEDICAL_CODES_REFERENCE_XLSX))


def _lookup_workbook_code(code: str, system: str) -> dict | None:
    """Find an exact code in the historical/example workbook fallback."""
    if system not in {"CPT", "ICD-10-CM"}:
        return None
    reference = _medical_codes_reference()
    key = "icd10" if system == "ICD-10-CM" else "cpt"
    return reference[key].get(code.upper())
    
def _workbook_cpt_price_range(item: dict) -> dict | None:
    """Return a validated, explicitly non-authoritative CPT example range."""
    if str(item.get("Status") or "").strip().lower() != "active":
        return None
    try:
        minimum = float(item.get("Min Cost"))
        maximum = float(item.get("Max Cost"))
    except (TypeError, ValueError):
        return None
    if not math.isfinite(minimum) or not math.isfinite(maximum) or minimum < 0 or maximum < minimum:
        return None
    return {
        "reference_min": minimum,
        "reference_max": maximum,
        "currency": "USD",
        "reference": "medical_codes.xlsx",
        "reference_version": "2024 example data",
        "reference_status": "historical_example",
        "source_note": str(item.get("First Found") or "Historical receipt example"),
        "authoritative": False,
    }


async def _query_reference_api(code: str, system: str) -> tuple[str, str] | None:
    """Return an exact code/description match from an NLM Clinical Tables API."""
    endpoint = NLM_ICD10_API if system == "ICD-10-CM" else NLM_HCPCS_API
    async with httpx.AsyncClient(timeout=NLM_API_TIMEOUT_SECONDS) as client:
        response = await client.get(
            endpoint,
            params={"terms": code, "sf": "code", "df": "code,name"},
        )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, list) or len(payload) < 4 or not isinstance(payload[3], list):
        raise ValueError("The reference API returned an unexpected response.")
    for row in payload[3]:
        if isinstance(row, list) and len(row) >= 2 and str(row[0]).strip().upper() == code.upper():
            return str(row[0]).strip().upper(), str(row[1] or "").strip()
    return None


def _amount(value: object) -> float | int | None:
    return value if isinstance(value, (int, float)) else None


async def calculate_procedure_results(code_text: str) -> dict:
    """Verify supported codes against live NLM APIs and configured licensed CPT data."""
    source_text = code_text.strip()
    if not source_text:
        raise ValueError("Enter CPT, HCPCS Level II, or ICD-10-CM codes directly, for example 99213 or E11.9.")
    procedure_codes, icd10_codes, ignored = _extract_codes(source_text)
    procedures = []
    diagnoses = []
    fallback_count = 0
    workbook_checked_count = 0
    attempted_api_count = 0
    api_failure_count = 0

    async def resolve_public(code: str, system: str):
        nonlocal attempted_api_count, api_failure_count, workbook_checked_count
        attempted_api_count += 1
        try:
            match = await _query_reference_api(code, system)
        except (httpx.HTTPError, ValueError, TypeError, IndexError):
            api_failure_count += 1
            item = None
            if system == "ICD-10-CM":
                workbook_checked_count += 1
                try:
                    item = await asyncio.to_thread(_lookup_workbook_code, code, system)
                except (OSError, ValueError, TypeError, KeyError, StopIteration, BadZipFile, InvalidFileException):
                    item = None
            if item:
                return (item, "workbook_fallback"), None
            if system == "ICD-10-CM":
                return None, "The NLM reference API is temporarily unavailable and no exact match was found in medical_codes.xlsx; code unverified."
            return None, "The NLM HCPCS API is temporarily unavailable; medical_codes.xlsx has no HCPCS reference sheet, so the code remains unverified."
        if match is None and system == "ICD-10-CM":
            workbook_checked_count += 1
            try:
                item = await asyncio.to_thread(_lookup_workbook_code, code, system)
            except (OSError, ValueError, TypeError, KeyError, StopIteration, BadZipFile, InvalidFileException):
                item = None
            if item:
                return (item, "workbook_fallback"), None
            return None, "No exact match was found in either the NLM ICD-10-CM API or medical_codes.xlsx; code unverified."
        if match is None:
            return None, "No exact code match was found in the NLM HCPCS Clinical Tables API; medical_codes.xlsx has no HCPCS reference sheet, so the code remains unverified."
        return match, None

    public_codes = [
        (code, "HCPCS Level II" if HCPCS_CODE_PATTERN.fullmatch(code) else "ICD-10-CM")
        for code in [*procedure_codes, *icd10_codes]
        if HCPCS_CODE_PATTERN.fullmatch(code) or ICD10_CODE_PATTERN.fullmatch(code)
    ]
    public_lookups = await asyncio.gather(*(resolve_public(code, system) for code, system in public_codes))
    public_matches = dict(zip(public_codes, public_lookups, strict=True))

    for code in procedure_codes:
        system = "HCPCS Level II" if HCPCS_CODE_PATTERN.fullmatch(code) else "CPT"
        if system == "HCPCS Level II":
            match, error = public_matches[(code, system)]
            if error:
                ignored.append({"value": code, "system": system, "reason": error})
                continue
            if match is None:
                ignored.append({"value": code, "system": system, "reason": "No exact code match was found in the NLM HCPCS Clinical Tables API; medical_codes.xlsx has no HCPCS reference sheet, so the code remains unverified."})
                continue
            if isinstance(match, tuple) and len(match) == 2 and match[1] == "workbook_fallback":
                fallback_count += 1
                item = match[0]
                procedures.append({
                    "system": system,
                    "code": code,
                    "description": str(item.get("Description") or "").strip(),
                    "is_valid_code": True,
                    "evidence": [code],
                    "explanation": f"The NLM API did not provide an exact match; medical_codes.xlsx contains an exact example entry for {code}.",
                    "verification_status": "verified_fallback",
                    "reference_version": "2024 example data",
                    "reference": "medical_codes.xlsx (fallback; historical/example data)",
                })
                continue
            _matched_code, description = match
            procedures.append({
                "system": system,
                "code": code,
                "description": description or "Description not provided by the NLM dataset.",
                "is_valid_code": True,
                "evidence": [code],
                "explanation": f"The NLM Clinical Tables HCPCS API returned an exact match for {code}.",
                "verification_status": "verified_api",
                "reference_version": "Live NLM dataset; release not exposed by API",
                "reference": "NLM Clinical Tables HCPCS API",
            })
            continue

        try:
            description = await asyncio.to_thread(_lookup_cpt_code, code)
        except (OSError, ValueError, csv.Error):
            description = None
        if description:
            procedures.append({
                "system": "CPT",
                "code": code,
                "description": description,
                "is_valid_code": True,
                "evidence": [code],
                "explanation": f"The configured licensed CPT reference ({CPT_REFERENCE_VERSION}) lists {code}.",
                "verification_status": "verified_licensed_reference",
                "reference_version": CPT_REFERENCE_VERSION,
                "reference": "Licensed CPT reference CSV",
            })
        else:
            workbook_checked_count += 1
            try:
                item = await asyncio.to_thread(_lookup_workbook_code, code, "CPT")
            except (OSError, ValueError, TypeError, KeyError, StopIteration, BadZipFile, InvalidFileException):
                item = None
            if item:
                fallback_count += 1
                procedures.append({
                    "system": "CPT",
                    "code": code,
                    "description": str(item.get("Description") or "").strip(),
                    "is_valid_code": True,
                    "evidence": [code],
                    "explanation": f"CPT is not available from the public NLM API; medical_codes.xlsx contains an exact example entry for {code}.",
                    "verification_status": "verified_fallback",
                    "reference_version": "2024 example data",
                    "reference": "medical_codes.xlsx (fallback; historical/example data)",
                })
            else:
                ignored.append({
                    "value": code,
                    "system": "CPT",
                    "reason": "CPT is not included in the public NLM API and no exact match was found in medical_codes.xlsx; configure an authorized, versioned CPT reference CSV for authoritative verification.",
                })

    for code in icd10_codes:
        match, error = public_matches[(code, "ICD-10-CM")]
        if error:
            ignored.append({"value": code, "system": "ICD-10-CM", "reason": error})
            continue
        if match is None:
            ignored.append({"value": code, "system": "ICD-10-CM", "reason": "No exact match was found in either the NLM ICD-10-CM Clinical Tables API or medical_codes.xlsx; code unverified."})
            continue
        if isinstance(match, tuple) and len(match) == 2 and match[1] == "workbook_fallback":
            fallback_count += 1
            item = match[0]
            diagnoses.append({
                "system": "ICD-10-CM",
                "code": code,
                "description": str(item.get("Diagnosis Description") or "").strip(),
                "is_valid_code": True,
                "evidence": [code],
                "explanation": f"The NLM API did not provide an exact match; medical_codes.xlsx contains an exact example entry for {code}.",
                "verification_status": "verified_fallback",
                "reference_version": "2024 example data",
                "reference": "medical_codes.xlsx (fallback; historical/example data)",
                "severity": str(item.get("Severity") or "").strip(),
                "related_symptoms": str(item.get("Related Symptoms") or "").strip(),
                "common_procedures": str(item.get("Common Procedures") or "").strip(),
            })
            continue
        _matched_code, description = match
        diagnoses.append({
            "system": "ICD-10-CM",
            "code": code,
            "description": description,
            "is_valid_code": True,
            "evidence": [code],
            "explanation": f"The NLM Clinical Tables ICD-10-CM API returned an exact match for {code}.",
            "verification_status": "verified_api",
            "reference_version": "Live NLM dataset; release not exposed by API",
            "reference": "NLM Clinical Tables ICD-10-CM API",
        })

    pricing_workbook_checked_count = 0
    for procedure in procedures:
        if procedure.get("system") != "CPT":
            continue
        try:
            authorized_price_range = await asyncio.to_thread(_lookup_cpt_price_range, procedure["code"])
        except (OSError, ValueError, csv.Error):
            authorized_price_range = None
        if authorized_price_range:
            procedure["cost"] = authorized_price_range
            continue
        pricing_workbook_checked_count += 1
        try:
            item = await asyncio.to_thread(_lookup_workbook_code, procedure["code"], "CPT")
        except (OSError, ValueError, TypeError, KeyError, StopIteration, BadZipFile, InvalidFileException):
            item = None
        if item:
            price_range = _workbook_cpt_price_range(item)
            if price_range:
                procedure["cost"] = price_range

    verified_count = len(procedures) + len(diagnoses)
    cpt_procedures = [procedure for procedure in procedures if procedure.get("system") == "CPT"]
    priced_cpt_count = sum(1 for procedure in cpt_procedures if (procedure.get("cost") or {}).get("reference_status") == "historical_example")
    authoritative_priced_cpt_count = sum(1 for procedure in cpt_procedures if (procedure.get("cost") or {}).get("reference_status") == "verified_authoritative")
    api_status = (
        "not_used" if not attempted_api_count
        else "unavailable" if api_failure_count == attempted_api_count
        else "partial" if api_failure_count
        else "available"
    )
    reference_status = (
        "partial_reference_gap" if verified_count and ignored
        else "reference_gap" if ignored
        else "fallback" if verified_count and fallback_count == verified_count
        else "partial_fallback" if fallback_count
        else "verified" if verified_count
        else "unavailable" if api_status == "unavailable"
        else "no_valid_codes"
    )
    result_message = (
        f"{fallback_count} code(s) matched in medical_codes.xlsx; {len(ignored)} code(s) remain unverified after checking {workbook_checked_count} workbook entry/entries. "
        "Workbook matches are historical/example data, not authoritative current validation."
        if fallback_count
        else f"No code matched the available references. Checked {workbook_checked_count} code(s) in medical_codes.xlsx; unresolved codes remain unverified and may require qualified review. API status: {api_status}."
        if ignored
        else "ICD-10-CM and HCPCS Level II codes are checked against the live NLM Clinical Tables API. CPT requires an authorized, versioned CPT reference CSV. No pricing or procedure-diagnosis relationships are inferred."
    )
    return {
        "procedures": procedures,
        "diagnoses": diagnoses,
        "code_relationships": [],
        "ignored_codes": ignored,
        "engine": "nlm_clinical_tables_api",
        "reference": "Live NLM Clinical Tables APIs for ICD-10-CM and HCPCS Level II; optional licensed CPT CSV",
        "reference_version": "Live NLM dataset; release not exposed by API",
        "reference_status": reference_status,
        "api_status": api_status,
        "fallback_count": fallback_count,
        "workbook_checked_count": workbook_checked_count,
        "pricing_workbook_checked_count": pricing_workbook_checked_count,
        "priced_cpt_count": priced_cpt_count,
        "authoritative_priced_cpt_count": authoritative_priced_cpt_count,
        "pricing_reference_status": (
            "verified_authoritative" if cpt_procedures and authoritative_priced_cpt_count == len(cpt_procedures)
            else "partial_authoritative" if authoritative_priced_cpt_count
            else "historical_example" if priced_cpt_count
            else "unavailable"
        ),
        "verified_count": verified_count,
        "ignored_count": len(ignored),
        "message": result_message,
        "disclaimer": DISCLAIMER,
    }
