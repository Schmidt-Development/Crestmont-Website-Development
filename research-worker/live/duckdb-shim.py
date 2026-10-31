#!/usr/bin/env python3
"""DuckDB CLI stand-in for CI runners: same contract the worker uses (SQL script on stdin, CSV rows of the last
statement on stdout without a header, non-zero exit + stderr on error). Uses the duckdb Python package."""
import csv, sys
import duckdb

def main() -> int:
    sql = sys.stdin.read()
    if "--version" in sys.argv:
        print(duckdb.__version__)
        return 0
    con = duckdb.connect()
    try:
        stmts = [s.query for s in duckdb.extract_statements(sql)]
    except Exception:
        stmts = [s for s in sql.split(";\n") if s.strip()]
    rows = None
    try:
        for st in stmts:
            cur = con.execute(st)
            try:
                rows = cur.fetchall() if cur.description else None
            except duckdb.Error:
                rows = None
    except Exception as e:  # noqa: BLE001 - surface every DuckDB error as the CLI would
        sys.stderr.write(str(e)[:4000] + "\n")
        return 1
    if rows:
        w = csv.writer(sys.stdout, lineterminator="\n")
        for r in rows:
            w.writerow(["" if v is None else v for v in r])
    return 0

if __name__ == "__main__":
    sys.exit(main())
