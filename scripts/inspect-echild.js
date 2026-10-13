require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const r = await pool.query(`
    SELECT trim(stat) AS stat, count(*)::int AS n
    FROM student
    WHERE upper(trim(relation)) = 'ECHILD'
    GROUP BY 1
    ORDER BY n DESC
  `);
  console.log('ECHILD_BY_STAT', r.rows);

  const sample = await pool.query(`
    SELECT sdno, name, fname, relation, stat, ccode
    FROM student
    WHERE upper(trim(relation)) = 'ECHILD' AND trim(stat) = 'Active'
    ORDER BY name
    LIMIT 5
  `);
  console.log('SAMPLE', sample.rows);
  await pool.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
