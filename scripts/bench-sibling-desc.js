require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const sql = `
    SELECT trim(s.name) AS name, trim(s.adate) AS adate, s.fnic_norm
    FROM student s
    INNER JOIN (
      SELECT st.fnic_norm AS fnic_key,
             max(
               CASE
                 WHEN trim(st.adate) ~ '^\\d{4}-\\d{2}-\\d{2}' THEN trim(st.adate)::timestamp
                 ELSE NULL
               END
             ) AS latest_adate
      FROM student st
      WHERE st.stat = 'Active'
        AND st.ccode LIKE $1
        AND length(st.fnic_norm) >= 10
      GROUP BY st.fnic_norm
      HAVING count(*) > 1
    ) sib ON s.fnic_norm = sib.fnic_key
    WHERE s.ccode LIKE $1
      AND s.stat = 'Active'
    ORDER BY sib.latest_adate DESC NULLS LAST, s.fnic_norm,
      CASE WHEN trim(s.adate) ~ '^\\d{4}-\\d{2}-\\d{2}' THEN trim(s.adate)::timestamp ELSE NULL END DESC NULLS LAST,
      trim(s.name)
    LIMIT 12
  `;
  const t0 = Date.now();
  const r = await pool.query(sql, ['14%']);
  console.log('ms', Date.now() - t0);
  console.log(r.rows);
  await pool.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
