from __future__ import annotations

import argparse
import hashlib
import json
import re
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlunparse

import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

try:
    from src.justra_paths import DATA_ROOT
except ModuleNotFoundError:  # scripts antigos adicionam ROOT/src ao sys.path
    from justra_paths import DATA_ROOT


BASIS_BASE_URL = "https://basis.trt2.jus.br"
DEFAULT_QUERY = "Jurisprudência trabalhista"
DEFAULT_SUBJECT_FILTER = "Jurisprudência trabalhista"
DEFAULT_BROAD_QUERIES = [
    "Jurisprudência trabalhista",
    "acórdão",
    "recurso ordinário",
    "horas extras",
    "dano moral",
    "vínculo empregatício",
]
USER_AGENT = (
    "JustraV0ResearchBot/0.1 "
    "(local research; respectful crawling; contact: local)"
)


MONTHS_PT = {
    "jan": "01",
    "janeiro": "01",
    "fev": "02",
    "fevereiro": "02",
    "mar": "03",
    "marco": "03",
    "março": "03",
    "abr": "04",
    "abril": "04",
    "mai": "05",
    "maio": "05",
    "jun": "06",
    "junho": "06",
    "jul": "07",
    "julho": "07",
    "ago": "08",
    "agosto": "08",
    "set": "09",
    "setembro": "09",
    "out": "10",
    "outubro": "10",
    "nov": "11",
    "novembro": "11",
    "dez": "12",
    "dezembro": "12",
}


@dataclass
class BasisDocument:
    source: str = "basis_trt2"
    title: str = ""
    document_type: str = ""
    date: str = ""
    url: str = ""
    pdf_url: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)
    raw_html_path: str = ""
    raw_pdf_path: str = ""


