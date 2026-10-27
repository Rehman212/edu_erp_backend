-- Speed up Financial Control trial balance / ledger / fee reports.
-- Avoid expression indexes that wrap columns in trim() — queries use raw columns.

CREATE INDEX IF NOT EXISTS idx_accmast_invdate
  ON accmast (invdate);

CREATE INDEX IF NOT EXISTS idx_accmast_ccode_invdate
  ON accmast (ccode, invdate);

CREATE INDEX IF NOT EXISTS idx_accdet_invno_acode
  ON accdet (invno, acode);

-- English collation cannot use a normal btree for LIKE '1506%'.
-- text_pattern_ops supports those prefix lookups (cash flow, one account).
CREATE INDEX IF NOT EXISTS idx_accdet_acode_pattern
  ON accdet (acode text_pattern_ops, invno);

ANALYZE accmast;
ANALYZE accdet;
