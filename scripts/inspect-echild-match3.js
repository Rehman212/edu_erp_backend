require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const r = await pool.query(`
    WITH echild AS (
      SELECT s.row_id, s.sdno, s.name, s.fname, s.fnic_norm
      FROM student s
      WHERE upper(trim(s.relation)) = 'ECHILD' AND s.stat = 'Active'
    ),
    hits AS (
      SELECT DISTINCT ON (e.row_id)
        e.row_id,
        p.ecode,
        p.ename,
        p.design,
        CASE
          WHEN length(e.fnic_norm) >= 10
            AND regexp_replace(coalesce(trim(p.nid), ''), '\\D', '', 'g') = e.fnic_norm THEN 1
          WHEN upper(trim(p.ename)) = upper(trim(e.fname)) THEN 2
          WHEN upper(trim(p.fname)) = upper(trim(e.fname)) THEN 3
          ELSE 9
        END AS rank
      FROM echild e
      JOIN persona p ON coalesce(trim(p.ecode), '') <> ''
        AND (
          (
            length(e.fnic_norm) >= 10
            AND regexp_replace(coalesce(trim(p.nid), ''), '\\D', '', 'g') = e.fnic_norm
          )
          OR upper(trim(p.ename)) = upper(trim(e.fname))
          OR (
            coalesce(trim(e.fname), '') <> ''
            AND upper(trim(p.fname)) = upper(trim(e.fname))
          )
        )
      ORDER BY e.row_id, rank, p.ecode
    )
    SELECT
      (SELECT count(*) FROM echild) AS echild_n,
      count(*)::int AS matched,
      count(*) FILTER (WHERE rank = 1)::int AS by_nic,
      count(*) FILTER (WHERE rank = 2)::int AS by_ename,
      count(*) FILTER (WHERE rank = 3)::int AS by_emp_father
    FROM hits
  `);
  console.log(r.rows[0]);

  const miss = await pool.query(`
    WITH echild AS (
      SELECT s.row_id, s.sdno, s.name, s.fname, s.fnic_norm
      FROM student s
      WHERE upper(trim(s.relation)) = 'ECHILD' AND s.stat = 'Active'
    ),
    hits AS (
      SELECT DISTINCT ON (e.row_id) e.row_id
      FROM echild e
      JOIN persona p ON coalesce(trim(p.ecode), '') <> ''
        AND (
          (
            length(e.fnic_norm) >= 10
            AND regexp_replace(coalesce(trim(p.nid), ''), '\\D', '', 'g') = e.fnic_norm
          )
          OR upper(trim(p.ename)) = upper(trim(e.fname))
          OR (
            coalesce(trim(e.fname), '') <> ''
            AND upper(trim(p.fname)) = upper(trim(e.fname))
          )
        )
      ORDER BY e.row_id
    )
    SELECT e.sdno, e.name, e.fname
    FROM echild e
    LEFT JOIN hits h ON h.row_id = e.row_id
    WHERE h.row_id IS NULL
    ORDER BY e.name
    LIMIT 15
  `);
  console.log('STILL_MISSING', miss.rows.length, miss.rows.slice(0, 8));

  await pool.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
