require("dotenv").config();
const { Pool } = require("pg");
const p = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const r = await p.query(
    `SELECT invno, ccode, invdate, narp, pcode, dparty, discount, pinv, pday
     FROM purmast WHERE trim(invno) = '000627P'`,
  );
  console.log("000627P rows:", r.rows);
  const last = await p.query(
    `SELECT trim(invno) invno, trim(narp) narp, trim(ccode) ccode
     FROM purmast ORDER BY row_id DESC LIMIT 5`,
  );
  console.log("latest:", last.rows);
  await p.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
