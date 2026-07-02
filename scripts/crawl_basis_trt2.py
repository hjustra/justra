from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from collectors.basis_trt2 import (
    DEFAULT_BROAD_QUERIES,
    build_arg_parser,
    collect_many,
    discover_documents,
    download_documents,
    load_index,
    merge_records,
    save_index,
)


def main() -> None:
    parser = build_arg_parser()
    args = parser.parse_args()
    subject_filter = args.subject_filter or None
    if args.all:
        queries = DEFAULT_BROAD_QUERIES
        per_query_limit = max(args.limit, 5000)
    elif args.queries:
        queries = [item.strip() for item in args.queries.split(",") if item.strip()]
        per_query_limit = args.limit
    else:
        queries = [args.query]
        per_query_limit = args.limit

    output_path = ROOT / "data/raw/json/document_index.json"

    if len(queries) > 1 or args.all:
        records = collect_many(
            project_root=ROOT,
            queries=queries,
            subject_filter=subject_filter,
            per_query_limit=per_query_limit,
            rpp=args.rpp,
            sleep_seconds=args.sleep,
            fetch_details=not args.no_detail,
            download=not args.no_download,
            force=args.force,
        )
        print(f"salvo: {output_path}")
        print(f"documentos unicos no indice: {len(records)}")
        return

    records = discover_documents(
        query=args.query,
        subject_filter=subject_filter,
        limit=per_query_limit,
        rpp=args.rpp,
        sleep_seconds=args.sleep,
        fetch_details=not args.no_detail,
    )

    if not args.no_download:
        records = download_documents(records, ROOT, sleep_seconds=args.sleep, force=args.force)

    records = merge_records(load_index(output_path), records)
    save_index(records, output_path)
    print(f"salvo: {output_path}")
    print(f"documentos unicos no indice: {len(records)}")


if __name__ == "__main__":
    main()
