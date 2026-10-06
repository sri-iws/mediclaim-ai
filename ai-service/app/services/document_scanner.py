from __future__ import annotations

import csv
import html
import json
import re
import zipfile
from io import BytesIO
from pathlib import Path
from html.parser import HTMLParser
from xml.etree import ElementTree

import pymupdf as fitz
from openpyxl import load_workbook
import pytesseract
from PIL import Image

SUPPORTED_EXTENSIONS = {
    ".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp", ".bmp",
    ".txt", ".md", ".csv", ".tsv", ".json", ".xml", ".html", ".htm", ".rtf",
    ".docx", ".xlsx", ".xlsm",
}
MAX_PDF_PAGES = 25
COMMON_HEADERS = {
    "patient", "patient name", "claimant", "claimant name", "member", "member name",
    "insured", "insured name", "policy number", "member id", "subscriber id",
    "provider", "provider name", "hospital", "clinic", "diagnosis", "treatment",
    "claim amount", "amount", "invoice total", "claim amount", "date", "date of service",
}


def _has_document_headers(row: list[str]) -> bool:
    return len(row) > 1 and all(
        cell.strip().casefold().replace("_", " ") in COMMON_HEADERS
        for cell in row
    )


def _decode_text(content: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-16", "cp1252"):
        try:
            return content.decode(encoding)
        except UnicodeDecodeError:
            continue
    return content.decode("utf-8", errors="replace")


def _delimited_text(content: bytes, delimiter: str) -> str:
    rows = list(csv.reader(_decode_text(content).splitlines(), delimiter=delimiter))
    if not rows:
        return ""
    if len(rows[0]) == 2 and all(len(row) == 2 for row in rows) and not _has_document_headers(rows[0]):
        return "\n".join(f"{row[0]}: {row[1]}" for row in rows if row[0].strip())
    if len(rows) > 1 and len(rows[0]) > 1:
        return "\n".join(
            f"{header}: {value}"
            for row in rows[1:]
            for header, value in zip(rows[0], row)
            if header.strip() and value.strip()
        )
    return "\n".join(" | ".join(cell for cell in row if cell.strip()) for row in rows)


def _spreadsheet_text(content: bytes) -> str:
    try:
        workbook = load_workbook(BytesIO(content), read_only=True, data_only=True)
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        raise ValueError("The uploaded spreadsheet could not be opened.") from error

    lines: list[str] = []
    try:
        for worksheet in workbook.worksheets:
            rows = [
                ["" if cell is None else str(cell).strip() for cell in row]
                for row in worksheet.iter_rows(values_only=True)
            ]
            rows = [row for row in rows if any(row)]
            if not rows:
                continue
            if len(rows[0]) == 2 and all(len(row) == 2 for row in rows) and not _has_document_headers(rows[0]):
                lines.extend(f"{row[0]}: {row[1]}" for row in rows if row[0])
            elif len(rows) > 1 and len(rows[0]) > 1:
                lines.extend(
                    f"{header}: {value}"
                    for row in rows[1:]
                    for header, value in zip(rows[0], row)
                    if header and value
                )
            else:
                lines.extend(" | ".join(cell for cell in row if cell) for row in rows)
    finally:
        workbook.close()
    return "\n".join(lines)


def _docx_text(content: bytes) -> str:
    try:
        with zipfile.ZipFile(BytesIO(content)) as archive:
            document_xml = archive.read("word/document.xml")
        root = ElementTree.fromstring(document_xml)
    except (KeyError, OSError, ValueError, zipfile.BadZipFile, ElementTree.ParseError) as error:
        raise ValueError("The uploaded Word document could not be opened.") from error

    namespace = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    paragraphs = []
    for paragraph in root.iter(f"{namespace}p"):
        text = "".join(node.text or "" for node in paragraph.iter(f"{namespace}t"))
        if text.strip():
            paragraphs.append(text)
    return "\n".join(paragraphs)


def _html_text(content: bytes) -> str:
    class TextExtractor(HTMLParser):
        def __init__(self) -> None:
            super().__init__()
            self.parts: list[str] = []

        def handle_data(self, data: str) -> None:
            if data.strip():
                self.parts.append(data.strip())

    parser = TextExtractor()
    parser.feed(_decode_text(content))
    return html.unescape("\n".join(parser.parts))


def _json_text(content: bytes) -> str:
    try:
        data = json.loads(_decode_text(content))
    except json.JSONDecodeError as error:
        raise ValueError("The uploaded JSON document could not be parsed.") from error

    lines: list[str] = []

    def add_values(value: object, prefix: str = "") -> None:
        if isinstance(value, dict):
            for key, item in value.items():
                add_values(item, str(key))
        elif isinstance(value, list):
            for item in value:
                add_values(item, prefix)
        elif prefix and value is not None:
            lines.append(f"{prefix.replace('_', ' ')}: {value}")

    add_values(data)
    return "\n".join(lines)


def _xml_text(content: bytes) -> str:
    try:
        root = ElementTree.fromstring(content)
    except ElementTree.ParseError as error:
        raise ValueError("The uploaded XML document could not be parsed.") from error

    lines = []
    for element in root.iter():
        if list(element):
            continue
        value = " ".join(" ".join(element.itertext()).split())
        if value:
            label = element.tag.rsplit("}", 1)[-1].replace("_", " ")
            lines.append(f"{label}: {value}")
    return "\n".join(lines)


def _rtf_text(content: bytes) -> str:
    text = _decode_text(content)
    text = re.sub(r"\\'[0-9a-fA-F]{2}", " ", text)
    text = re.sub(r"\\(?:par|line|tab)\b", "\n", text)
    text = re.sub(r"\\[a-zA-Z]+-?\d* ?|\\[^a-zA-Z]", " ", text)
    return re.sub(r"[{}]", " ", text)


def _ocr_image(image: Image.Image) -> str:
    try:
        return pytesseract.image_to_string(image, lang="eng").strip()
    except pytesseract.TesseractNotFoundError as error:
        raise RuntimeError("Tesseract OCR is not installed or is not on PATH.") from error


def extract_document_text(filename: str, content: bytes) -> str:
    """Extract text from common medical, office, spreadsheet, and image documents."""
    extension = Path(filename).suffix.lower()
    if extension not in SUPPORTED_EXTENSIONS:
        raise ValueError("Unsupported document type. Upload a PDF or common image file.")
    if not content:
        raise ValueError("The uploaded document is empty.")

    if extension in {".txt", ".md"}:
        return _decode_text(content)
    if extension == ".xml":
        return _xml_text(content)
    if extension in {".csv", ".tsv"}:
        return _delimited_text(content, "\t" if extension == ".tsv" else ",")
    if extension == ".json":
        return _json_text(content)
    if extension in {".html", ".htm"}:
        return _html_text(content)
    if extension == ".rtf":
        return _rtf_text(content)
    if extension == ".docx":
        return _docx_text(content)
    if extension in {".xlsx", ".xlsm"}:
        return _spreadsheet_text(content)

    if extension == ".pdf":
        try:
            document = fitz.open(stream=content, filetype="pdf")
        except (fitz.FileDataError, ValueError) as error:
            raise ValueError("The uploaded PDF could not be opened.") from error
        with document:
            if document.page_count > MAX_PDF_PAGES:
                raise ValueError(f"PDFs are limited to {MAX_PDF_PAGES} pages.")
            page_text: list[str] = []
            for page in document:
                text = page.get_text().strip()
                if not text:
                    pixmap = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
                    image = Image.open(BytesIO(pixmap.tobytes("png")))
                    text = _ocr_image(image)
                if text:
                    page_text.append(text)
        return "\n\n".join(page_text)

    try:
        with Image.open(BytesIO(content)) as image:
            return _ocr_image(image.convert("RGB"))
    except (OSError, ValueError) as error:
        raise ValueError("The uploaded image could not be opened.") from error
