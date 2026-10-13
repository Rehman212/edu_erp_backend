require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { Pool } = require("pg");

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const r = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND (
        table_name ILIKE '%log%'
        OR table_name ILIKE '%audit%'
        OR table_name ILIKE '%hist%'
      )
    ORDER BY 1
  `);
  console.log(r.rows.map((x) => x.table_name).join("\n") || "(none)");
  await pool.end();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
