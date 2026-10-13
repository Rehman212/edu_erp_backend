require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

async function main() {
  const sqlPath = path.join(__dirname, "002_inventory_performance_indexes.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");
  if (!process.env.DATABASE_URL) {
    console.error("FAIL: DATABASE_URL missing");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(sql);
    console.log("OK: inventory indexes applied");
    const r = await pool.query(
      `SELECT indexname
       FROM pg_indexes
       WHERE indexname LIKE 'idx_pur%'
          OR indexname LIKE 'idx_sal%'
          OR indexname LIKE 'idx_item%'
          OR indexname = 'idx_acc_acode_trim'
       ORDER BY 1`,
    );
    for (const row of r.rows) console.log(row.indexname);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
