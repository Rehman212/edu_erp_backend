-- ERP audit trail: Activity Log + Login/Logout Logs
CREATE TABLE IF NOT EXISTS erp_audit_log (
  id              bigserial PRIMARY KEY,
  category        text NOT NULL DEFAULT 'activity',
  username        text NOT NULL DEFAULT '',
  role            text NOT NULL DEFAULT '',
  activity        text NOT NULL DEFAULT '',
  description     text NOT NULL DEFAULT '',
  module          text NOT NULL DEFAULT '',
  campus          text NOT NULL DEFAULT '',
  campus_code     text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'Success',
  ip_address      text NOT NULL DEFAULT '',
  meta            jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_erp_audit_log_created
  ON erp_audit_log (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_erp_audit_log_category_created
  ON erp_audit_log (category, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_erp_audit_log_username
  ON erp_audit_log (lower(trim(username)));

CREATE INDEX IF NOT EXISTS idx_erp_audit_log_activity
  ON erp_audit_log (activity);

ANALYZE erp_audit_log;
