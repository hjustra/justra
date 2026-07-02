#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import secrets
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
from justra_runtime_paths import DATA_ROOT, LOG_ROOT  # noqa: E402
USERS_PATH = DATA_ROOT / "app" / "users.json"
KEYCHAIN_SERVICE = "com.justra.admin"


def main() -> None:
    users = json.loads(USERS_PATH.read_text(encoding="utf-8"))
    admin = next((user for user in users.values() if user.get("role") == "admin"), None)
    if not admin:
        raise RuntimeError("administrador não encontrado")

    password = secrets.token_urlsafe(32)
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 160_000).hex()

    subprocess.run(
        [
            "/usr/bin/security",
            "add-generic-password",
            "-U",
            "-a",
            str(admin["email"]),
            "-s",
            KEYCHAIN_SERVICE,
            "-w",
            password,
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    admin["password"] = {"salt": salt, "hash": digest}
    with tempfile.NamedTemporaryFile("w", dir=USERS_PATH.parent, delete=False, encoding="utf-8") as handle:
        json.dump(users, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        temporary_path = Path(handle.name)
    temporary_path.chmod(0o600)
    temporary_path.replace(USERS_PATH)
    USERS_PATH.chmod(0o600)

    print("Senha administrativa rotacionada e guardada no Chaves do macOS.")


if __name__ == "__main__":
    main()
