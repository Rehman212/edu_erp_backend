#!/usr/bin/env python3
import os
import re
import subprocess
import sys

env_text = open("/home/ubuntu/edu_erp_backend/.env", encoding="utf-8").read()
match = re.search(
    r"DATABASE_URL=postgresql://([^:]+):([^@]+)@([^:/]+):(\d+)/([^\s]+)",
    env_text,
)
if not match:
    print("DATABASE_URL not found", file=sys.stderr)
    sys.exit(1)

user, password, host, port, db = match.groups()
print(f"restoring into {host}/{db}")

env = os.environ.copy()
env["PGPASSWORD"] = password
cmd = [
    "pg_restore",
    "-h",
    host,
    "-p",
    port,
    "-U",
    user,
    "-d",
    db,
    "--clean",
    "--if-exists",
    "--no-owner",
    "--no-acl",
    "/home/ubuntu/waheed_db_backup.dump",
]
result = subprocess.run(cmd, env=env)
print("exit", result.returncode)
sys.exit(0 if result.returncode in (0, 1) else result.returncode)
