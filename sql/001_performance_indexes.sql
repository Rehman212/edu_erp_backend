-- Speed up Result Analysis student lists, strength, and sibling reports.
-- Safe to re-run (IF NOT EXISTS / guarded backfill).

-- Normalized father NIC for sibling matching (digits only).
ALTER TABLE student
  ADD COLUMN IF NOT EXISTS fnic_norm text;

UPDATE student
SET fnic_norm = regexp_replace(coalesce(trim(fnic), ''), '\D', '', 'g')
WHERE fnic_norm IS NULL
   OR fnic_norm IS DISTINCT FROM regexp_replace(coalesce(trim(fnic), ''), '\D', '', 'g');

-- Core list filters: status + campus prefix / equality.
CREATE INDEX IF NOT EXISTS idx_student_stat_ccode
  ON student (stat, ccode);

-- Strength classwise grouping.
CREATE INDEX IF NOT EXISTS idx_student_ccode_class_sec
  ON student (ccode, class, sec);

-- Status-only scans / FILTER aggregates.
CREATE INDEX IF NOT EXISTS idx_student_stat
  ON student (stat);

-- Sibling groups: active students with usable NIC.
CREATE INDEX IF NOT EXISTS idx_student_fnic_norm
  ON student (fnic_norm)
  WHERE length(fnic_norm) >= 10;

CREATE INDEX IF NOT EXISTS idx_student_active_fnic_norm
  ON student (fnic_norm)
  WHERE stat = 'Active' AND length(fnic_norm) >= 10;

-- Campus / class / section name lookups (acc.acode already indexed; keep trim-safe expression too).
CREATE INDEX IF NOT EXISTS idx_acc_acode_trim
  ON acc (trim(acode));

ANALYZE student;
ANALYZE acc;
