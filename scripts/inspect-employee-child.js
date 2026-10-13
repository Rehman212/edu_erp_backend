require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const tables = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND (
        table_name ILIKE '%emp%'
        OR table_name ILIKE '%child%'
        OR table_name ILIKE '%staff%'
        OR table_name ILIKE '%puser%'
        OR table_name ILIKE '%employee%'
      )
    ORDER BY table_name
  `);
  console.log('TABLES', tables.rows.map((r) => r.table_name));

  const cols = await pool.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND (
        column_name ILIKE '%emp%'
        OR column_name ILIKE '%child%'
        OR column_name ILIKE '%staff%'
        OR column_name ILIKE '%echild%'
        OR column_name ILIKE '%dpj%'
        OR column_name ILIKE '%atyp%'
      )
    ORDER BY table_name, column_name
  `);
  console.log('COLS');
  for (const row of cols.rows) {
    console.log(`${row.table_name}.${row.column_name}`);
  }

  // Sample distinct values that might flag employee children
  const samples = await pool.query(`
    SELECT
      count(*) FILTER (WHERE coalesce(trim(atyp), '') <> '')::int AS with_atyp,
      count(*) FILTER (WHERE coalesce(trim(dpj), '') <> '')::int AS with_dpj,
      count(*) FILTER (WHERE coalesce(trim(sumpack), '') <> '')::int AS with_sumpack
    FROM student
  `);
  console.log('STUDENT_FLAGS', samples.rows[0]);

  const atyp = await pool.query(`
    SELECT coalesce(nullif(trim(atyp), ''), '(blank)') AS atyp, count(*)::int AS n
    FROM student
    GROUP BY 1
    ORDER BY n DESC
    LIMIT 20
  `);
  console.log('ATYP', atyp.rows);

  const dpj = await pool.query(`
    SELECT coalesce(nullif(trim(dpj), ''), '(blank)') AS dpj, count(*)::int AS n
    FROM student
    GROUP BY 1
    ORDER BY n DESC
    LIMIT 20
  `);
  console.log('DPJ', dpj.rows);

  await pool.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
