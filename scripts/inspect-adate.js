require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const r = await pool.query(`
    SELECT coalesce(nullif(trim(adate), ''), '(blank)') AS adate, count(*)::int AS n
    FROM student
    WHERE upper(trim(relation)) = 'ECHILD' AND trim(stat) = 'Active'
    GROUP BY 1
    ORDER BY n DESC
    LIMIT 25
  `);
  console.log(r.rows);

  const sample = await pool.query(`
    SELECT name, adate, row_id
    FROM student
    WHERE upper(trim(relation)) = 'ECHILD' AND trim(stat) = 'Active'
    ORDER BY row_id DESC
    LIMIT 10
  `);
  console.log('BY_ROWID', sample.rows);
  await pool.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
