from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import duckdb


ROOT = Path(__file__).resolve().parents[1]
from justra_runtime_paths import DATA_ROOT, LOG_ROOT  # noqa: E402
DEFAULT_ACTIVE = DATA_ROOT / "mvp" / "trt2" / "trt2_mvp.duckdb"
DEFAULT_CANDIDATE = DATA_ROOT / "mvp" / "trt2" / "trt2_mvp_candidate.duckdb"
DEFAULT_STATUS = DATA_ROOT / "knowledge" / "falcao" / "candidate_import_status.json"
FINAL_STATUS = DATA_ROOT / "knowledge" / "falcao" / "import_status.json"


def inspect_database(path: Path) -> dict[str, int]:
    connection = duckdb.connect(str(path), read_only=True)
    try:
        return {
            "processes": connection.execute("SELECT COUNT(*) FROM processes").fetchone()[0],
            "movements": connection.execute("SELECT COUNT(*) FROM movements").fetchone()[0],
            "decision_events": connection.execute("SELECT COUNT(*) FROM decision_events").fetchone()[0],
            "full_text_documents": connection.execute("SELECT COUNT(*) FROM full_text_documents").fetchone()[0],
            "falcao_documents": connection.execute(
                "SELECT COUNT(*) FROM full_text_documents WHERE source_provider = 'falcao'"
            ).fetchone()[0],
        }
    finally:
        connection.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Promove atomicamente um DuckDB candidato para a Justra.")
    parser.add_argument("--active", default=str(DEFAULT_ACTIVE))
    parser.add_argument("--candidate", default=str(DEFAULT_CANDIDATE))
    parser.add_argument("--status", default=str(DEFAULT_STATUS))
    parser.add_argument("--expected-processes", type=int, default=58_799)
    parser.add_argument("--expected-falcao", type=int, default=4_585)
    args = parser.parse_args()

    active = Path(args.active).resolve()
    candidate = Path(args.candidate).resolve()
    candidate_status = Path(args.status).resolve()
    if not active.exists() or not candidate.exists():
        raise RuntimeError("banco ativo ou candidato não encontrado")

    candidate_counts = inspect_database(candidate)
    if candidate_counts["processes"] != args.expected_processes:
        raise RuntimeError(f"processos inesperados na candidata: {candidate_counts['processes']}")
    if candidate_counts["falcao_documents"] != args.expected_falcao:
        raise RuntimeError(f"documentos Falcão inesperados na candidata: {candidate_counts['falcao_documents']}")

    backup_dir = active.parent / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    previous_backup = backup_dir / f"{active.stem}_before_full_promotion_{stamp}{active.suffix}"

    active.replace(previous_backup)
    try:
        candidate.replace(active)
    except Exception:
        previous_backup.replace(active)
        raise
    active.chmod(0o600)
    previous_backup.chmod(0o600)

    status = json.loads(candidate_status.read_text(encoding="utf-8")) if candidate_status.exists() else {}
    status.update(
        {
            "promoted_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "active_db": str(active),
            "previous_active_backup": str(previous_backup),
            "active_counts": candidate_counts,
        }
    )
    FINAL_STATUS.parent.mkdir(parents=True, exist_ok=True)
    temporary_status = FINAL_STATUS.with_suffix(".tmp")
    temporary_status.write_text(json.dumps(status, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary_status.replace(FINAL_STATUS)
    FINAL_STATUS.chmod(0o600)

    print(
        json.dumps(
            {
                "ok": True,
                "active": str(active),
                "previous_active_backup": str(previous_backup),
                "counts": candidate_counts,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
