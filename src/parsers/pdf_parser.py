from __future__ import annotations

from pathlib import Path


def extract_text_with_pymupdf(pdf_path: Path) -> str:
    import fitz

    chunks: list[str] = []
    with fitz.open(pdf_path) as document:
        for page in document:
            chunks.append(page.get_text("text"))
    return "\n".join(chunks).strip()


def extract_text_with_pdfplumber(pdf_path: Path) -> str:
    import pdfplumber

    chunks: list[str] = []
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            chunks.append(page.extract_text() or "")
    return "\n".join(chunks).strip()


def extract_pdf_text(pdf_path: str | Path) -> str:
    path = Path(pdf_path)
    if not path.exists():
        return ""

    try:
        text = extract_text_with_pymupdf(path)
        if text:
            return text
    except Exception:
        pass

    try:
        return extract_text_with_pdfplumber(path)
    except Exception:
        return ""
