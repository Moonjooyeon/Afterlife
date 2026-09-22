// 이용권 저장소. runtime/store.json에 기기 단위로 남은 횟수와 차감 기록을 남긴다.
// 결제(토스 인앱결제 등)를 붙일 때 grant()를 결제 검증 뒤에 호출하면 된다.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const ticketEnabled = parseBoolean(process.env.TICKET_ENABLED, false);
const freeCredits = Number(process.env.TICKET_FREE_CREDITS || 0);
const passCredits = Number(process.env.TICKET_PASS_CREDITS || 11);
const testPassEnabled = parseBoolean(process.env.TICKET_TEST_PASS_ENABLED, false);
const testPassCredits = Number(process.env.TICKET_TEST_PASS_CREDITS || 100);

let storePath = '';
let state = { devices: {} };
let writing = Promise.resolve();

export const config = { ticketEnabled, passCredits, testPassEnabled, testPassCredits };

export async function init(runtimeDir) {
  storePath = path.join(runtimeDir, 'store.json');
  await fs.mkdir(runtimeDir, { recursive: true });
  try {
    state = JSON.parse(await fs.readFile(storePath, 'utf8'));
  } catch {
    state = { devices: {} };
  }
  if (!state.devices) state.devices = {};
}

// deviceId는 프론트가 localStorage에 들고 있는 임의의 문자열이다. 개인정보를 담지 않는다.
export function normalizeDeviceId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.slice(0, 64).replace(/[^A-Za-z0-9_-]/g, '');
}

export function status(deviceId) {
  if (!ticketEnabled) return { ticketEnabled: false, remaining: null, used: 0 };
  const device = state.devices[deviceId];
  if (!device) return { ticketEnabled: true, remaining: freeCredits, used: 0 };
  return { ticketEnabled: true, remaining: Math.max(0, device.remaining || 0), used: device.used || 0 };
}

export async function grant(deviceId, credits, reason = 'grant') {
  const device = ensureDevice(deviceId);
  device.remaining = Math.max(0, (device.remaining || 0) + Number(credits || 0));
  device.grants.push({ credits: Number(credits || 0), reason, at: new Date().toISOString() });
  device.grants = device.grants.slice(-50);
  await persist();
  return status(deviceId);
}

// 같은 chargeKey로 두 번 들어오면 한 번만 깎는다. (재시도·중복 클릭 방어)
export async function consume(deviceId, chargeKey) {
  if (!ticketEnabled) return { ok: true, ...status(deviceId) };
  const device = ensureDevice(deviceId);
  const key = String(chargeKey || '').slice(0, 64);
  if (key && device.charges.includes(key)) return { ok: true, duplicated: true, ...status(deviceId) };
  if ((device.remaining || 0) <= 0) return { ok: false, ...status(deviceId) };

  device.remaining -= 1;
  device.used = (device.used || 0) + 1;
  if (key) device.charges = [...device.charges, key].slice(-200);
  await persist();
  return { ok: true, ...status(deviceId) };
}

export function hasCredit(deviceId) {
  if (!ticketEnabled) return true;
  return status(deviceId).remaining > 0;
}

export function newChargeKey() {
  return `AL-${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
}

function ensureDevice(deviceId) {
  if (!state.devices[deviceId]) {
    state.devices[deviceId] = { remaining: freeCredits, used: 0, charges: [], grants: [], createdAt: new Date().toISOString() };
  }
  const device = state.devices[deviceId];
  if (!Array.isArray(device.charges)) device.charges = [];
  if (!Array.isArray(device.grants)) device.grants = [];
  return device;
}

// 쓰기를 직렬화해 동시 요청이 서로의 결과를 덮어쓰지 않게 한다.
function persist() {
  writing = writing.then(() => fs.writeFile(storePath, JSON.stringify(state, null, 2))).catch(error => {
    console.warn(`[passes] store write failed: ${error.message}`);
  });
  return writing;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}
