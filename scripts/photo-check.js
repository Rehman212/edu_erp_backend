const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const url = fs
  .readFileSync(path.join(__dirname, '..', '.env'), 'utf8')
  .match(/DATABASE_URL=(.+)/)[1]
  .trim();

const pool = new Pool({ connectionString: url });

async function check(table) {
  const result = await pool.query(`
    select
      count(*)::int as total,
      count(*) filter (where photo is not null and trim(photo) <> '')::int as with_photo,
      coalesce(max(length(photo)) filter (where photo is not null and trim(photo) <> ''), 0)::int as max_len,
      left(
        max(photo) filter (where photo is not null and trim(photo) <> ''),
        100
      ) as sample
    from ${table}
  `);
  console.log(table, result.rows[0]);
}

async function main() {
  await check('student');
  await check('persona');
  await pool.end();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
