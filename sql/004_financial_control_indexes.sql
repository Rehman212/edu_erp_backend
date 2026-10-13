-- Speed up Financial Control trial balance / ledger / fee reports.
-- Avoid expression indexes that wrap columns in trim() — queries use raw columns.

CREATE INDEX IF NOT EXISTS idx_accmast_invdate
  ON accmast (invdate);

CREATE INDEX IF NOT EXISTS idx_accmast_ccode_invdate
  ON accmast (ccode, invdate);

CREATE INDEX IF NOT EXISTS idx_accdet_invno_acode
  ON accdet (invno, acode);

ANALYZE accmast;
ANALYZE accdet;
