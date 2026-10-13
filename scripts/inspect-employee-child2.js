require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const tables = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' ORDER BY table_name
  `);
  console.log('ALL_TABLES', tables.rows.map((r) => r.table_name).join(', '));

  const occ = await pool.query(`
    SELECT coalesce(nullif(trim(occupat), ''), '(blank)') AS occupat, count(*)::int AS n
    FROM student
    WHERE trim(stat) = 'Active'
    GROUP BY 1
    ORDER BY n DESC
    LIMIT 40
  `);
  console.log('OCCUPAT_ACTIVE', occ.rows);

  const relation = await pool.query(`
    SELECT coalesce(nullif(trim(relation), ''), '(blank)') AS relation, count(*)::int AS n
    FROM student
    WHERE trim(stat) = 'Active'
    GROUP BY 1
    ORDER BY n DESC
    LIMIT 30
  `);
  console.log('RELATION_ACTIVE', relation.rows);

  // Look for employee-like keywords in text columns
  const hits = await pool.query(`
    SELECT
      count(*) FILTER (WHERE lower(coalesce(occupat,'')) LIKE '%emp%')::int AS occ_emp,
      count(*) FILTER (WHERE lower(coalesce(occupat,'')) LIKE '%staff%')::int AS occ_staff,
      count(*) FILTER (WHERE lower(coalesce(occupat,'')) LIKE '%teacher%')::int AS occ_teacher,
      count(*) FILTER (WHERE lower(coalesce(gaurdian,'')) LIKE '%emp%')::int AS g_emp,
      count(*) FILTER (WHERE lower(coalesce(sumpack,'')) LIKE '%emp%')::int AS sum_emp,
      count(*) FILTER (WHERE lower(coalesce(clevel,'')) LIKE '%emp%')::int AS clevel_emp
    FROM student
    WHERE trim(stat) = 'Active'
  `);
  console.log('KEYWORD_HITS', hits.rows[0]);

  const occEmp = await pool.query(`
    SELECT trim(occupat) AS occupat, count(*)::int AS n
    FROM student
    WHERE trim(stat) = 'Active'
      AND (
        lower(occupat) LIKE '%emp%'
        OR lower(occupat) LIKE '%staff%'
        OR lower(occupat) LIKE '%teacher%'
        OR lower(occupat) LIKE '%faculty%'
      )
    GROUP BY 1
    ORDER BY n DESC
    LIMIT 30
  `);
  console.log('OCC_EMP_LIKE', occEmp.rows);

  // Fee fields that might indicate staff concession
  for (const col of ['adfee', 'tfee', 'anualfee', 'transfee', 'lunchfee', 'security', 'regfee', 'migfee']) {
    const r = await pool.query(`
      SELECT coalesce(nullif(trim(${col}), ''), '(blank)') AS v, count(*)::int AS n
      FROM student
      WHERE trim(stat) = 'Active'
      GROUP BY 1
      ORDER BY n DESC
      LIMIT 8
    `);
    console.log(col.toUpperCase(), r.rows);
  }

  await pool.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
