require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  // Sample EChild rows with parent-ish fields
  const sample = await pool.query(`
    SELECT sdno, name, fname, fnic, gaurdian, relation, occupat, cellno, rphone, ophone
    FROM student
    WHERE upper(trim(relation)) = 'ECHILD' AND trim(stat) = 'Active'
    ORDER BY name
    LIMIT 8
  `);
  console.log('ECHILD_SAMPLE');
  console.log(JSON.stringify(sample.rows, null, 2));

  // Salary / employee tables columns
  for (const table of ['salary', 'salaryd', 'salarym', 'saldet', 'salmast', 'persona', 'puser', 'stud', 'stud1']) {
    const cols = await pool.query(
      `
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `,
      [table],
    );
    if (cols.rows.length) {
      console.log(
        `\n${table.toUpperCase()}`,
        cols.rows.map((r) => `${r.column_name}:${r.data_type}`).join(', '),
      );
    }
  }

  // Try match EChild father NIC to salary-like tables
  const nicCols = await pool.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND (
        column_name ILIKE '%nic%'
        OR column_name ILIKE '%cnic%'
        OR column_name ILIKE '%empid%'
        OR column_name ILIKE '%empno%'
        OR column_name ILIKE '%ecode%'
        OR column_name ILIKE '%eno%'
      )
    ORDER BY table_name, column_name
  `);
  console.log('\nNIC_EMP_COLS');
  for (const row of nicCols.rows) console.log(`${row.table_name}.${row.column_name}`);

  await pool.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
