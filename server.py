"""One authenticated address book, one SQLite table, one process."""

import argparse
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
from contextlib import closing

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field, field_validator
import uvicorn

ADDRESS = re.compile(r"0x[0-9a-f]{40}", re.IGNORECASE)
NETWORK = re.compile(r"eip155:([1-9][0-9]*)")
MAX_LABELS = 32
MAX_NAME_LENGTH = 80


def address_key(value: str) -> str:
    if not ADDRESS.fullmatch(value):
        raise HTTPException(422, "Use a full hexadecimal Ethereum address.")
    return value.lower()


def scope_key(value: str) -> str:
    if value == "global":
        return value
    match = NETWORK.fullmatch(value)
    if not match or len(match[1]) > 20:
        raise HTTPException(422, "Use global or eip155 followed by a positive chain ID.")
    return value


class LabelWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")
    labels: list[str] = Field(max_length=MAX_LABELS)
    version: str | None = Field(max_length=128)

    @field_validator("labels")
    @classmethod
    def clean_names(cls, names: list[str]) -> list[str]:
        cleaned = []
        seen = set()
        for name in names:
            name = name.strip()
            if not name or len(name) > MAX_NAME_LENGTH:
                raise ValueError(f"Names must contain 1–{MAX_NAME_LENGTH} characters.")
            if any(ord(character) < 32 or ord(character) == 127 for character in name):
                raise ValueError("Names cannot contain control characters.")
            if name.casefold() in seen:
                raise ValueError("Each name in a list must be distinct.")
            seen.add(name.casefold())
            cleaned.append(name)
        return cleaned


def record(row: sqlite3.Row | None) -> dict | None:
    if row is None:
        return None
    return {
        "address": row["address"],
        "scope": row["scope"],
        "labels": json.loads(row["labels_json"]),
        "version": row["version"],
    }


def create_app(database: str | Path, token: str) -> FastAPI:
    if not token:
        raise ValueError("An access token is required.")
    database = Path(database)
    database.parent.mkdir(parents=True, exist_ok=True)

    def connect() -> sqlite3.Connection:
        connection = sqlite3.connect(database, timeout=5)
        connection.row_factory = sqlite3.Row
        return connection

    with closing(connect()) as connection, connection:
        connection.execute("""
            CREATE TABLE IF NOT EXISTS labels (
                address TEXT NOT NULL,
                scope TEXT NOT NULL,
                labels_json TEXT NOT NULL,
                version TEXT NOT NULL,
                PRIMARY KEY (address, scope)
            )
        """)
    if os.name != "nt":
        database.chmod(0o600)

    bearer = HTTPBearer(auto_error=False)

    def authenticated(credentials: HTTPAuthorizationCredentials | None = Depends(bearer)) -> None:
        supplied = credentials.credentials if credentials and credentials.scheme.lower() == "bearer" else ""
        if not hmac.compare_digest(supplied.encode(), token.encode()):
            raise HTTPException(401, "Access token required.", headers={"WWW-Authenticate": "Bearer"})

    app = FastAPI(title="0xlabel", docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def no_cache(request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.get("/labels", dependencies=[Depends(authenticated)])
    def read_book():
        with closing(connect()) as connection:
            rows = connection.execute("SELECT * FROM labels ORDER BY scope, address").fetchall()
        return {"records": [record(row) for row in rows]}

    @app.put("/labels/{scope}/{address}", dependencies=[Depends(authenticated)])
    def replace_list(scope: str, address: str, change: LabelWrite):
        address, scope = address_key(address), scope_key(scope)
        try:
            with closing(connect()) as connection, connection:
                connection.execute("BEGIN IMMEDIATE")
                current = connection.execute(
                    "SELECT * FROM labels WHERE address = ? AND scope = ?", (address, scope)
                ).fetchone()
                current_version = current["version"] if current else None
                if change.version != current_version:
                    return JSONResponse(status_code=409, content={
                        "detail": "This list changed. Review the latest saved names before trying again.",
                        "current": record(current),
                    })
                if not change.labels:
                    connection.execute("DELETE FROM labels WHERE address = ? AND scope = ?", (address, scope))
                    return {"record": None}
                saved = {
                    "address": address, "scope": scope,
                    "labels": change.labels, "version": secrets.token_hex(16),
                }
                connection.execute(
                    "INSERT INTO labels VALUES (?, ?, ?, ?) "
                    "ON CONFLICT(address, scope) DO UPDATE SET labels_json=excluded.labels_json, version=excluded.version",
                    (address, scope, json.dumps(change.labels, ensure_ascii=False), saved["version"]),
                )
            return {"record": saved}
        except sqlite3.OperationalError as error:
            if "locked" in str(error).lower():
                raise HTTPException(503, "The book is busy. Refresh and try again.") from error
            raise

    return app


def load_token(directory: Path) -> str:
    configured = os.environ.get("OXLABEL_TOKEN")
    if configured:
        return configured
    path = directory / "token.txt"
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(descriptor, "w") as handle:
            handle.write(secrets.token_urlsafe(32) + "\n")
    token = path.read_text().strip()
    if not token:
        raise ValueError("token.txt is empty; supply a valid access token.")
    return token


def connect_link(base: str, token: str) -> str:
    """The one line a person pastes into the extension."""
    return f"{base.rstrip('/')}#key={token}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8712)
    parser.add_argument("--data-dir", type=Path,
                        default=Path(os.environ.get("OXLABEL_DATA_DIR", Path.home() / ".local/share/0xlabel")))
    parser.add_argument("--public-url", help="HTTPS base URL when hosted behind a reverse proxy")
    args = parser.parse_args()
    args.data_dir.mkdir(parents=True, exist_ok=True)
    if os.name != "nt":
        args.data_dir.chmod(0o700)
    token = load_token(args.data_dir)
    app = create_app(args.data_dir / "labels.sqlite3", token)
    base = args.public_url or f"http://127.0.0.1:{args.port}"
    # One line to paste. The key rides in the fragment, which a browser never
    # sends to a server, so the link cannot carry it back out over the wire.
    print("0xlabel is ready. Paste this link into the extension:", flush=True)
    print(connect_link(base, token), flush=True)
    print(f"Keep it private. Book: {args.data_dir / 'labels.sqlite3'}", flush=True)
    uvicorn.run(app, host=args.host, port=args.port, access_log=False)


if __name__ == "__main__":
    main()
