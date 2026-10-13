require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const sqlPath = path.join(__dirname, '..', 'sql', '001_performance_indexes.sql');

(async () => {
  const sql = fs.readFileSync(sqlPath, 'utf8');
  console.log('Applying', sqlPath);
  const started = Date.now();
  await pool.query(sql);
  console.log(`Done in ${Date.now() - started}ms`);

  const idx = await pool.query(`
    SELECT indexname
    FROM pg_indexes
    WHERE tablename IN ('student', 'acc')
      AND indexname LIKE 'idx_%'
    ORDER BY indexname
  `);
  console.log(
    'New indexes:',
    idx.rows.map((r) => r.indexname).join(', ') || '(none)',
  );

  const sample = await pool.query(`
    SELECT
      count(*) FILTER (WHERE fnic_norm IS NOT NULL AND fnic_norm <> '')::int AS with_fnic_norm,
      count(*) FILTER (WHERE length(fnic_norm) >= 10)::int AS usable_nic
    FROM student
  `);
  console.log('fnic_norm', sample.rows[0]);

  const sib = await pool.query(`
    SELECT count(*)::int AS sibling_groups
    FROM (
      SELECT fnic_norm
      FROM student
      WHERE stat = 'Active'
        AND ccode LIKE '14%'
        AND length(fnic_norm) >= 10
      GROUP BY fnic_norm
      HAVING count(*) > 1
    ) t
  `);
  console.log('sibling_groups_fast', sib.rows[0]);

  await pool.end();
})().catch((err) => {
  console.error('ERR', err.message);
  process.exit(1);
});