def make_session() -> requests.Session:
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.7",
        }
    )
    retry = Retry(
        total=3,
        backoff_factor=0.8,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=("GET", "HEAD"),
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session


def normalize_space(value: str | None) -> str:
    if not value:
        return ""
    return re.sub(r"\s+", " ", value).strip()


def parse_basis_date(value: str | None) -> str:
    text = normalize_space(value)
    if not text:
        return ""

    iso = re.search(r"\b(\d{4})-(\d{2})-(\d{2})\b", text)
    if iso:
        return iso.group(0)

    br = re.search(r"\b(\d{1,2})/(\d{1,2})/(\d{4})\b", text)
    if br:
        day, month, year = br.groups()
        return f"{year}-{int(month):02d}-{int(day):02d}"

    long_pt = re.search(r"\b(\d{1,2})\s+([A-Za-zçÇ.]+)\s+(\d{4})\b", text)
    if long_pt:
        day, month_name, year = long_pt.groups()
        month_key = month_name.lower().rstrip(".")
        month = MONTHS_PT.get(month_key)
        if month:
            return f"{year}-{month}-{int(day):02d}"

    return text


def canonical_url(url: str) -> str:
    if not url:
        return ""
    parsed = urlparse(urljoin(BASIS_BASE_URL, url))
    query_pairs = [
        (key, value)
        for key, value in parse_qsl(parsed.query, keep_blank_values=True)
        if key.lower() in {"sequence", "isallowed"}
    ]
    query = urlencode(sorted(query_pairs))
    path = re.sub(r"/+", "/", parsed.path)
    return urlunparse((parsed.scheme, parsed.netloc.lower(), path, "", query, ""))


def document_key(url: str, pdf_url: str = "", title: str = "") -> str:
    for candidate in (url, pdf_url):
        handle = re.search(r"/(?:bitstream/)?handle/(\d+)/(\d+)", candidate or "")
        if handle:
            return f"handle:{handle.group(1)}/{handle.group(2)}"
        bitstream = re.search(r"/bitstream/(\d+)/(\d+)/", candidate or "")
        if bitstream:
            return f"handle:{bitstream.group(1)}/{bitstream.group(2)}"
    digest = hashlib.sha1(
        f"{canonical_url(url)}|{canonical_url(pdf_url)}|{normalize_space(title)}".encode("utf-8")
    ).hexdigest()
    return f"sha1:{digest[:20]}"


def stable_id(url: str, title: str = "") -> str:
    handle = re.search(r"/(?:bitstream/)?handle/(\d+)/(\d+)", url)
    if handle:
        return f"{handle.group(1)}_{handle.group(2)}"
    bitstream = re.search(r"/bitstream/(\d+)/(\d+)/", url)
    if bitstream:
        return f"{bitstream.group(1)}_{bitstream.group(2)}"
    digest = hashlib.sha1(f"{url}|{title}".encode("utf-8")).hexdigest()
    return digest[:16]


def discover_url(
    base_url: str,
    query: str,
    page: int,
    rpp: int,
    subject_filter: str | None = None,
) -> tuple[str, dict[str, str | int]]:
    params: dict[str, str | int] = {
        "rpp": rpp,
        "etal": "0",
        "query": query,
        "group_by": "none",
        "page": page,
    }
    if subject_filter:
        params["filtertype_0"] = "subject"
        params["filter_relational_operator_0"] = "equals"
        params["filter_0"] = subject_filter
    return urljoin(base_url, "/discover"), params


def fetch_text(session: requests.Session, url: str, **kwargs: Any) -> str:
    response = session.get(url, timeout=kwargs.pop("timeout", 30), **kwargs)
    response.raise_for_status()
    response.encoding = response.encoding or "utf-8"
    return response.text


def fetch_bytes(session: requests.Session, url: str, **kwargs: Any) -> bytes:
    response = session.get(url, timeout=kwargs.pop("timeout", 60), **kwargs)
    response.raise_for_status()
    return response.content


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def first_text(node: BeautifulSoup, selector: str) -> str:
    selected = node.select_one(selector)
    return normalize_space(selected.get_text(" ", strip=True)) if selected else ""


def is_item_handle_href(href: str | None) -> bool:
    return bool(href and "/handle/" in href and "/bitstream/" not in href)


def find_item_handle_link(item: BeautifulSoup):
    for link in item.select("a[href*='/handle/']"):
        if is_item_handle_href(link.get("href")):
            return link
    return None


def parse_meta_tags(soup: BeautifulSoup) -> dict[str, list[str]]:
    metadata: dict[str, list[str]] = {}
    for meta in soup.find_all("meta"):
        name = meta.get("name") or meta.get("property")
        content = meta.get("content")
        if name and content:
            metadata.setdefault(name, []).append(normalize_space(content))
    return metadata


def first_meta(metadata: dict[str, list[str]], *keys: str) -> str:
    for key in keys:
        values = metadata.get(key)
        if values:
            return values[0]
    return ""


def all_meta(metadata: dict[str, list[str]], *keys: str) -> list[str]:
    output: list[str] = []
    for key in keys:
        output.extend(metadata.get(key, []))
    return [value for value in output if value]


def parse_detail_page(html: str, source_url: str, base_url: str = BASIS_BASE_URL) -> BasisDocument:
    soup = BeautifulSoup(html, "html.parser")
    metadata = parse_meta_tags(soup)

    title = first_meta(metadata, "citation_title", "DC.title") or first_text(soup, "h2.first-page-header")
    pdf_url = first_meta(metadata, "citation_pdf_url")
    if not pdf_url:
        pdf_link = soup.select_one("a.file-download-link[href*='.pdf'], a[href*='/bitstream/'][href*='.pdf']")
        if pdf_link and pdf_link.get("href"):
            pdf_url = urljoin(base_url, pdf_link["href"])

    subjects = all_meta(metadata, "DC.subject")
    if not subjects:
        keywords = first_meta(metadata, "citation_keywords")
        subjects = [normalize_space(item) for item in keywords.split(";") if normalize_space(item)]

    dc_types = all_meta(metadata, "DC.type")
    document_type = dc_types[0] if dc_types else first_text(soup, ".info-document-type-lg")
    date = parse_basis_date(first_meta(metadata, "DCTERMS.issued", "DCTERMS.created", "citation_date"))

    return BasisDocument(
        title=title,
        document_type=document_type,
        date=date,
        url=source_url,
        pdf_url=pdf_url,
        metadata={
            "authors": all_meta(metadata, "citation_author", "DC.creator"),
            "contributors": all_meta(metadata, "DC.contributor"),
            "subjects": subjects,
            "types": dc_types,
            "abstract": first_meta(metadata, "DCTERMS.abstract"),
            "basis_meta": metadata,
        },
    )


def parse_search_results(html: str, page_url: str, base_url: str = BASIS_BASE_URL) -> list[BasisDocument]:
    soup = BeautifulSoup(html, "html.parser")
    records: list[BasisDocument] = []
    seen_urls: set[str] = set()

    for item in soup.select(".ds-artifact-item"):
        link = find_item_handle_link(item)
        if not link or not link.get("href"):
            continue

        source_url = urljoin(base_url, link["href"])
        if source_url in seen_urls:
            continue
        seen_urls.add(source_url)

        title_node = link.select_one("h4.artifact-title") or item.select_one("h4.artifact-title")
        title = normalize_space((title_node or link).get_text(" ", strip=True))
        document_type = first_text(item, ".info-document-type a")
        info_text = first_text(item, ".artifact-info")
        date_match = re.search(
            r"\|\s*([0-9]{1,2}/[0-9]{1,2}/[0-9]{4}|[0-9]{1,2}\s+[A-Za-zçÇ.]+\s+[0-9]{4})",
            info_text,
        )
        date = parse_basis_date(date_match.group(1) if date_match else "")

        pdf_url = ""
        pdf_link = item.select_one("a[href*='/bitstream/'][href*='.pdf']")
        if pdf_link and pdf_link.get("href"):
            pdf_url = urljoin(base_url, pdf_link["href"])

        abstract = first_text(item, ".abstract") or first_text(item, ".artifact-abstract")
        snippet = first_text(item, "#fulltextresults")

        records.append(
            BasisDocument(
                title=title,
                document_type=document_type,
                date=date,
                url=source_url,
                pdf_url=pdf_url,
                metadata={
                    "abstract": abstract,
                    "snippet": snippet,
                    "search_page": page_url,
                    "raw_info_text": info_text,
                },
            )
        )

    return records


def merge_record(base: BasisDocument, detail: BasisDocument) -> BasisDocument:
    data = asdict(base)
    detail_data = asdict(detail)
    for key, value in detail_data.items():
        if key == "metadata":
            merged = dict(data.get("metadata") or {})
            merged.update(value or {})
            data["metadata"] = merged
        elif value and not data.get(key):
            data[key] = value
        elif key in {"title", "document_type", "date", "pdf_url"} and value:
            data[key] = value
    return BasisDocument(**data)


def discover_documents(
    base_url: str = BASIS_BASE_URL,
    query: str = DEFAULT_QUERY,
    subject_filter: str | None = DEFAULT_SUBJECT_FILTER,
    limit: int = 50,
    rpp: int = 20,
    sleep_seconds: float = 1.0,
    fetch_details: bool = True,
    skip_keys: set[str] | None = None,
) -> list[BasisDocument]:
    session = make_session()
    collected: list[BasisDocument] = []
    seen_keys: set[str] = set(skip_keys or set())
    page = 1

    while len(collected) < limit:
        url, params = discover_url(base_url, query, page, rpp, subject_filter)
        try:
            response = session.get(url, params=params, timeout=30)
            response.raise_for_status()
        except requests.HTTPError as exc:
            status = exc.response.status_code if exc.response is not None else "?"
            print(f"aviso: parando query '{query}' na pagina {page}: HTTP {status}")
            break
        except requests.RequestException as exc:
            print(f"aviso: parando query '{query}' na pagina {page}: {exc}")
            break
        page_url = response.url
        page_records = parse_search_results(response.text, page_url, base_url)
        if not page_records:
            break

        new_on_page = 0
        for record in page_records:
            key = document_key(record.url, record.pdf_url, record.title)
            if key in seen_keys:
                continue
            seen_keys.add(key)
            new_on_page += 1

            if fetch_details:
                time.sleep(sleep_seconds)
                try:
                    detail_html = fetch_text(session, record.url)
                    record = merge_record(record, parse_detail_page(detail_html, record.url, base_url))
                except requests.RequestException as exc:
                    record.metadata["detail_error"] = str(exc)

            collected.append(record)
            if len(collected) >= limit:
                break

        if new_on_page == 0 and page > 1:
            # Continue through a few duplicate-heavy pages, but avoid looping
            # forever when broad queries converge to the same result window.
            pass
        page += 1
        time.sleep(sleep_seconds)

    return collected


def load_index(index_path: Path) -> list[BasisDocument]:
    if not index_path.exists():
        return []
    payload = json.loads(index_path.read_text(encoding="utf-8"))
    if isinstance(payload, dict):
        payload = [payload]
    records: list[BasisDocument] = []
    for item in payload:
        if isinstance(item, dict):
            known = {field_name: item.get(field_name) for field_name in BasisDocument.__dataclass_fields__}
            known["metadata"] = known.get("metadata") or {}
            records.append(BasisDocument(**known))
    return records


def merge_records(existing: list[BasisDocument], incoming: list[BasisDocument]) -> list[BasisDocument]:
    merged: dict[str, BasisDocument] = {}
    for record in existing + incoming:
        key = document_key(record.url, record.pdf_url, record.title)
        if key not in merged:
            merged[key] = record
            continue
        merged[key] = merge_record(merged[key], record)
        if record.raw_html_path:
            merged[key].raw_html_path = record.raw_html_path
        if record.raw_pdf_path:
            merged[key].raw_pdf_path = record.raw_pdf_path
    return sorted(
        merged.values(),
        key=lambda item: (item.date or "", item.title or "", item.url or ""),
        reverse=True,
    )


def save_index(records: list[BasisDocument], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    payload = [asdict(record) for record in records]
    output_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def save_json_sidecar(record: BasisDocument, output_path: Path) -> None:
    output_path.write_text(
        json.dumps(asdict(record), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def resolve_stored_path(project_root: Path, value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else project_root / path


def store_path(path: Path, project_root: Path) -> str:
    try:
        return str(path.relative_to(project_root))
    except ValueError:
        return str(path)


def load_manifest(manifest_path: Path) -> dict[str, Any]:
    if not manifest_path.exists():
        return {"documents": {}, "pdf_sha256": {}}
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    payload.setdefault("documents", {})
    payload.setdefault("pdf_sha256", {})
    return payload


def save_manifest(manifest: dict[str, Any], manifest_path: Path) -> None:
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )


def has_downloaded_document(record: BasisDocument, manifest: dict[str, Any], project_root: Path) -> BasisDocument | None:
    key = document_key(record.url, record.pdf_url, record.title)
    manifest_record = manifest.get("documents", {}).get(key)
    if not manifest_record:
        return None

    html_rel = manifest_record.get("raw_html_path") or ""
    pdf_rel = manifest_record.get("raw_pdf_path") or ""
    html_ok = bool(html_rel and resolve_stored_path(project_root, html_rel).exists())
    pdf_ok = not record.pdf_url or bool(pdf_rel and resolve_stored_path(project_root, pdf_rel).exists())
    if html_ok and pdf_ok:
        record.raw_html_path = html_rel
        record.raw_pdf_path = pdf_rel
        return record
    return None


def download_documents(
    records: list[BasisDocument],
    project_root: Path,
    sleep_seconds: float = 1.0,
    force: bool = False,
) -> list[BasisDocument]:
    session = make_session()
    html_dir = DATA_ROOT / "raw" / "html"
    pdf_dir = DATA_ROOT / "raw" / "pdf"
    json_dir = DATA_ROOT / "raw" / "json"
    html_dir.mkdir(parents=True, exist_ok=True)
    pdf_dir.mkdir(parents=True, exist_ok=True)
    json_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = json_dir / "download_manifest.json"
    manifest = load_manifest(manifest_path)

    updated: list[BasisDocument] = []
    for record in records:
        key = document_key(record.url, record.pdf_url, record.title)
        doc_id = stable_id(record.url, record.title)

        if not force:
            downloaded = has_downloaded_document(record, manifest, project_root)
            if downloaded:
                updated.append(downloaded)
                continue

        html_path = html_dir / f"{doc_id}.html"
        if force or not html_path.exists():
            try:
                html_path.write_text(fetch_text(session, record.url), encoding="utf-8")
            except requests.RequestException as exc:
                record.metadata["html_download_error"] = str(exc)
        if html_path.exists():
            record.raw_html_path = store_path(html_path, project_root)

        if record.pdf_url:
            pdf_name = re.sub(r"[^\w.-]+", "_", Path(record.pdf_url.split("?")[0]).name)
            pdf_path = pdf_dir / f"{doc_id}_{pdf_name}"
            if force or not pdf_path.exists():
                try:
                    pdf_path.write_bytes(fetch_bytes(session, record.pdf_url))
                except requests.RequestException as exc:
                    record.metadata["pdf_download_error"] = str(exc)
            if pdf_path.exists():
                record.raw_pdf_path = store_path(pdf_path, project_root)
                pdf_hash = sha256_file(pdf_path)
                duplicate_pdf = manifest["pdf_sha256"].get(pdf_hash)
                if duplicate_pdf and duplicate_pdf != record.raw_pdf_path:
                    record.metadata["duplicate_pdf_of"] = duplicate_pdf
                else:
                    manifest["pdf_sha256"][pdf_hash] = record.raw_pdf_path

        save_json_sidecar(record, json_dir / f"{doc_id}.json")
        manifest["documents"][key] = {
            "title": record.title,
            "url": canonical_url(record.url),
            "pdf_url": canonical_url(record.pdf_url),
            "raw_html_path": record.raw_html_path,
            "raw_pdf_path": record.raw_pdf_path,
            "document_type": record.document_type,
            "date": record.date,
        }
        save_manifest(manifest, manifest_path)
        updated.append(record)
        time.sleep(sleep_seconds)

    return updated


def collect_many(
    project_root: Path,
    queries: list[str],
    subject_filter: str | None,
    per_query_limit: int,
    rpp: int,
    sleep_seconds: float,
    fetch_details: bool,
    download: bool,
    force: bool,
) -> list[BasisDocument]:
    index_path = DATA_ROOT / "raw" / "json" / "document_index.json"
    existing = load_index(index_path)
    all_records = existing[:]

    for query in queries:
        known_keys = {document_key(record.url, record.pdf_url, record.title) for record in all_records}
        effective_subject = subject_filter
        if len(queries) > 1 and query != DEFAULT_QUERY and subject_filter == DEFAULT_SUBJECT_FILTER:
            effective_subject = None
        discovered = discover_documents(
            query=query,
            subject_filter=effective_subject,
            limit=per_query_limit,
            rpp=rpp,
            sleep_seconds=sleep_seconds,
            fetch_details=fetch_details,
            skip_keys=known_keys,
        )
        if download:
            discovered = download_documents(discovered, project_root, sleep_seconds=sleep_seconds, force=force)
        all_records = merge_records(all_records, discovered)
        save_index(all_records, index_path)

    return all_records


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Coleta documentos publicos do Basis TRT2.")
    parser.add_argument("--limit", type=int, default=50, help="Numero maximo de documentos.")
    parser.add_argument("--query", default=DEFAULT_QUERY, help="Consulta textual no Basis.")
    parser.add_argument(
        "--queries",
        default="",
        help="Consultas separadas por virgula. Quando usado, coleta e deduplica todas.",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="Usa consultas amplas predefinidas e um limite alto por consulta.",
    )
    parser.add_argument(
        "--subject-filter",
        default=DEFAULT_SUBJECT_FILTER,
        help="Filtro de assunto do DSpace. Use vazio para desativar.",
    )
    parser.add_argument("--rpp", type=int, default=20, help="Resultados por pagina.")
    parser.add_argument("--sleep", type=float, default=1.0, help="Pausa entre requisicoes.")
    parser.add_argument("--no-detail", action="store_true", help="Nao visitar paginas de detalhe.")
    parser.add_argument("--no-download", action="store_true", help="Salvar apenas o indice.")
    parser.add_argument("--force", action="store_true", help="Baixar novamente arquivos existentes.")
    return parser
