// SQLite 저장소. node:sqlite는 Node 22 내장이라 의존성이 늘지 않는다.
// 테이블 이름은 StarSign과 맞춰 두었다. 나중에 로그인·결제를 붙일 때 그대로 이어 쓴다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

let db = null;
let auditSalt = '';

const SCHEMA = `
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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
`;

export function open(runtimeDir, databasePath) {
  const dbPath = databasePath || path.join(runtimeDir, 'afterlife.sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  ensureColumn('app_users', 'last_login_at', 'TEXT');
  auditSalt = ensureAuditSalt();
  migrateStoreJson(runtimeDir);
  return dbPath;
}

// 이미 만들어진 DB에 컬럼을 덧붙일 때 쓴다.
function ensureColumn(table, column, type) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some(c => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

export const nowIso = () => new Date().toISOString();
export const uuid = () => crypto.randomUUID();

/* ---------------- 설정 ---------------- */

export function getSetting(key) {
  return db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value ?? null;
}

export function setSetting(key, value) {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, String(value), nowIso());
}

// 감사 로그의 IP·UA를 해시할 소금. 없으면 만들어 두고 계속 같은 값을 쓴다.
function ensureAuditSalt() {
  let salt = getSetting('audit_salt');
  if (!salt) {
    salt = crypto.randomBytes(24).toString('hex');
    setSetting('audit_salt', salt);
  }
  return salt;
}

/* ---------------- 사용자 ---------------- */

// loginId는 'device:<uuid>'. 토스 로그인을 붙이면 'toss:<userKey>'로 같은 자리에 들어간다.
export function ensureUser(loginId, displayName = '', meta = {}) {
  const found = db.prepare('SELECT * FROM app_users WHERE login_id = ?').get(loginId);
  if (found) return found;

  const row = {
    id: uuid(),
    login_id: loginId,
    display_name: displayName,
    created_at: nowIso(),
    updated_at: nowIso()
  };
  db.prepare(`
    INSERT INTO app_users (id, login_id, display_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(row.id, row.login_id, row.display_name, row.created_at, row.updated_at);
  audit({ userId: row.id, action: 'user.created', detail: { loginId }, meta });
  return row;
}

export function findUser(loginId) {
  return db.prepare('SELECT * FROM app_users WHERE login_id = ?').get(loginId) || null;
}

export function findUserById(id) {
  if (!id) return null;
  return db.prepare('SELECT * FROM app_users WHERE id = ?').get(id) || null;
}

export function setDisplayName(userId, displayName) {
  db.prepare('UPDATE app_users SET display_name = ?, updated_at = ? WHERE id = ?')
    .run(displayName, nowIso(), userId);
}

export function touchLogin(userId, meta = {}) {
  const at = nowIso();
  db.prepare('UPDATE app_users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(at, at, userId);
  audit({ userId, action: 'user.login', detail: {}, meta });
}

/* ---------------- 주문과 이용권 ---------------- */

export function createOrder({ userId, orderId = null, provider, sku = '', displayName = '', amount = 0, credits, status = 'captured' }) {
  const row = { id: uuid(), created_at: nowIso() };
  db.prepare(`
    INSERT INTO purchase_orders (id, user_id, order_id, provider, sku, display_name, amount, credits, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, userId, orderId, provider, sku, displayName, amount, credits, status, row.created_at);
  return row;
}

export function findOrderByOrderId(orderId) {
  if (!orderId) return null;
  return db.prepare('SELECT * FROM purchase_orders WHERE order_id = ?').get(orderId) || null;
}

// 같은 주문으로 두 번 지급하지 않도록, 주문에 딸린 이용권을 되찾아 온다.
export function findPassByOrder(orderId) {
  if (!orderId) return null;
  return db.prepare('SELECT * FROM access_passes WHERE order_id = ?').get(orderId) || null;
}

export function createPass({ userId, orderId = null, credits, expiresAt = null }) {
  const row = { id: uuid(), created_at: nowIso() };
  db.prepare(`
    INSERT INTO access_passes (id, user_id, order_id, status, usage_limit, used_count, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, 0, ?, ?, ?)
  `).run(row.id, userId, orderId, credits, expiresAt, row.created_at, row.created_at);
  return row;
}

export function activePasses(userId) {
  return db.prepare(`
    SELECT * FROM access_passes
    WHERE user_id = ? AND status = 'active' AND used_count < usage_limit
      AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY created_at ASC
  `).all(userId, nowIso());
}

export function remainingCredits(userId) {
  return activePasses(userId).reduce((sum, pass) => sum + (pass.usage_limit - pass.used_count), 0);
}

export function usedCount(userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM access_pass_charges WHERE user_id = ?').get(userId).n;
}

export function findCharge(chargeKey) {
  if (!chargeKey) return null;
  return db.prepare('SELECT * FROM access_pass_charges WHERE charge_key = ?').get(chargeKey) || null;
}

// 차감과 소진 처리는 한 트랜잭션으로 묶는다.
export function chargePass({ userId, passId, sessionId, chargeKey }) {
  const run = db.prepare('BEGIN IMMEDIATE');
  run.run();
  try {
    const pass = db.prepare('SELECT * FROM access_passes WHERE id = ?').get(passId);
    if (!pass || pass.used_count >= pass.usage_limit) {
      db.prepare('ROLLBACK').run();
      return null;
    }

    const charge = { id: uuid(), created_at: nowIso() };
    db.prepare(`
      INSERT INTO access_pass_charges (id, user_id, access_pass_id, session_id, charge_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(charge.id, userId, passId, sessionId, chargeKey, charge.created_at);

    const usedNext = pass.used_count + 1;
    db.prepare(`
      UPDATE access_passes
      SET used_count = ?, status = ?, updated_at = ?
      WHERE id = ?
    `).run(usedNext, usedNext >= pass.usage_limit ? 'exhausted' : 'active', charge.created_at, passId);

    db.prepare('COMMIT').run();
    return charge;
  } catch (error) {
    db.prepare('ROLLBACK').run();
    throw error;
  }
}

/* ---------------- 생성 세션 ---------------- */

export function startSession({ userId, passId = null, chargeKey = null, mode = '' }) {
  const row = { id: uuid(), started_at: nowIso() };
  db.prepare(`
    INSERT INTO usage_sessions (id, user_id, access_pass_id, charge_key, mode, status, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, 'started', ?, NULL)
  `).run(row.id, userId, passId, chargeKey, mode, row.started_at);
  return row;
}

export function finishSession(sessionId, status) {
  db.prepare('UPDATE usage_sessions SET status = ?, finished_at = ? WHERE id = ?')
    .run(status, nowIso(), sessionId);
}

export function findSessionByChargeKey(chargeKey) {
  if (!chargeKey) return null;
  return db.prepare('SELECT * FROM usage_sessions WHERE charge_key = ?').get(chargeKey) || null;
}

/* ---------------- Gemini 호출 로그 ---------------- */

export function startGeminiRequest({ userId, sessionId, keyMode, requestedModel, actualModel, attempt }) {
  const row = { id: uuid(), started_at: nowIso() };
  db.prepare(`
    INSERT INTO gemini_requests (id, user_id, session_id, key_mode, requested_model, actual_model, attempt, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, userId, sessionId, keyMode, requestedModel, actualModel, attempt, row.started_at);
  return row;
}

export function finishGeminiRequest(id, { ok, status = null, errorMessage = null }) {
  db.prepare('UPDATE gemini_requests SET ok = ?, status = ?, error_message = ?, finished_at = ? WHERE id = ?')
    .run(ok ? 1 : 0, status, errorMessage ? String(errorMessage).slice(0, 500) : null, nowIso(), id);
}

/* ---------------- 감사 로그 ---------------- */

// IP와 User-Agent는 원본을 남기지 않고 소금 친 해시만 남긴다.
export function audit({ userId = null, action, detail = {}, meta = {} }) {
  db.prepare(`
    INSERT INTO audit_logs (user_id, action, detail, ip_hash, user_agent_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    action,
    JSON.stringify(detail).slice(0, 2000),
    hashValue(meta.ip),
    hashValue(meta.userAgent),
    nowIso()
  );
}

export function hashValue(value) {
  if (!value) return null;
  return crypto.createHash('sha256').update(`${auditSalt}:${value}`).digest('hex').slice(0, 32);
}

export function requestMeta(req) {
  return {
    ip: String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '',
    userAgent: String(req.headers['user-agent'] || '')
  };
}

/* ---------------- runtime/store.json 이관 ---------------- */

// 기존 JSON 저장소가 있으면 첫 부팅 때 한 번 옮기고 파일 이름을 바꿔 둔다.
function migrateStoreJson(runtimeDir) {
  const legacyPath = path.join(runtimeDir, 'store.json');
  if (!fs.existsSync(legacyPath)) return;

  let legacy;
  try {
    legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
  } catch (error) {
    console.warn(`[db] store.json을 읽지 못해 이관을 건너뜁니다: ${error.message}`);
    return;
  }

  let devices = 0;
  for (const [deviceId, device] of Object.entries(legacy.devices || {})) {
    const user = ensureUser(`device:${deviceId}`);
    const remaining = Math.max(0, Number(device.remaining || 0));
    const used = Math.max(0, Number(device.used || 0));
    const total = remaining + used;
    if (total > 0) {
      const order = createOrder({ userId: user.id, provider: 'migrated', credits: total });
      const pass = createPass({ userId: user.id, orderId: order.id, credits: total });
      for (const chargeKey of device.charges || []) {
        chargePass({ userId: user.id, passId: pass.id, sessionId: null, chargeKey });
      }
      // charges 목록이 잘려 used보다 적을 수 있어 사용량을 맞춰 준다.
      const counted = (device.charges || []).length;
      for (let i = counted; i < used; i += 1) {
        chargePass({ userId: user.id, passId: pass.id, sessionId: null, chargeKey: `migrated-${pass.id}-${i}` });
      }
    }
    devices += 1;
  }

  fs.renameSync(legacyPath, `${legacyPath}.migrated`);
  audit({ action: 'store.migrated', detail: { devices } });
  console.log(`[db] store.json에서 기기 ${devices}개를 옮겼습니다. 원본은 store.json.migrated로 남깁니다.`);
}
