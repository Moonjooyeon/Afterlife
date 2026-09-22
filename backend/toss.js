// Apps in Toss 파트너 API 클라이언트. mTLS 인증서로만 접속한다.
// 인증서와 API base는 토스 콘솔에서 받아 .env에 넣는다. 없으면 로그인 기능이 꺼진다.
import './env.js';
import fs from 'node:fs/promises';
import https from 'node:https';

const apiBase = (process.env.TOSS_API_BASE || 'https://apps-in-toss-api.toss.im').replace(/\/+$/, '');
const certPath = String(process.env.TOSS_MTLS_CERT_PATH || '').trim();
const keyPath = String(process.env.TOSS_MTLS_KEY_PATH || '').trim();
const keyPassword = String(process.env.TOSS_MTLS_KEY_PASSWORD || '').trim();

export const config = {
  apiBase,
  certPath,
  keyPath,
  // 인증서 경로가 둘 다 있어야 파트너 API를 부를 수 있다.
  configured: Boolean(certPath && keyPath)
};

let credentials = null;

export async function checkCredentials() {
  if (!config.configured) return { ok: false, reason: 'TOSS_MTLS_CERT_PATH / TOSS_MTLS_KEY_PATH가 비어 있습니다.' };
  try {
    await loadCredentials();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

// authorizationCode를 토스 accessToken으로 바꾼다.
export async function generateToken({ authorizationCode, referrer }) {
  return httpJson('/api-partner/v1/apps-in-toss/user/oauth2/generate-token', {
    method: 'POST',
    body: { authorizationCode, referrer }
  });
}

// accessToken으로 사용자 식별자(userKey)를 받아 온다.
export async function loginMe(accessToken) {
  return httpJson('/api-partner/v1/apps-in-toss/user/oauth2/login-me', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
}

export function tossError(body, fallback) {
  const error = body?.error;
  if (error && typeof error === 'object') return error.reason || error.message || error.errorCode || fallback;
  return body?.message || body?.error || fallback;
}

async function loadCredentials() {
  if (credentials) return credentials;
  const [cert, key] = await Promise.all([fs.readFile(certPath), fs.readFile(keyPath)]);
  credentials = { cert, key };
  return credentials;
}

function httpJson(pathname, { method = 'GET', headers = {}, body = null } = {}) {
  if (!config.configured) return Promise.reject(new Error('토스 mTLS 인증서가 설정되지 않았습니다.'));

  return loadCredentials().then(({ cert, key }) => new Promise((resolve, reject) => {
    const url = new URL(`${apiBase}${pathname}`);
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const request = https.request({
      method,
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      cert,
      key,
      passphrase: keyPassword || undefined,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': data.length } : {}),
        ...headers
      }
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let parsed = {};
        try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { error: text }; }
        if (response.statusCode >= 400) {
          return reject(new Error(tossError(parsed, `Toss API ${response.statusCode}`)));
        }
        resolve(parsed);
      });
    });
    request.on('error', reject);
    if (data) request.write(data);
    request.end();
  }));
}
