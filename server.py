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

from fastapi import Depends, FastAPI, HTTPException, Request, Response
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


class LabelChange(LabelWrite):
    address: str
    scope: str


class BookWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")
    changes: list[LabelChange] = Field(max_length=5000)


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
        # One number that changes whenever the book does. Asking "has anything
        # changed?" then costs a row, rather than the whole book over the wire.
        connection.execute("CREATE TABLE IF NOT EXISTS book (revision INTEGER NOT NULL)")
        if connection.execute("SELECT COUNT(*) FROM book").fetchone()[0] == 0:
            connection.execute("INSERT INTO book VALUES (0)")
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

    def revision_of(connection: sqlite3.Connection) -> int:
        return connection.execute("SELECT revision FROM book").fetchone()[0]

    def bump(connection: sqlite3.Connection) -> int:
        connection.execute("UPDATE book SET revision = revision + 1")
        return revision_of(connection)

    @app.get("/labels", dependencies=[Depends(authenticated)])
    def read_book(request: Request):
        with closing(connect()) as connection:
            mark = f'"{revision_of(connection)}"'
            # A book that has not changed is not sent again. This is the usual
            # answer, so it is the one worth making cheap.
            if request.headers.get("if-none-match") == mark:
                return Response(status_code=304, headers={"ETag": mark})
            rows = connection.execute("SELECT * FROM labels ORDER BY scope, address").fetchall()
        return JSONResponse({"records": [record(row) for row in rows]}, headers={"ETag": mark})

    def apply(connection: sqlite3.Connection, address: str, scope: str, change: LabelWrite) -> dict | None:
        """Write one record inside a transaction the caller owns."""
        if not change.labels:
            connection.execute("DELETE FROM labels WHERE address = ? AND scope = ?", (address, scope))
            return None
        saved = {
            "address": address, "scope": scope,
            "labels": change.labels, "version": secrets.token_hex(16),
        }
        connection.execute(
            "INSERT INTO labels VALUES (?, ?, ?, ?) "
            "ON CONFLICT(address, scope) DO UPDATE SET labels_json=excluded.labels_json, version=excluded.version",
            (address, scope, json.dumps(change.labels, ensure_ascii=False), saved["version"]),
        )
        return saved

    def held(connection: sqlite3.Connection, address: str, scope: str) -> sqlite3.Row | None:
        return connection.execute(
            "SELECT * FROM labels WHERE address = ? AND scope = ?", (address, scope)
        ).fetchone()

    def unlocked(work):
        try:
            return work()
        except sqlite3.OperationalError as error:
            if "locked" in str(error).lower():
                raise HTTPException(503, "The book is busy. Refresh and try again.") from error
            raise

    @app.put("/labels/{scope}/{address}", dependencies=[Depends(authenticated)])
    def replace_list(scope: str, address: str, change: LabelWrite):
        address, scope = address_key(address), scope_key(scope)

        def work():
            with closing(connect()) as connection, connection:
                connection.execute("BEGIN IMMEDIATE")
                current = held(connection, address, scope)
                if change.version != (current["version"] if current else None):
                    return JSONResponse(status_code=409, content={
                        "detail": "Saved elsewhere while you were editing.",
                        "current": record(current),
                    })
                saved = apply(connection, address, scope, change)
                mark = bump(connection)
            return JSONResponse({"record": saved}, headers={"ETag": f'"{mark}"'})

        return unlocked(work)

    # A file carried in is one decision, so it is one transaction: either the
    # whole batch lands or none of it does, and either way it is one round trip.
    @app.put("/labels", dependencies=[Depends(authenticated)])
    def replace_many(write: BookWrite):
        changes = [(address_key(change.address), scope_key(change.scope), change) for change in write.changes]
        seen = set()
        for address, scope, _ in changes:
            if (address, scope) in seen:
                raise HTTPException(422, "Each address and scope may appear once in a batch.")
            seen.add((address, scope))

        def work():
            with closing(connect()) as connection, connection:
                connection.execute("BEGIN IMMEDIATE")
                conflicts = []
                for address, scope, change in changes:
                    current = held(connection, address, scope)
                    if change.version != (current["version"] if current else None):
                        conflicts.append({"address": address, "scope": scope, "current": record(current)})
                if conflicts:
                    return JSONResponse(status_code=409, content={
                        "detail": "Saved elsewhere while this file was being added.",
                        "conflicts": conflicts,
                    })
                saved = [apply(connection, address, scope, change) for address, scope, change in changes]
                mark = bump(connection)
            return JSONResponse({"records": saved}, headers={"ETag": f'"{mark}"'})

        return unlocked(work)

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
