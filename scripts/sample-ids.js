require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const r = await pool.query(`
    SELECT sdno, rollno, name
    FROM student
    WHERE name ILIKE 'Aabish%' OR name ILIKE 'AAHIL HASSAN%'
    LIMIT 5
  `);
  console.log(JSON.stringify(r.rows, null, 2));
  const empty = await pool.query(`
    SELECT
      count(*) FILTER (WHERE coalesce(trim(rollno), '') = '')::int AS empty_roll,
      count(*) FILTER (WHERE coalesce(trim(sdno), '') <> '')::int AS with_sdno
    FROM student
  `);
  console.log(empty.rows[0]);
  await pool.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
