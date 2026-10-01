from io import BytesIO
import zipfile

from openpyxl import Workbook

from app.services.document_scanner import extract_document_text


def test_extracts_claim_fields_from_csv() -> None:
    text = extract_document_text(
        "claim.csv",
        b"Patient Name,Alex Morgan\nPolicy Number,POL-1108\nInvoice Total,$125.00",
    )

    assert "Patient Name: Alex Morgan" in text
    assert "Policy Number: POL-1108" in text
    assert "Invoice Total: $125.00" in text

    tabular_text = extract_document_text(
        "claim.csv",
        b"Patient Name,Policy Number\nAlex Morgan,POL-1108",
    )
    assert "Patient Name: Alex Morgan" in tabular_text
    assert "Policy Number: POL-1108" in tabular_text


def test_extracts_text_from_docx() -> None:
    document_xml = (
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:body><w:p><w:r><w:t>Patient Name: Alex Morgan</w:t></w:r></w:p>"
        "<w:p><w:r><w:t>Diagnosis: Acute bronchitis</w:t></w:r></w:p></w:body></w:document>"
    )
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("word/document.xml", document_xml)

    text = extract_document_text("claim.docx", buffer.getvalue())

    assert text == "Patient Name: Alex Morgan\nDiagnosis: Acute bronchitis"


def test_extracts_xml_field_names_as_labels() -> None:
    text = extract_document_text(
        "claim.xml",
        b"<claim><patient_name>Alex Morgan</patient_name><policy_number>POL-1108</policy_number></claim>",
    )

    assert "patient name: Alex Morgan" in text
    assert "policy number: POL-1108" in text


def test_extracts_claim_fields_from_xlsx() -> None:
    workbook = Workbook()
    worksheet = workbook.active
    worksheet.append(["Patient Name", "Policy Number", "Claim Amount"])
    worksheet.append(["Alex Morgan", "POL-1108", 125.0])
    buffer = BytesIO()
    workbook.save(buffer)

    text = extract_document_text("claim.xlsx", buffer.getvalue())

    assert "Patient Name: Alex Morgan" in text
    assert "Policy Number: POL-1108" in text
    assert "Claim Amount: 125" in text


def test_rejects_unsupported_document_extension() -> None:
    try:
        extract_document_text("claim.doc", b"binary document")
    except ValueError as error:
        assert "Unsupported document type" in str(error)
    else:
        raise AssertionError("Expected unsupported legacy Word format to be rejected")