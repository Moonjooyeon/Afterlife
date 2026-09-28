// 이용권 업무 로직. 운영 환경은 PostgreSQL, 로컬 개발은 SQLite를 사용한다.
// 결제를 붙일 때는 결제 검증 뒤에 grant()를 부르면 된다.
import './env.js';
import db from './database.js';

const ticketEnabled = parseBoolean(process.env.TICKET_ENABLED, false);
const freeCredits = Number(process.env.TICKET_FREE_CREDITS || 0);
const passCredits = Number(process.env.TICKET_PASS_CREDITS || 11);
const testPassEnabled = parseBoolean(process.env.TICKET_TEST_PASS_ENABLED, false);
const testPassCredits = Number(process.env.TICKET_TEST_PASS_CREDITS || 100);

const iapEnabled = parseBoolean(process.env.TOSS_IAP_ENABLED, false);
const iapAmountKrw = Number(process.env.TOSS_IAP_AMOUNT_KRW || 0);

export const config = { ticketEnabled, freeCredits, passCredits, testPassEnabled, testPassCredits, iapEnabled, iapAmountKrw };

export async function init(runtimeDir, databasePath) {
  return (await db.open(runtimeDir, databasePath));
}

// deviceId는 프론트가 localStorage에 들고 있는 임의의 문자열이다. 개인정보를 담지 않는다.
export function normalizeDeviceId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.slice(0, 64).replace(/[^A-Za-z0-9_-]/g, '');
}

// 로그인 없이 쓸 때는 기기 하나를 사용자 한 명으로 본다.
export async function ensureDeviceUser(deviceId, meta = {}) {
  return (await ensureUser(`device:${deviceId}`, '', meta));
}

// 토스 로그인 사용자. 같은 userKey면 같은 사람이다.
export async function ensureTossUser(userKey, meta = {}) {
  return (await ensureUser(`toss:${userKey}`, `토스 사용자 ${String(userKey).slice(-4)}`, meta));
}

async function ensureUser(loginId, displayName, meta) {
  const run = async () => {
  if (db.lockOrder) await db.lockOrder(`user:${loginId}`);
  const existing = (await db.findUser(loginId));
  if (existing) return existing;

  const user = (await db.ensureUser(loginId, displayName, meta));
  // 첫 방문에 주는 무료 횟수. 기본값 0이라 아무것도 안 준다.
  if (ticketEnabled && freeCredits > 0) {
    const order = (await db.createOrder({ userId: user.id, provider: 'free', credits: freeCredits }));
    (await db.createPass({ userId: user.id, orderId: order.id, credits: freeCredits }));
    (await db.audit({ userId: user.id, action: 'pass.granted', detail: { reason: 'free', credits: freeCredits }, meta }));
  }
  return user;
  };
  return db.transaction ? db.transaction(run) : run();
}

export async function status(user) {
  if (!ticketEnabled) return { ticketEnabled: false, remaining: null, used: (await db.usedCount(user.id)) };
  return { ticketEnabled: true, remaining: (await db.remainingCredits(user.id)), used: (await db.usedCount(user.id)) };
}

export async function hasCredit(user) {
  if (!ticketEnabled) return true;
  return (await db.remainingCredits(user.id)) > 0;
}

export async function grant(user, credits, { provider = 'test', orderId = null, sku = '', displayName = '', amount = 0, meta = {} } = {}) {
  const order = (await db.createOrder({ userId: user.id, orderId, provider, sku, displayName, amount, credits }));
  const pass = (await db.createPass({ userId: user.id, orderId: order.id, credits }));
  (await db.audit({ userId: user.id, action: 'pass.granted', detail: { reason: provider, credits, orderId }, meta }));
  return { order, pass, ...(await status(user)) };
}

// 토스 인앱결제 지급. 같은 orderId로 두 번 들어와도 한 번만 준다.
export async function grantIapPass(user, { orderId, sku = '', displayName = '', amount = 0, meta = {} }) {
  const run = async () => {
  if (db.lockOrder) await db.lockOrder(orderId);
  const existingOrder = (await db.findOrderByOrderId(orderId));
  if (existingOrder) {
    if (existingOrder.user_id !== user.id) throw new Error('다른 사용자의 주문입니다.');
    (await db.audit({ userId: user.id, action: 'pass.grant_duplicated', detail: { orderId }, meta }));
    return { duplicated: true, pass: (await db.findPassByOrder(existingOrder.id)), credits: existingOrder.credits, ...(await status(user)) };
  }

  const granted = (await grant(user, passCredits, {
    provider: 'toss',
    orderId,
    sku,
    displayName,
    amount: Number(amount) || iapAmountKrw,
    meta
  }));
  return { duplicated: false, credits: passCredits, ...granted };
  };
  return db.transaction ? db.transaction(run) : run();
}

export async function startSession(user, mode, chargeKey) {
  const pass = ticketEnabled ? (await db.activePasses(user.id))[0] || null : null;
  return (await db.startSession({ userId: user.id, passId: pass?.id || null, chargeKey: chargeKey || null, mode }));
}

// 결과가 검증을 통과한 뒤에만 부른다. 같은 chargeKey로 두 번 들어오면 한 번만 깎는다.
export async function consume(user, { sessionId, chargeKey, meta = {} }) {
  if (!ticketEnabled) return { ok: true, ...(await status(user)) };

  const existingCharge = await db.findCharge(chargeKey);
  if (existingCharge) {
    if (existingCharge.user_id !== user.id) throw new Error('다른 사용자의 요청입니다.');
    return { ok: true, duplicated: true, ...(await status(user)) };
  }

  const pass = (await db.activePasses(user.id))[0];
  if (!pass) {
    (await db.audit({ userId: user.id, action: 'pass.rejected', detail: { reason: 'no_active_pass' }, meta }));
    return { ok: false, ...(await status(user)) };
  }

  const charge = (await db.chargePass({ userId: user.id, passId: pass.id, sessionId, chargeKey }));
  if (!charge) {
    (await db.audit({ userId: user.id, action: 'pass.rejected', detail: { reason: 'pass_exhausted', passId: pass.id }, meta }));
    return { ok: false, ...(await status(user)) };
  }

  (await db.audit({ userId: user.id, action: 'pass.charged', detail: { passId: pass.id, chargeKey }, meta }));
  return { ok: true, ...(await status(user)) };
}

export function newChargeKey() {
  return `AL-${Date.now().toString(36)}-${db.uuid().slice(0, 8)}`;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}
