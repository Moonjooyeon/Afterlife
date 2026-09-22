import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildProviders, generateJson } from './gemini.js';
import { demoResult } from './demo.js';
import { buildPrompt } from './prompt.js';
import * as passes from './passes.js';

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
const providers = buildProviders();

await passes.init(runtimeDir);

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
        testPassEnabled: passes.config.testPassEnabled
      });
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

function handlePasses(req, res) {
  const deviceId = deviceIdOf(req);
  if (!deviceId) return sendJson(res, 400, { error: 'X-Device-Id 헤더가 필요합니다.' });
  return sendJson(res, 200, passes.status(deviceId));
}

async function handleGrantPass(req, res) {
  if (!passes.config.testPassEnabled) {
    return sendJson(res, 403, { error: '테스트 이용권 지급이 꺼져 있습니다.' });
  }
  const deviceId = deviceIdOf(req);
  if (!deviceId) return sendJson(res, 400, { error: 'X-Device-Id 헤더가 필요합니다.' });
  const { credits } = await readJson(req);
  const amount = Number(credits) > 0 ? Number(credits) : passes.config.testPassCredits;
  return sendJson(res, 200, await passes.grant(deviceId, amount, 'test'));
}

async function handleAfterlife(req, res) {
  const deviceId = deviceIdOf(req);
  if (!deviceId) return sendJson(res, 400, { error: 'X-Device-Id 헤더가 필요합니다.' });
  if (!passes.hasCredit(deviceId)) {
    return sendJson(res, 402, { error: '남은 이용권이 없어요. 충전 후 다시 시도해 주세요.' });
  }

  const { mode, input, chargeKey } = await readJson(req);
  const error = validateInput(mode, input);
  if (error) return sendJson(res, 400, { error });

  // 키가 없으면 데모 결과. 이용권은 깎지 않는다.
  if (!providers.length) {
    await delay(1400);
    return sendJson(res, 200, { result: demoResult(mode), pass: passes.status(deviceId) });
  }

  let lastFailure = { status: 502, message: '결과를 만들지 못했어요.' };
  for (let attempt = 0; attempt < maxRetry; attempt += 1) {
    const { system, user } = buildPrompt(mode, input);
    const outcome = await generateJson(providers, { model, system, user, thinkingLevel });

    if (outcome.ok) {
      try {
        validateResult(mode, outcome.data);
      } catch (validationError) {
        lastFailure = { status: 502, message: validationError.message };
        if (attempt < maxRetry - 1) { await delay(800 * 2 ** attempt); continue; }
        break;
      }
      // 결과가 나온 뒤에만 차감한다. 실패했을 때 이용권이 날아가지 않도록.
      const charged = await passes.consume(deviceId, chargeKey || passes.newChargeKey());
      return sendJson(res, 200, { result: outcome.data, pass: { ticketEnabled: charged.ticketEnabled, remaining: charged.remaining, used: charged.used } });
    }

    lastFailure = { status: outcome.status, message: outcome.message };
    if (attempt < maxRetry - 1) await delay(800 * 2 ** attempt);
  }

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

function deviceIdOf(req) {
  return passes.normalizeDeviceId(req.headers['x-device-id']);
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

server.listen(port, host, () => {
  const mode = providers.length ? `gemini providers: ${providers.length}` : 'demo mode (GEMINI_API_KEY 없음)';
  console.log(`[afterlife] http://${host}:${port} · static: ${path.relative(rootDir, staticDir)} · ${mode}`);
});
