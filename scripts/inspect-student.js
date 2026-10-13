require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const cols = await pool.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'student'
    ORDER BY ordinal_position
  `);
  console.log(
    'STUDENT_COLS',
    cols.rows.map((r) => `${r.column_name}:${r.data_type}`).join(', '),
  );

  const idx = await pool.query(`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE tablename IN ('student', 'acc')
    ORDER BY tablename, indexname
  `);
  console.log('INDEXES');
  for (const row of idx.rows) {
    console.log(`${row.indexname}: ${row.indexdef}`);
  }

  const sample = await pool.query(`
    SELECT count(*)::int AS n,
           count(*) FILTER (
             WHERE length(regexp_replace(coalesce(trim(fnic), ''), '\\D', '', 'g')) >= 10
           )::int AS with_nic,
           count(*) FILTER (WHERE trim(stat) = 'Active')::int AS active
    FROM student
  `);
  console.log('COUNTS', sample.rows[0]);

  const sib = await pool.query(`
    SELECT count(*)::int AS sibling_groups
    FROM (
      SELECT regexp_replace(coalesce(trim(fnic), ''), '\\D', '', 'g') AS k
      FROM student
      WHERE trim(stat) = 'Active'
        AND length(regexp_replace(coalesce(trim(fnic), ''), '\\D', '', 'g')) >= 10
      GROUP BY 1
      HAVING count(*) > 1
    ) t
  `);
  console.log('SIBLING_GROUPS', sib.rows[0]);

  await pool.end();
})().catch((err) => {
  console.error('ERR', err.message);
  process.exit(1);
});
