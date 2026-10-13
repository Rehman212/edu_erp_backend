require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const s = await pool.query(`
    SELECT
      count(*) FILTER (WHERE ccode IS DISTINCT FROM trim(ccode))::int AS ccode_pad,
      count(*) FILTER (WHERE class IS DISTINCT FROM trim(class))::int AS class_pad,
      count(*) FILTER (WHERE sec IS DISTINCT FROM trim(sec))::int AS sec_pad,
      count(*) FILTER (WHERE stat IS DISTINCT FROM trim(stat))::int AS stat_pad,
      count(*) FILTER (WHERE fnic IS DISTINCT FROM trim(fnic))::int AS fnic_pad
    FROM student
  `);
  const a = await pool.query(`
    SELECT count(*) FILTER (WHERE acode::text IS DISTINCT FROM trim(acode::text))::int AS acode_pad
    FROM acc
  `);
  console.log('STUDENT_PAD', s.rows[0]);
  console.log('ACC_PAD', a.rows[0]);

  const scope = await pool.query(`
    SELECT count(*)::int AS n
    FROM (
      SELECT regexp_replace(coalesce(trim(fnic), ''), '\\D', '', 'g') AS k
      FROM student
      WHERE trim(stat) = 'Active'
        AND trim(ccode) LIKE '14%'
        AND length(regexp_replace(coalesce(trim(fnic), ''), '\\D', '', 'g')) >= 10
      GROUP BY 1
      HAVING count(*) > 1
    ) t
  `);
  console.log('SIBLING_GROUPS_14', scope.rows[0]);

  await pool.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
