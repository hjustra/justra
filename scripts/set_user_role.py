#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
USERS_PATH = ROOT / "data" / "app" / "users.json"


def main() -> None:
    parser = argparse.ArgumentParser(description="Atualiza o papel de um usuário existente da Justra.")
    parser.add_argument("email")
    parser.add_argument("role", choices=("user", "admin"))
    args = parser.parse_args()

    email = args.email.strip().lower()
    users = json.loads(USERS_PATH.read_text(encoding="utf-8"))
    matches = [user for user in users.values() if str(user.get("email", "")).strip().lower() == email]
    if len(matches) != 1:
        raise RuntimeError(f"esperado exatamente um usuário; encontrados: {len(matches)}")

    user = matches[0]
    user["role"] = args.role

    with tempfile.NamedTemporaryFile("w", dir=USERS_PATH.parent, delete=False, encoding="utf-8") as handle:
        json.dump(users, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        temporary_path = Path(handle.name)
    temporary_path.chmod(0o600)
    temporary_path.replace(USERS_PATH)
    USERS_PATH.chmod(0o600)
    print(f"role_updated={args.role} provider={user.get('provider', '')}")


if __name__ == "__main__":
    main()
