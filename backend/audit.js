import crypto from 'node:crypto';
export function hasAuditAccess(req, expected = process.env.AUDIT_LOG_TOKEN || '') {
  const header = String(req.headers.authorization || '');
  const supplied = header.startsWith('Bearer ') ? header.slice(7).trim() : String(req.headers['x-audit-token'] || '');
  const a = Buffer.from(supplied), b = Buffer.from(expected);
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}
export function auditLimit(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(500, Math.max(1, Math.floor(n))) : 100;
}
export function clientErrorDetail(value) {
  const data = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const clean = (v, max) => String(v || '').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/((?:api[_-]?key|access[_-]?token|authorizationCode|token)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]').slice(0, max);
  return { kind: clean(data.kind || 'unknown', 40), name: clean(data.name || 'Error', 80), message: clean(data.message, 600), phase: clean(data.phase || 'unknown', 80), reportMode: clean(data.reportMode, 40) };
}
export function publicAuditRow(row) {
  let metadata = {}; try { metadata = JSON.parse(row.detail); } catch {}
  return { id: row.id, userId: row.user_id, loginId: row.login_id, displayName: row.display_name, eventType: row.action, metadata, createdAt: row.created_at };
}
