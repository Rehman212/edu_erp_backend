require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  // Prefer NIC match; also try employee name = father name
  const q = `
    WITH echild AS (
      SELECT s.row_id, s.sdno, s.name, s.fname, s.fnic, s.fnic_norm
      FROM student s
      WHERE upper(trim(s.relation)) = 'ECHILD' AND trim(s.stat) = 'Active'
    ),
    emp AS (
      SELECT
        p.ecode,
        p.ename,
        p.fname AS emp_fname,
        p.design,
        regexp_replace(coalesce(trim(p.nid), ''), '\\D', '', 'g') AS nid_norm
      FROM persona p
      WHERE coalesce(trim(p.ecode), '') <> ''
    ),
    nic_hit AS (
      SELECT e.row_id, emp.ecode, emp.ename, emp.design, 'nic'::text AS how
      FROM echild e
      JOIN emp ON emp.nid_norm = e.fnic_norm AND length(e.fnic_norm) >= 10
    ),
    name_hit AS (
      SELECT e.row_id, emp.ecode, emp.ename, emp.design, 'name'::text AS how
      FROM echild e
      JOIN emp ON upper(trim(emp.ename)) = upper(trim(e.fname))
      WHERE NOT EXISTS (SELECT 1 FROM nic_hit n WHERE n.row_id = e.row_id)
    ),
    all_hit AS (
      SELECT * FROM nic_hit
      UNION ALL
      SELECT * FROM name_hit
    )
    SELECT
      (SELECT count(*) FROM echild) AS echild_n,
      (SELECT count(DISTINCT row_id) FROM all_hit) AS matched_students,
      (SELECT count(*) FROM nic_hit) AS nic_rows,
      (SELECT count(*) FROM name_hit) AS name_rows
  `;
  const summary = await pool.query(q);
  console.log('SUMMARY', summary.rows[0]);

  const samples = await pool.query(`
    WITH echild AS (
      SELECT s.row_id, s.sdno, s.name, s.fname, s.fnic, s.fnic_norm
      FROM student s
      WHERE upper(trim(s.relation)) = 'ECHILD' AND trim(s.stat) = 'Active'
    ),
    emp AS (
      SELECT
        p.ecode,
        p.ename,
        p.design,
        regexp_replace(coalesce(trim(p.nid), ''), '\\D', '', 'g') AS nid_norm
      FROM persona p
      WHERE coalesce(trim(p.ecode), '') <> ''
    ),
    nic_hit AS (
      SELECT e.row_id, emp.ecode, emp.ename, emp.design, 'nic'::text AS how
      FROM echild e
      JOIN emp ON emp.nid_norm = e.fnic_norm AND length(e.fnic_norm) >= 10
    ),
    name_hit AS (
      SELECT e.row_id, emp.ecode, emp.ename, emp.design, 'name'::text AS how
      FROM echild e
      JOIN emp ON upper(trim(emp.ename)) = upper(trim(e.fname))
      WHERE NOT EXISTS (SELECT 1 FROM nic_hit n WHERE n.row_id = e.row_id)
    ),
    all_hit AS (
      SELECT * FROM nic_hit
      UNION ALL
      SELECT * FROM name_hit
    )
    SELECT e.sdno, e.name, e.fname, h.ecode, h.ename, h.design, h.how
    FROM echild e
    LEFT JOIN all_hit h ON h.row_id = e.row_id
    ORDER BY e.name
    LIMIT 20
  `);
  console.log('SAMPLES');
  console.log(JSON.stringify(samples.rows, null, 2));

  // Also try: employee father name = student father name (mother employee case)
  const motherCase = await pool.query(`
    SELECT count(DISTINCT s.row_id)::int AS n
    FROM student s
    JOIN persona p ON upper(trim(p.fname)) = upper(trim(s.fname))
    WHERE upper(trim(s.relation)) = 'ECHILD'
      AND trim(s.stat) = 'Active'
      AND coalesce(trim(s.fname),'') <> ''
  `);
  console.log('MATCH_EMP_FATHER_NAME', motherCase.rows[0]);

  await pool.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
