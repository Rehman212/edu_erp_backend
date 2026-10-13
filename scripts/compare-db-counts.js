const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const localUrl = fs
  .readFileSync(path.join(__dirname, '..', '.env'), 'utf8')
  .match(/DATABASE_URL=(.+)/)[1]
  .trim();

const sql = `
select table_name
from information_schema.tables
where table_schema = 'public' and table_type = 'BASE TABLE'
order by table_name
`;

async function counts(pool) {
  const tables = await pool.query(sql);
  const out = {};
  for (const row of tables.rows) {
    const name = row.table_name;
    const result = await pool.query(`select count(*)::bigint as c from "${name}"`);
    out[name] = Number(result.rows[0].c);
  }
  return out;
}

async function main() {
  const local = new Pool({ connectionString: localUrl });
  const localCounts = await counts(local);
  await local.end();

  const payload = {
    localCounts,
    tableCount: Object.keys(localCounts).length,
    totalRows: Object.values(localCounts).reduce((a, b) => a + b, 0),
  };
  fs.writeFileSync(path.join(__dirname, 'local-counts.json'), JSON.stringify(payload, null, 2));
  console.log(JSON.stringify({ tableCount: payload.tableCount, totalRows: payload.totalRows }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
