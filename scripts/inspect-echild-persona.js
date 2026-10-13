require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const persona = await pool.query(`
    SELECT count(*)::int AS n,
           count(*) FILTER (WHERE coalesce(trim(nid),'') <> '')::int AS with_nid,
           count(*) FILTER (WHERE coalesce(trim(ecode),'') <> '')::int AS with_ecode
    FROM persona
  `);
  console.log('PERSONA', persona.rows[0]);

  const sample = await pool.query(`
    SELECT ecode, ename, fname, design, nid, phone, zcode, statu
    FROM persona
    WHERE coalesce(trim(nid),'') <> ''
    LIMIT 5
  `);
  console.log('PERSONA_SAMPLE', sample.rows);

  const matched = await pool.query(`
    SELECT count(*)::int AS matched_active_echild
    FROM student s
    INNER JOIN persona p
      ON regexp_replace(coalesce(trim(p.nid), ''), '\\D', '', 'g')
       = coalesce(nullif(s.fnic_norm, ''), regexp_replace(coalesce(trim(s.fnic), ''), '\\D', '', 'g'))
    WHERE upper(trim(s.relation)) = 'ECHILD'
      AND trim(s.stat) = 'Active'
      AND length(regexp_replace(coalesce(trim(p.nid), ''), '\\D', '', 'g')) >= 10
  `);
  console.log('MATCHED', matched.rows[0]);

  const unmatched = await pool.query(`
    SELECT s.sdno, s.name, s.fname, s.fnic
    FROM student s
    LEFT JOIN persona p
      ON regexp_replace(coalesce(trim(p.nid), ''), '\\D', '', 'g')
       = coalesce(nullif(s.fnic_norm, ''), regexp_replace(coalesce(trim(s.fnic), ''), '\\D', '', 'g'))
      AND length(regexp_replace(coalesce(trim(p.nid), ''), '\\D', '', 'g')) >= 10
    WHERE upper(trim(s.relation)) = 'ECHILD'
      AND trim(s.stat) = 'Active'
      AND p.row_id IS NULL
    ORDER BY s.name
    LIMIT 10
  `);
  console.log('UNMATCHED_SAMPLE', unmatched.rows);

  const hit = await pool.query(`
    SELECT s.sdno, s.name, s.fname, s.fnic, p.ecode, p.ename, p.design
    FROM student s
    INNER JOIN persona p
      ON regexp_replace(coalesce(trim(p.nid), ''), '\\D', '', 'g')
       = coalesce(nullif(s.fnic_norm, ''), regexp_replace(coalesce(trim(s.fnic), ''), '\\D', '', 'g'))
    WHERE upper(trim(s.relation)) = 'ECHILD'
      AND trim(s.stat) = 'Active'
    ORDER BY s.name
    LIMIT 8
  `);
  console.log('MATCH_SAMPLE', hit.rows);

  await pool.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
