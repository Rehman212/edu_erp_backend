#!/usr/bin/env python3
import json
import os
import re
import subprocess

env_text = open("/home/ubuntu/edu_erp_backend/.env", encoding="utf-8").read()
match = re.search(
    r"DATABASE_URL=postgresql://([^:]+):([^@]+)@([^:/]+):(\d+)/([^\s]+)",
    env_text,
)
user, password, host, port, db = match.groups()
os.environ["PGPASSWORD"] = password

list_sql = (
    "select table_name from information_schema.tables "
    "where table_schema='public' and table_type='BASE TABLE' order by 1;"
)
tables = subprocess.check_output(
    ["psql", "-h", host, "-p", port, "-U", user, "-d", db, "-At", "-c", list_sql],
    text=True,
).splitlines()

counts = {}
for table in tables:
    count_sql = f'select count(*)::bigint from "{table}";'
    value = subprocess.check_output(
        ["psql", "-h", host, "-p", port, "-U", user, "-d", db, "-At", "-c", count_sql],
        text=True,
    ).strip()
    counts[table] = int(value)

payload = {
    "rdsCounts": counts,
    "tableCount": len(counts),
    "totalRows": sum(counts.values()),
}
print(json.dumps(payload))
open("/tmp/rds-counts.json", "w", encoding="utf-8").write(json.dumps(payload))
