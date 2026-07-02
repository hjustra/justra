from __future__ import annotations

import re
from pathlib import Path

from bs4 import BeautifulSoup


def clean_text(value: str | None) -> str:
    if not value:
        return ""
    return re.sub(r"\s+", " ", value).strip()


def extract_html_text(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "noscript", "header", "footer", "nav"]):
        tag.decompose()

    main = soup.select_one("main") or soup.body or soup
    return clean_text(main.get_text("\n", strip=True))


def extract_metadata(html: str) -> dict[str, list[str]]:
    soup = BeautifulSoup(html, "html.parser")
    metadata: dict[str, list[str]] = {}
    for meta in soup.find_all("meta"):
        name = meta.get("name") or meta.get("property")
        content = meta.get("content")
        if name and content:
            metadata.setdefault(name, []).append(clean_text(content))
    return metadata


def extract_html_file_text(path: str | Path) -> str:
    html_path = Path(path)
    if not html_path.exists():
        return ""
    return extract_html_text(html_path.read_text(encoding="utf-8", errors="ignore"))
