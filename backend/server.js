import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildProviders, generateJson } from './gemini.js';
import { demoResult } from './demo.js';
import { buildPrompt } from './prompt.js';
import * as passes from './passes.js';
import * as db from './db.js';
import * as auth from './auth.js';
import * as toss from './toss.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const frontendDir = path.join(rootDir, 'frontend');
const frontendDistDir = path.join(frontendDir, 'dist');
const dataDir = path.join(rootDir, 'data');

await loadEnv(path.join(rootDir, '.env'));

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const staticDir = await directoryExists(frontendDistDir) ? frontendDistDir : frontendDir;
const runtimeDir = process.env.RUNTIME_DIR || path.join(rootDir, 'runtime');
const appTitle = process.env.APP_TITLE || '[배포물 이름]';
const model = process.env.GEMINI_MODEL || 'gemini-3.7-flash';
const thinkingLevel = process.env.GEMINI_THINKING_LEVEL || 'low';
const maxRetry = Math.max(1, Number(process.env.GENERATE_MAX_RETRY || 3));
const databasePath = process.env.DATABASE_PATH || '';
const tossLoginEnabled = parseBoolean(process.env.TOSS_LOGIN_ENABLED, false);
const providers = buildProviders();

const dbPath = passes.init(runtimeDir, databasePath);

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    setCors(res);
    if (req.method === 'OPTIONS') return send(res, 204, '');

    if (req.method === 'GET' && url.pathname === '/questions.json') {
      return await sendFile(res, path.join(dataDir, 'questions.json'));
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/health') {
      return sendJson(res, 200, { status: 'ok' });
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/config') {
      return sendJson(res, 200, {
        title: appTitle,
        demoMode: providers.length === 0,
        ticketEnabled: passes.config.ticketEnabled,
        passCredits: passes.config.passCredits,
        testPassEnabled: passes.config.testPassEnabled,
        loginEnabled: tossLoginEnabled,
        iapEnabled: passes.config.iapEnabled,
        passPriceKrw: passes.config.iapAmountKrw
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/toss/login') {
      return await handleTossLogin(req, res);
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/me') {
      return handleMe(req, res);
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/iap/grant-pass') {
      return await handleIapGrantPass(req, res);
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/passes') {
      return handlePasses(req, res);
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/passes/grant') {
      return await handleGrantPass(req, res);
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/afterlife') {
      return await handleAfterlife(req, res);
    }

    if (req.method === 'GET') {
      return await serveFrontend(url.pathname, res);
    }

    return sendJson(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || 'Server error' });
  }
});

async function serveFrontend(pathname, res) {
  const requested = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  const filePath = path.normalize(path.join(staticDir, requested));
  if (!filePath.startsWith(staticDir)) return sendJson(res, 403, { error: 'Forbidden' });
  return sendFile(res, filePath, path.join(staticDir, 'index.html'));
}

// 요청자를 사용자 한 명으로 푼다.
// 토스 로그인을 켜면 Bearer 토큰만 받고, 끄면 지금까지처럼 X-Device-Id로 본다.
function userOf(req, res) {
  const meta = db.requestMeta(req);
  const token = auth.bearerOf(req);

  if (token) {
    const claims = auth.verifyToken(token);
    const user = claims ? db.findUserById(claims.sub) : null;
    if (!user) {
      sendJson(res, 401, { error: '로그인이 만료됐어요. 다시 로그인해 주세요.' });
      return null;
    }
    return { user, meta };
  }

  if (tossLoginEnabled) {
    sendJson(res, 401, { error: '토스 로그인이 필요합니다.' });
    return null;
  }

  const deviceId = passes.normalizeDeviceId(req.headers['x-device-id']);
  if (!deviceId) {
    sendJson(res, 400, { error: 'X-Device-Id 헤더가 필요합니다.' });
    return null;
  }
  return { user: passes.ensureDeviceUser(deviceId, meta), meta };
}

function publicUser(user) {
  return { id: user.id, loginId: user.login_id, displayName: user.display_name };
}

async function handleTossLogin(req, res) {
  if (!tossLoginEnabled) {
    return sendJson(res, 403, { error: '토스 로그인이 꺼져 있습니다.' });
  }
  if (!toss.config.configured) {
    return sendJson(res, 500, { error: '토스 mTLS 인증서가 설정되지 않았습니다.' });
  }

  const meta = db.requestMeta(req);
  const { authorizationCode, referrer } = await readJson(req);
  if (!authorizationCode || !referrer) {
    return sendJson(res, 400, { error: 'authorizationCode, referrer가 필요합니다.' });
  }

  let userKey = '';
  try {
    const tokenBody = await toss.generateToken({ authorizationCode, referrer });
    const accessToken = tokenBody?.success?.accessToken;
    if (!accessToken) {
      return sendJson(res, 502, { error: toss.tossError(tokenBody, '토스 로그인 토큰을 받지 못했습니다.') });
    }
    const meBody = await toss.loginMe(accessToken);
    userKey = String(meBody?.success?.userKey || '').trim();
    if (!userKey) {
      return sendJson(res, 502, { error: toss.tossError(meBody, '토스 사용자 정보를 받지 못했습니다.') });
    }
  } catch (error) {
    db.audit({ action: 'user.login_failed', detail: { message: error.message }, meta });
    return sendJson(res, 502, { error: error.message || '토스 로그인에 실패했습니다.' });
  }

  const user = passes.ensureTossUser(userKey, meta);
  db.touchLogin(user.id, meta);
  if (passes.config.testPassEnabled) {
    passes.grant(user, passes.config.testPassCredits, { provider: 'test', meta });
  }
  return sendJson(res, 200, { user: publicUser(user), token: auth.makeToken(user), ...passes.status(user) });
}

