// 세션 토큰. HMAC 서명한 payload 한 조각이라 서버에 세션 저장소가 필요 없다.
import crypto from 'node:crypto';

const TOKEN_TTL_MS = Math.max(1, Number(process.env.SESSION_TTL_DAYS || 14)) * 24 * 60 * 60 * 1000;

const configuredSecret = String(process.env.SESSION_SECRET || '').trim();
// 비워두면 부팅할 때마다 새로 만든다. 서버를 재시작하면 모두 다시 로그인해야 한다.
const sessionSecret = configuredSecret || crypto.randomBytes(32).toString('hex');

export const config = { hasSecret: Boolean(configuredSecret), ttlMs: TOKEN_TTL_MS };

export function makeToken(user) {
  const payload = b64url(Buffer.from(JSON.stringify({
    sub: user.id,
    exp: Date.now() + TOKEN_TTL_MS
  })));
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, signature] = token.split('.', 2);
  const given = Buffer.from(signature);
  const expected = Buffer.from(sign(payload));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims.exp > Date.now() ? claims : null;
  } catch {
    return null;
  }
}

export function bearerOf(req) {
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function sign(payload) {
  return b64url(crypto.createHmac('sha256', sessionSecret).update(payload).digest());
}

function b64url(raw) {
  return Buffer.from(raw).toString('base64url');
}
