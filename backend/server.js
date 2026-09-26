import './env.js';
import { hasAuditAccess, auditLimit, clientErrorDetail, publicAuditRow } from './audit.js';

import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildProviders, generateJson } from './gemini.js';
import { demoResult } from './demo.js';
import { buildPrompt } from './prompt.js';
import * as passes from './passes.js';
import db from './database.js';
import * as auth from './auth.js';
import * as toss from './toss.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const frontendDir = path.join(rootDir, 'frontend');
const frontendDistDir = path.join(frontendDir, 'dist');
const dataDir = path.join(rootDir, 'data');

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const staticDir = await directoryExists(frontendDistDir) ? frontendDistDir : frontendDir;
const runtimeDir = process.env.RUNTIME_DIR || path.join(rootDir, 'runtime');
const appTitle = process.env.APP_TITLE || '읽지 않음';
const model = process.env.GEMINI_MODEL || 'gemini-3.7-flash';
const thinkingLevel = process.env.GEMINI_THINKING_LEVEL || 'low';
const maxRetry = Math.max(1, Number(process.env.GENERATE_MAX_RETRY || 3));
const databasePath = process.env.DATABASE_PATH || '';
const tossLoginEnabled = parseBoolean(process.env.TOSS_LOGIN_ENABLED, false);
// 결과 보관 기간. 0이면 결과를 저장하지 않는다.
const resultRetentionDays = Math.max(0, Number(process.env.RESULT_RETENTION_DAYS ?? 30));
const providers = buildProviders();

const dbPath = (await passes.init(runtimeDir, databasePath));

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

    if (req.method === 'GET' && url.pathname === '/api/v1/audit/recent') {
      if (!hasAuditAccess(req)) return sendJson(res, 403, { error: '감사로그 접근 권한이 없습니다.' });
      const rows = await db.listAuditLogs(auditLimit(url.searchParams.get('limit')));
      return sendJson(res, 200, { logs: rows.map(publicAuditRow) });
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/audit/client-error') {
      if (!auth.bearerOf(req)) return sendJson(res, 401, { error: '토스 로그인이 필요합니다.' });
      const ctx = await userOf(req, res);
      if (!ctx) return;
      const detail = clientErrorDetail(await readJson(req));
      await db.audit({ userId: ctx.user.id, action: 'client_report_error', detail, meta: ctx.meta });
      return send(res, 204, '');
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/health') {
      await db.getSetting('audit_salt');
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
        iapSku: process.env.TOSS_IAP_SKU || '',
        passPriceKrw: passes.config.iapAmountKrw
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/toss/login') {
      return await handleTossLogin(req, res);
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/me') {
      return (await handleMe(req, res));
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/iap/grant-pass') {
      return await handleIapGrantPass(req, res);
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/passes') {
      return (await handlePasses(req, res));
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

  // 빌드하면 Vite가 frontend/public의 내용을 dist 최상단에 복사한다.
  // 소스를 그대로 서빙하는 개발 모드에서도 같은 주소로 열리게 public을 같이 본다.
  if (staticDir === frontendDir) {
    const publicPath = path.normalize(path.join(frontendDir, 'public', requested));
    if (publicPath.startsWith(path.join(frontendDir, 'public')) && await fileExists(publicPath)) {
      return sendFile(res, publicPath);
    }
  }

  return sendFile(res, filePath, path.join(staticDir, 'index.html'));
}

