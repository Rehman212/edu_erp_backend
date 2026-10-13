-- Speed up Inventory Control stock reports, item ledger, Excel/PDF fetch.
-- Matches Nest queries that join/filter on trim(...) of legacy ESS columns.
-- Safe to re-run (IF NOT EXISTS).

-- ── Purchase movements (stock In / adjustments) ─────────────────────────────

-- Join: purdet ↔ purmast on trim(invno)
CREATE INDEX IF NOT EXISTS idx_purdet_invno_trim
  ON purdet (trim(invno));

-- Group / filter by item code
CREATE INDEX IF NOT EXISTS idx_purdet_itemno_trim
  ON purdet (trim(itemno));

-- Item ledger: trim(itemno) = $code then join mast
CREATE INDEX IF NOT EXISTS idx_purdet_itemno_invno_trim
  ON purdet (trim(itemno), trim(invno));

CREATE INDEX IF NOT EXISTS idx_purmast_invno_trim
  ON purmast (trim(invno));

-- Site / campus scope: trim(ccode) LIKE '14%'
CREATE INDEX IF NOT EXISTS idx_purmast_ccode_trim
  ON purmast (trim(ccode));

-- Date period filters (invdate stored as text YYYY-MM-DD)
CREATE INDEX IF NOT EXISTS idx_purmast_invdate_trim
  ON purmast (trim(invdate));

-- Site + date together (common report filter)
CREATE INDEX IF NOT EXISTS idx_purmast_ccode_invdate_trim
  ON purmast (trim(ccode), trim(invdate));

-- ── Sales movements (qty out against stock) ─────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_saldet_invno_trim
  ON saldet (trim(invno));

CREATE INDEX IF NOT EXISTS idx_saldet_itemno_trim
  ON saldet (trim(itemno));

CREATE INDEX IF NOT EXISTS idx_saldet_itemno_invno_trim
  ON saldet (trim(itemno), trim(invno));

CREATE INDEX IF NOT EXISTS idx_salmast_invno_trim
  ON salmast (trim(invno));

-- Site on sales: coalesce(wcode, pcode)
CREATE INDEX IF NOT EXISTS idx_salmast_wcode_trim
  ON salmast (trim(wcode));

CREATE INDEX IF NOT EXISTS idx_salmast_pcode_trim
  ON salmast (trim(pcode));

-- ── Item master lookups ─────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_item_itemcode_trim
  ON item (trim(itemcode));

-- Category / head rows (blank uom, short codes) used in drill-down + labels
CREATE INDEX IF NOT EXISTS idx_item_heads_code_trim
  ON item (trim(itemcode))
  WHERE coalesce(trim(uom), '') = ''
    AND length(trim(itemcode)) BETWEEN 1 AND 4;

-- Name search (Find item…)
CREATE INDEX IF NOT EXISTS idx_item_itemname_trim_lower
  ON item (lower(trim(itemname)));

-- ── Campus names (acc.acode trim already in 001; keep IF NOT EXISTS) ────────

CREATE INDEX IF NOT EXISTS idx_acc_acode_trim
  ON acc (trim(acode));

ANALYZE purdet;
ANALYZE purmast;
ANALYZE saldet;
ANALYZE salmast;
ANALYZE item;
ANALYZE acc;
