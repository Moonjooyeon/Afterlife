
CREATE TABLE IF NOT EXISTS app_users (
  id TEXT PRIMARY KEY,
  login_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  order_id TEXT UNIQUE,
  provider TEXT NOT NULL,
  sku TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL DEFAULT 0,
  credits INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_user ON purchase_orders (user_id);

CREATE TABLE IF NOT EXISTS access_passes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  order_id TEXT,
  status TEXT NOT NULL,
  usage_limit INTEGER NOT NULL,
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_access_passes_user ON access_passes (user_id, status);

CREATE TABLE IF NOT EXISTS usage_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  access_pass_id TEXT,
  charge_key TEXT UNIQUE,
  mode TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_sessions_user ON usage_sessions (user_id, started_at);

CREATE TABLE IF NOT EXISTS access_pass_charges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  access_pass_id TEXT NOT NULL,
  session_id TEXT,
  charge_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_access_pass_charges_user ON access_pass_charges (user_id, created_at);

CREATE TABLE IF NOT EXISTS gemini_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  session_id TEXT,
  key_mode TEXT NOT NULL DEFAULT '',
  requested_model TEXT NOT NULL DEFAULT '',
  actual_model TEXT NOT NULL DEFAULT '',
  attempt INTEGER NOT NULL DEFAULT 1,
  ok INTEGER,
  status INTEGER,
  error_message TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_gemini_requests_session ON gemini_requests (session_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  ip_hash TEXT,
  user_agent_hash TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs (action, created_at);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE app_users ADD COLUMN IF NOT EXISTS last_login_at TEXT;
ALTER TABLE usage_sessions ADD COLUMN IF NOT EXISTS result TEXT;
ALTER TABLE usage_sessions ADD COLUMN IF NOT EXISTS result_saved_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS access_passes_order_unique ON access_passes(order_id);
