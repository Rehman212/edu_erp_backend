const { Pool } = require('pg');
const fs = require('fs');

const url = fs
  .readFileSync(require('path').join(__dirname, '..', '.env'), 'utf8')
  .match(/DATABASE_URL=(.+)/)[1]
  .trim();

const pool = new Pool({ connectionString: url });

async function main() {
  const size = await pool.query(
    'select pg_size_pretty(pg_database_size(current_database())) as size',
  );
  const tables = await pool.query(
    "select count(*)::int as tables from information_schema.tables where table_schema='public'",
  );
  const admin = await pool.query(
    "select tname, length(passwd) as pass_len from puser where upper(trim(tname))='ESS_ADMN'",
  );
  console.log(JSON.stringify({ size: size.rows[0], tables: tables.rows[0], admin: admin.rows }, null, 2));
  await pool.end();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
