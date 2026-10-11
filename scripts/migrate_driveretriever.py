"""Apply checked-in migrations in a single transaction, without rewriting legacy IDs."""
import argparse
import hashlib
import os
from pathlib import Path

import psycopg


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--database-url", default=None, help="prefer DATABASE_URL to keep secrets out of shell history")
    args = parser.parse_args()
    url = args.database_url or os.getenv("DATABASE_URL")
    if not url:
        parser.error("DATABASE_URL is required")
    with psycopg.connect(url) as connection:
        connection.execute("SELECT pg_advisory_xact_lock(6719951)")
        connection.execute("""CREATE TABLE IF NOT EXISTS scenesearch_schema_migrations(
                            name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())""")
        for path in sorted(Path("migrations").glob("*.sql")):
            content = path.read_bytes()
            digest = hashlib.sha256(content).hexdigest()
            previous = connection.execute("SELECT sha256 FROM scenesearch_schema_migrations WHERE name=%s", (path.name,)).fetchone()
            if previous:
                if previous[0] != digest:
                    raise ValueError(f"applied migration content changed: {path.name}")
                continue
            connection.execute(content.decode("utf-8"))
            connection.execute("INSERT INTO scenesearch_schema_migrations(name,sha256) VALUES(%s,%s)", (path.name, digest))
            print("Applied "+path.name)


if __name__ == "__main__":
    main()