function handleMe(req, res) {
  const ctx = userOf(req, res);
  if (!ctx) return undefined;
  return sendJson(res, 200, { user: publicUser(ctx.user), ...passes.status(ctx.user) });
}

async function handleIapGrantPass(req, res) {
  const ctx = userOf(req, res);
  if (!ctx) return undefined;

  if (!passes.config.iapEnabled) {
    db.audit({ userId: ctx.user.id, action: 'pass.grant_blocked', detail: { reason: 'iap_disabled' }, meta: ctx.meta });
    return sendJson(res, 403, { error: '현재 결제가 꺼져 있습니다.' });
  }

  const payload = await readJson(req);
  const orderId = String(payload.orderId || '').trim();
  if (!orderId) return sendJson(res, 400, { error: 'orderId가 필요합니다.' });

  const granted = passes.grantIapPass(ctx.user, {
    orderId,
    sku: String(payload.sku || ''),
    displayName: String(payload.displayName || ''),
    amount: Number(payload.amount || 0),
    meta: ctx.meta
  });

  return sendJson(res, 200, {
    status: granted.duplicated ? 'already_granted' : 'captured',
    credits: granted.credits,
    ticketEnabled: granted.ticketEnabled,
    remaining: granted.remaining,
    used: granted.used
  });
}

function handlePasses(req, res) {
  const ctx = userOf(req, res);
  if (!ctx) return undefined;
  return sendJson(res, 200, passes.status(ctx.user));
}

async function handleGrantPass(req, res) {
  if (!passes.config.testPassEnabled) {
    return sendJson(res, 403, { error: '테스트 이용권 지급이 꺼져 있습니다.' });
  }
  const ctx = userOf(req, res);
  if (!ctx) return undefined;
  const { credits } = await readJson(req);
  const amount = Number(credits) > 0 ? Number(credits) : passes.config.testPassCredits;
  const granted = passes.grant(ctx.user, amount, { provider: 'test', meta: ctx.meta });
  return sendJson(res, 200, { ticketEnabled: granted.ticketEnabled, remaining: granted.remaining, used: granted.used });
}

async function handleAfterlife(req, res) {
  const ctx = userOf(req, res);
  if (!ctx) return undefined;
  const { user, meta } = ctx;

  if (!passes.hasCredit(user)) {
    db.audit({ userId: user.id, action: 'generation.rejected', detail: { reason: 'no_credit' }, meta });
    return sendJson(res, 402, { error: '남은 이용권이 없어요. 충전 후 다시 시도해 주세요.' });
  }

  const { mode, input, chargeKey } = await readJson(req);
  const error = validateInput(mode, input);
  if (error) return sendJson(res, 400, { error });

  // 이미 차감이 끝난 chargeKey면 생성을 또 해주지 않는다.
  // (차감은 성공 뒤에만 일어나므로, 실패해서 다시 온 요청은 여기 걸리지 않는다.)
  const key = chargeKey || passes.newChargeKey();
  if (passes.config.ticketEnabled && db.findCharge(key)) {
    db.audit({ userId: user.id, action: 'generation.rejected', detail: { reason: 'charge_key_used', chargeKey: key }, meta });
    return sendJson(res, 409, { error: '이미 처리된 요청이에요. 다시 뽑기를 눌러 주세요.' });
  }

  // 같은 chargeKey로 다시 들어온 요청은 새 세션을 만들지 않는다.
  const existing = db.findSessionByChargeKey(key);
  const session = existing || passes.startSession(user, mode, key);

  // 키가 없으면 데모 결과. 이용권은 깎지 않는다.
  if (!providers.length) {
    await delay(1400);
    db.finishSession(session.id, 'demo');
    db.audit({ userId: user.id, action: 'generation.demo', detail: { mode, sessionId: session.id }, meta });
    return sendJson(res, 200, { result: demoResult(mode), pass: passes.status(user) });
  }

  let lastFailure = { status: 502, message: '결과를 만들지 못했어요.' };
  for (let attempt = 1; attempt <= maxRetry; attempt += 1) {
    const logger = {
      start: (info) => db.startGeminiRequest({ userId: user.id, sessionId: session.id, attempt, ...info }).id,
      finish: (id, result) => db.finishGeminiRequest(id, result)
    };
    const { system, user: userPrompt } = buildPrompt(mode, input);
    const outcome = await generateJson(providers, { model, system, user: userPrompt, thinkingLevel, logger });

    if (outcome.ok) {
      try {
        validateResult(mode, outcome.data);
      } catch (validationError) {
        // Gemini 호출 자체는 200이었고 응답 모양이 틀린 경우. 재시도 이유를 남긴다.
        db.audit({ userId: user.id, action: 'generation.invalid', detail: { mode, sessionId: session.id, attempt, message: validationError.message }, meta });
        lastFailure = { status: 502, message: validationError.message };
        if (attempt < maxRetry) { await delay(800 * 2 ** (attempt - 1)); continue; }
        break;
      }
      // 결과가 나온 뒤에만 차감한다. 실패했을 때 이용권이 날아가지 않도록.
      const charged = passes.consume(user, { sessionId: session.id, chargeKey: key, meta });
      db.finishSession(session.id, 'completed');
      db.audit({ userId: user.id, action: 'generation.completed', detail: { mode, sessionId: session.id, attempt }, meta });
      return sendJson(res, 200, {
        result: outcome.data,
        pass: { ticketEnabled: charged.ticketEnabled, remaining: charged.remaining, used: charged.used }
      });
    }

    lastFailure = { status: outcome.status, message: outcome.message };
    if (attempt < maxRetry) await delay(800 * 2 ** (attempt - 1));
  }

  db.finishSession(session.id, 'failed');
  db.audit({ userId: user.id, action: 'generation.failed', detail: { mode, sessionId: session.id, message: lastFailure.message }, meta });
  return sendJson(res, lastFailure.status >= 400 ? lastFailure.status : 502, { error: lastFailure.message });
}

