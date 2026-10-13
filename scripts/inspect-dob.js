require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const r = await pool.query(`
    SELECT name, sdno, adate, dob, ldate, fname
    FROM student
    WHERE trim(name) ILIKE ANY(ARRAY[
      'UME HANI%',
      'UME ROMAN%',
      'MUHAMMAD AREJ%',
      'ABU ZAR%',
      'FALAK ZAHRA%',
      'NAVEERA BATOOL%'
    ])
    ORDER BY name
  `);
  console.log(JSON.stringify(r.rows, null, 2));

  const weird = await pool.query(`
    SELECT count(*)::int AS n,
           count(*) FILTER (
             WHERE trim(dob) ~ '^\\d{4}-\\d{2}-\\d{2}'
               AND trim(adate) ~ '^\\d{4}-\\d{2}-\\d{2}'
               AND trim(dob)::timestamp > trim(adate)::timestamp
           )::int AS dob_after_adate,
           count(*) FILTER (
             WHERE trim(dob) ~ '^\\d{4}-\\d{2}-\\d{2}'
               AND trim(dob)::date > CURRENT_DATE
           )::int AS future_dob,
           count(*) FILTER (
             WHERE coalesce(trim(dob),'') <> ''
               AND trim(dob) = trim(adate)
           )::int AS same_as_adate
    FROM student
    WHERE trim(stat) = 'Active'
  `);
  console.log('ACTIVE_WEIRD', weird.rows[0]);

  const samples = await pool.query(`
    SELECT name, adate, dob
    FROM student
    WHERE trim(stat) = 'Active'
      AND trim(dob) ~ '^\\d{4}-\\d{2}-\\d{2}'
      AND trim(dob)::date > CURRENT_DATE
    ORDER BY dob DESC
    LIMIT 10
  `);
  console.log('FUTURE_DOB_SAMPLES', samples.rows);

  await pool.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
