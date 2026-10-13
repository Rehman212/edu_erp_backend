require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const sql = `
    SELECT count(*)::int AS total
    FROM student s
    INNER JOIN (
      SELECT st.fnic_norm AS fnic_key,
             count(*)::int AS sibling_count
      FROM student st
      WHERE st.stat = 'Active'
        AND st.ccode LIKE $1
        AND length(st.fnic_norm) >= 10
      GROUP BY st.fnic_norm
      HAVING count(*) > 1
    ) sib ON s.fnic_norm = sib.fnic_key
    WHERE s.ccode LIKE $1
      AND s.stat = 'Active'
  `;

  const t0 = Date.now();
  const r = await pool.query(sql, ['14%']);
  console.log({ total: r.rows[0].total, ms: Date.now() - t0 });

  await pool.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