async function fileExists(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

// 요청자를 사용자 한 명으로 푼다.
// 토스 로그인을 켜면 Bearer 토큰만 받고, 끄면 지금까지처럼 X-Device-Id로 본다.
async function userOf(req, res) {
  const meta = db.requestMeta(req);
  const token = auth.bearerOf(req);

  if (token) {
    const claims = auth.verifyToken(token);
    const user = claims ? (await db.findUserById(claims.sub)) : null;
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
  return { user: (await passes.ensureDeviceUser(deviceId, meta)), meta };
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
    (await db.audit({ action: 'user.login_failed', detail: { message: error.message }, meta }));
    return sendJson(res, 502, { error: error.message || '토스 로그인에 실패했습니다.' });
  }

  const user = (await passes.ensureTossUser(userKey, meta));
  (await db.touchLogin(user.id, meta));
  if (passes.config.testPassEnabled) {
    (await passes.grant(user, passes.config.testPassCredits, { provider: 'test', meta }));
  }
  return sendJson(res, 200, { user: publicUser(user), token: auth.makeToken(user), ...(await passes.status(user)) });
}

async function handleMe(req, res) {
  const ctx = (await userOf(req, res));
  if (!ctx) return undefined;
  return sendJson(res, 200, { user: publicUser(ctx.user), ...(await passes.status(ctx.user)) });
}

async function handleIapGrantPass(req, res) {
  const ctx = (await userOf(req, res));
  if (!ctx) return undefined;

  if (!passes.config.iapEnabled) {
    (await db.audit({ userId: ctx.user.id, action: 'pass.grant_blocked', detail: { reason: 'iap_disabled' }, meta: ctx.meta }));
    return sendJson(res, 403, { error: '현재 결제가 꺼져 있습니다.' });
  }

  const payload = await readJson(req);
  const orderId = String(payload.orderId || '').trim();
  if (!orderId) return sendJson(res, 400, { error: 'orderId가 필요합니다.' });

  if (!ctx.user.login_id.startsWith('toss:')) return sendJson(res, 401, { error: '토스 로그인 후 결제할 수 있습니다.' });
  const sku = String(process.env.TOSS_IAP_SKU || '').trim();
  if (!sku) return sendJson(res, 503, { error: '서버 상품 설정이 필요합니다.' });
  try {
    await toss.verifyOrder({ orderId, userKey: ctx.user.login_id.slice(5), sku });
  } catch {
    return sendJson(res, 422, { error: '결제 확인에 실패했습니다. 잠시 후 다시 시도해 주세요.' });
  }

  const granted = (await passes.grantIapPass(ctx.user, {
    orderId,
    sku,
    displayName: `${passes.config.passCredits}회 이용권`,
    amount: passes.config.iapAmountKrw,
    meta: ctx.meta
  }));

  return sendJson(res, 200, {
    status: granted.duplicated ? 'already_granted' : 'captured',
    credits: granted.credits,
    ticketEnabled: granted.ticketEnabled,
    remaining: granted.remaining,
    used: granted.used
  });
}

async function handlePasses(req, res) {
  const ctx = (await userOf(req, res));
  if (!ctx) return undefined;
  return sendJson(res, 200, (await passes.status(ctx.user)));
}

async function handleGrantPass(req, res) {
  if (!passes.config.testPassEnabled) {
    return sendJson(res, 403, { error: '테스트 이용권 지급이 꺼져 있습니다.' });
  }
  const ctx = (await userOf(req, res));
  if (!ctx) return undefined;
  const { credits } = await readJson(req);
  const amount = Number(credits) > 0 ? Number(credits) : passes.config.testPassCredits;
  const granted = (await passes.grant(ctx.user, amount, { provider: 'test', meta: ctx.meta }));
  return sendJson(res, 200, { ticketEnabled: granted.ticketEnabled, remaining: granted.remaining, used: granted.used });
}

async function handleAfterlife(req, res) {
  const ctx = (await userOf(req, res));
  if (!ctx) return undefined;
  const { user, meta } = ctx;

  const { mode, input, chargeKey } = await readJson(req);
  const error = validateInput(mode, input);
  if (error) return sendJson(res, 400, { error });

  const release = db.lockGeneration ? await db.lockGeneration(user.id) : async () => {};
  if (!release) return sendJson(res, 409, { error: '이미 결과를 만들고 있어요. 잠시 기다려 주세요.' });
  try {

  const key = chargeKey || passes.newChargeKey();
  const existing = (await db.findSessionByChargeKey(key));
  if (existing && existing.user_id !== user.id) return sendJson(res, 403, { error: '다른 사용자의 요청입니다.' });

  // 이미 차감이 끝난 chargeKey. 차감은 성공 뒤에만 일어나므로, 이 요청은
  // 결과를 못 받고 다시 온 것이다. 보관해 둔 결과가 있으면 그대로 돌려준다.
  // (실패해서 다시 온 요청은 차감이 없으니 여기 걸리지 않고 아래에서 새로 생성된다.)
  if (passes.config.ticketEnabled && (await db.findCharge(key))) {
    const saved = db.readSessionResult(existing);
    if (saved) {
      (await db.audit({ userId: user.id, action: 'generation.replayed', detail: { sessionId: existing.id, chargeKey: key }, meta }));
      return sendJson(res, 200, { result: saved, pass: (await passes.status(user)), replayed: true });
    }
    (await db.audit({ userId: user.id, action: 'generation.rejected', detail: { reason: 'charge_key_used', chargeKey: key }, meta }));
    return sendJson(res, 409, { error: '이미 처리된 요청이에요. 다시 뽑기를 눌러 주세요.' });
  }

  // 환불 완료된 주문으로 남은 이용권을 쓰지 못하도록 생성 직전에 확인한다.
  if (passes.config.iapEnabled && db.spendableOrders && user.login_id.startsWith('toss:')) {
    try {
      for (const order of await db.spendableOrders(user.id)) {
        const state = await toss.getOrder({ orderId: order.order_id, userKey: user.login_id.slice(5), sku: order.sku });
        if (state.status === 'REFUNDED') await db.revokeOrder(order.order_id);
        else if (!['PURCHASED', 'PAYMENT_COMPLETED'].includes(state.status)) throw new Error('Order pending');
      }
    } catch { return sendJson(res, 503, { error: '이용권 결제 상태를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.' }); }
  }
  if (!(await passes.hasCredit(user))) {
    (await db.audit({ userId: user.id, action: 'generation.rejected', detail: { reason: 'no_credit' }, meta }));
    return sendJson(res, 402, { error: '남은 이용권이 없어요. 충전 후 다시 시도해 주세요.' });
  }

  // 같은 chargeKey로 다시 들어온 요청은 새 세션을 만들지 않는다.
  const session = existing || (await passes.startSession(user, mode, key));

  // 키가 없으면 데모 결과. 이용권은 깎지 않는다.
  if (!providers.length) {
    await delay(1400);
    (await db.finishSession(session.id, 'demo'));
    (await db.audit({ userId: user.id, action: 'generation.demo', detail: { mode, sessionId: session.id }, meta }));
    return sendJson(res, 200, { result: demoResult(mode), pass: (await passes.status(user)) });
  }

  let lastFailure = { status: 502, message: '결과를 만들지 못했어요.' };
  for (let attempt = 1; attempt <= maxRetry; attempt += 1) {
    const logger = {
      start: async (info) => (await db.startGeminiRequest({ userId: user.id, sessionId: session.id, attempt, ...info })).id,
      finish: async (id, result) => (await db.finishGeminiRequest(id, result))
    };
    const { system, user: userPrompt } = buildPrompt(mode, input);
    const outcome = await generateJson(providers, { model, system, user: userPrompt, thinkingLevel, logger });

    if (outcome.ok) {
      try {
        validateResult(mode, outcome.data);
      } catch (validationError) {
        // Gemini 호출 자체는 200이었고 응답 모양이 틀린 경우. 재시도 이유를 남긴다.
        (await db.audit({ userId: user.id, action: 'generation.invalid', detail: { mode, sessionId: session.id, attempt, message: validationError.message }, meta }));
        lastFailure = { status: 502, message: validationError.message };
        if (attempt < maxRetry) { await delay(800 * 2 ** (attempt - 1)); continue; }
        break;
      }
      // 차감하기 전에 결과부터 저장한다. 차감 뒤에 죽어도 재요청으로 되찾을 수 있게.
      if (resultRetentionDays > 0) (await db.saveSessionResult(session.id, outcome.data));
      // 결과가 나온 뒤에만 차감한다. 실패했을 때 이용권이 날아가지 않도록.
      const charged = (await passes.consume(user, { sessionId: session.id, chargeKey: key, meta }));
      if (!charged.ok) return sendJson(res, 402, { error: '남은 이용권이 없습니다.' });
      (await db.finishSession(session.id, 'completed'));
      (await db.audit({ userId: user.id, action: 'generation.completed', detail: { mode, sessionId: session.id, attempt }, meta }));
      return sendJson(res, 200, {
        result: outcome.data,
        pass: { ticketEnabled: charged.ticketEnabled, remaining: charged.remaining, used: charged.used }
      });
    }

    lastFailure = { status: outcome.status, message: outcome.message };
    if (attempt < maxRetry) await delay(800 * 2 ** (attempt - 1));
  }

  (await db.finishSession(session.id, 'failed'));
  (await db.audit({ userId: user.id, action: 'generation.failed', detail: { mode, sessionId: session.id, message: lastFailure.message }, meta }));
  return sendJson(res, lastFailure.status >= 400 ? lastFailure.status : 502, { error: lastFailure.message });
  } finally { await release(); }
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Device-Id, Authorization, X-Audit-Token');
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
    if (!check.ok) throw new Error(`mTLS 인증서 오류: ${check.reason}`);
    if (!auth.config.hasSecret) throw new Error('토스 로그인에는 SESSION_SECRET이 필요합니다.');
  }
  if (passes.config.iapEnabled && !tossLoginEnabled) {
    throw new Error('결제에는 토스 로그인이 필요합니다.');
  }
  if (passes.config.iapEnabled && !passes.config.ticketEnabled) {
    throw new Error('결제에는 이용권 차감이 필요합니다.');
  }
  if (passes.config.iapEnabled && !process.env.TOSS_IAP_SKU?.trim()) throw new Error('결제에는 TOSS_IAP_SKU가 필요합니다.');
}

// 보관 기간이 지난 결과를 지운다. 부팅할 때 한 번, 그 뒤로는 6시간마다.
async function startResultPruner() {
  if (!(resultRetentionDays > 0)) return;
  const prune = async () => {
    const cleared = (await db.pruneResults(resultRetentionDays));
    if (cleared) console.log(`[afterlife] 보관 기간이 지난 결과 ${cleared}건을 지웠습니다.`);
  };
  (await prune());
  setInterval(() => prune().catch(error => console.error('[prune]', error.message)), 6 * 60 * 60 * 1000).unref();
}

await warnAboutConfig();
await startResultPruner();
server.listen(port, host, () => {
  const mode = providers.length ? `gemini providers: ${providers.length}` : 'demo mode (GEMINI_API_KEY 없음)';
  const authMode = tossLoginEnabled ? 'toss login' : 'device';
  const retention = resultRetentionDays > 0 ? `results: ${resultRetentionDays}d` : 'results: 저장 안 함';
  console.log(`[afterlife] http://${host}:${port} · static: ${path.relative(rootDir, staticDir)} · db: ${path.relative(rootDir, dbPath)} · auth: ${authMode} · ${retention} · ${mode}`);
});