function validateInput(mode, input) {
  if (mode !== 'pair' && mode !== 'solo') return 'mode는 pair 또는 solo여야 합니다.';
  if (!input || typeof input !== 'object') return 'input이 필요합니다.';
  if (!String(input.deadName || '').trim()) return '떠난 사람의 이름이 필요합니다.';
  if (!String(input.livingName || '').trim()) {
    return mode === 'pair' ? '남은 사람의 이름이 필요합니다.' : '받을 사람의 이름이 필요합니다.';
  }
  return '';
}

function validateResult(mode, result) {
  const need = mode === 'pair'
    ? ['messages', 'aftermath', 'final']
    : ['logline', 'senses', 'drafts', 'last_draft', 'discovery', 'reply', 'final'];
  for (const key of need) if (!result?.[key]) throw new Error('응답에 ' + key + ' 없음');
  if (!Array.isArray(result.final.lines) || !result.final.lines.length) throw new Error('마지막 문장 없음');
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function loadEnv(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!match) continue;
      const value = match[2].replace(/^['"]|['"]$/g, '');
      if (process.env[match[1]] === undefined) process.env[match[1]] = value;
    }
  } catch {
    // .env가 없으면 환경변수만 쓴다.
  }
}

async function directoryExists(dirPath) {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('요청 본문이 너무 큽니다.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(new Error('잘못된 JSON 요청입니다.')); }
    });
    req.on('error', reject);
  });
}

async function sendFile(res, filePath, fallbackPath) {
  try {
    const data = await fs.readFile(filePath);
    return send(res, 200, data, mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
  } catch {
    if (fallbackPath && fallbackPath !== filePath) return sendFile(res, fallbackPath);
    return sendJson(res, 404, { error: 'Not found' });
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Device-Id');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function sendJson(res, status, data) {
  return send(res, status, JSON.stringify(data), 'application/json; charset=utf-8');
}

function send(res, status, data, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(data);
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

// 설정이 어긋나면 조용히 죽지 말고 부팅할 때 말해 준다.
async function warnAboutConfig() {
  if (tossLoginEnabled) {
    const check = await toss.checkCredentials();
    if (!check.ok) console.warn(`[afterlife] TOSS_LOGIN_ENABLED=true인데 mTLS 인증서를 못 읽습니다: ${check.reason}`);
    if (!auth.config.hasSecret) console.warn('[afterlife] SESSION_SECRET이 비어 있습니다. 재시작하면 모두 다시 로그인해야 합니다.');
  }
  if (passes.config.iapEnabled && !tossLoginEnabled) {
    console.warn('[afterlife] TOSS_IAP_ENABLED=true인데 TOSS_LOGIN_ENABLED=false입니다. 결제는 로그인 뒤에만 됩니다.');
  }
  if (passes.config.iapEnabled && !passes.config.ticketEnabled) {
    console.warn('[afterlife] TOSS_IAP_ENABLED=true인데 TICKET_ENABLED=false입니다. 이용권을 사도 소모되지 않습니다.');
  }
}

server.listen(port, host, async () => {
  const mode = providers.length ? `gemini providers: ${providers.length}` : 'demo mode (GEMINI_API_KEY 없음)';
  const authMode = tossLoginEnabled ? 'toss login' : 'device';
  console.log(`[afterlife] http://${host}:${port} · static: ${path.relative(rootDir, staticDir)} · db: ${path.relative(rootDir, dbPath)} · auth: ${authMode} · ${mode}`);
  await warnAboutConfig();
});
