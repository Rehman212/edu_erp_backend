#!/usr/bin/env python3
import os
import re
import subprocess
import urllib.request

env_text = open("/home/ubuntu/edu_erp_backend/.env", encoding="utf-8").read()
match = re.search(
    r"DATABASE_URL=postgresql://([^:]+):([^@]+)@([^:/]+):(\d+)/([^\s]+)",
    env_text,
)
user, password, host, port, db = match.groups()
os.environ["PGPASSWORD"] = password
sql = (
    "select current_database() as db, "
    "(select count(*) from puser) as users, "
    "(select count(*) from information_schema.tables where table_schema='public') as tables;"
)
subprocess.run(
    ["psql", "-h", host, "-p", port, "-U", user, "-d", db, "-c", sql],
    check=True,
)

req = urllib.request.Request(
    "http://127.0.0.1/api/auth/login",
    data=b'{"username":"ESS_ADMN","password":"PTI2024"}',
    headers={"Content-Type": "application/json"},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=20) as resp:
        print("login_status", resp.status)
        print(resp.read()[:500].decode())
except Exception as err:
    print("login_error", err)
    if hasattr(err, "read"):
        print(err.read()[:500].decode())
