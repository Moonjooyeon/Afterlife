import './env.js';
import pg from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const context = new AsyncLocalStorage();
let auditSalt;
export const nowIso = () => new Date().toISOString();
export const uuid = () => crypto.randomUUID();
const query = (sql, args = []) => (context.getStore() || pool).query(sql, args);
const one = async (sql, args) => (await query(sql, args)).rows[0] || null;

export async function transaction(fn) {
  if (context.getStore()) return fn();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await context.run(client, fn);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function open() {
  await query(await fs.readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  await query('INSERT INTO app_settings(key,value,updated_at) VALUES ($1,$2,$3) ON CONFLICT(key) DO NOTHING', ['audit_salt', crypto.randomBytes(24).toString('hex'), nowIso()]);
  auditSalt = await getSetting('audit_salt');
  return 'postgresql';
}
export const close = () => pool.end();
export const getSetting = async key => (await one('SELECT value FROM app_settings WHERE key=$1', [key]))?.value ?? null;
export const setSetting = (key,value) => query('INSERT INTO app_settings(key,value,updated_at) VALUES ($1,$2,$3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at', [key,String(value),nowIso()]);
export const findUser = loginId => one('SELECT * FROM app_users WHERE login_id=$1',[loginId]);
export const findUserById = id => one('SELECT * FROM app_users WHERE id=$1',[id]);
export async function ensureUser(loginId, displayName='', meta={}) {
  const user = await one('INSERT INTO app_users(id,login_id,display_name,created_at,updated_at) VALUES($1,$2,$3,$4,$4) ON CONFLICT(login_id) DO UPDATE SET login_id=excluded.login_id RETURNING *',[uuid(),loginId,displayName,nowIso()]);
  return user;
}
export const setDisplayName = (id,name) => query('UPDATE app_users SET display_name=$1,updated_at=$2 WHERE id=$3',[name,nowIso(),id]);
export async function touchLogin(id,meta={}) {
  await query('UPDATE app_users SET last_login_at=$1,updated_at=$1 WHERE id=$2',[nowIso(),id]);
  await audit({userId:id,action:'user.login',meta});
}
export const createOrder = ({userId,orderId=null,provider,sku='',displayName='',amount=0,credits,status='captured'}) => one('INSERT INTO purchase_orders(id,user_id,order_id,provider,sku,display_name,amount,credits,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',[uuid(),userId,orderId,provider,sku,displayName,amount,credits,status,nowIso()]);
export const findOrderByOrderId = id => one('SELECT * FROM purchase_orders WHERE order_id=$1',[id]);
export const findPassByOrder = id => one('SELECT * FROM access_passes WHERE order_id=$1',[id]);
export const createPass = ({userId,orderId=null,credits,expiresAt=null}) => one("INSERT INTO access_passes(id,user_id,order_id,status,usage_limit,used_count,expires_at,created_at,updated_at) VALUES($1,$2,$3,'active',$4,0,$5,$6,$6) RETURNING *",[uuid(),userId,orderId,credits,expiresAt,nowIso()]);
export const activePasses = async userId => (await query("SELECT * FROM access_passes WHERE user_id=$1 AND status='active' AND used_count<usage_limit AND (expires_at IS NULL OR expires_at>$2) ORDER BY created_at,id",[userId,nowIso()])).rows;
export const remainingCredits = async id => (await activePasses(id)).reduce((sum,p)=>sum+p.usage_limit-p.used_count,0);
export const usedCount = async id => Number((await one('SELECT count(*) AS n FROM access_pass_charges WHERE user_id=$1',[id])).n);
export const findCharge = id => one('SELECT * FROM access_pass_charges WHERE charge_key=$1',[id]);
export const lockOrder = id => query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[id]);
export async function lockGeneration(userId) {
  const client = await pool.connect();
  const key = `generation:${userId}`;
  try {
    const result = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[key]);
    if (!result.rows[0].locked) { client.release(); return null; }
    return async () => {
      try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]); }
      finally { client.release(); }
    };
  } catch(error) {client.release();throw error;}
}
export async function chargePass({userId,passId,sessionId,chargeKey}) {
  return transaction(async()=> {
    await query('SELECT id FROM app_users WHERE id=$1 FOR UPDATE',[userId]);
    const existing = await findCharge(chargeKey);
    if (existing) { if(existing.user_id!==userId) throw new Error('요청 소유자가 다릅니다.'); return existing; }
    const pass = await one("UPDATE access_passes SET used_count=used_count+1,status=CASE WHEN used_count+1>=usage_limit THEN 'exhausted' ELSE 'active' END,updated_at=$1 WHERE id=$2 AND user_id=$3 AND status='active' AND used_count<usage_limit AND (expires_at IS NULL OR expires_at>$1) RETURNING *",[nowIso(),passId,userId]);
    if (!pass) return null;
    return one('INSERT INTO access_pass_charges(id,user_id,access_pass_id,session_id,charge_key,created_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[uuid(),userId,passId,sessionId,chargeKey,nowIso()]);
  });
}
export const startSession = ({userId,passId=null,chargeKey=null,mode=''}) => one("INSERT INTO usage_sessions(id,user_id,access_pass_id,charge_key,mode,status,started_at) VALUES($1,$2,$3,$4,$5,'started',$6) RETURNING *",[uuid(),userId,passId,chargeKey,mode,nowIso()]);
export const finishSession = (id,status) => query('UPDATE usage_sessions SET status=$1,finished_at=$2 WHERE id=$3',[status,nowIso(),id]);
export const findSessionByChargeKey = key => one('SELECT * FROM usage_sessions WHERE charge_key=$1',[key]);
export const saveSessionResult = (id,result) => query('UPDATE usage_sessions SET result=$1,result_saved_at=$2 WHERE id=$3',[JSON.stringify(result),nowIso(),id]);
export function readSessionResult(session) { try {return JSON.parse(session?.result || 'null');} catch {return null;} }
export const pruneResults = async days => days>0 ? (await query('UPDATE usage_sessions SET result=NULL,result_saved_at=NULL WHERE result IS NOT NULL AND result_saved_at<$1',[new Date(Date.now()-days*86400000).toISOString()])).rowCount : 0;
export const startGeminiRequest = ({userId,sessionId,keyMode,requestedModel,actualModel,attempt}) => one('INSERT INTO gemini_requests(id,user_id,session_id,key_mode,requested_model,actual_model,attempt,started_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[uuid(),userId,sessionId,keyMode,requestedModel,actualModel,attempt,nowIso()]);
export const finishGeminiRequest = (id,{ok,status=null,errorMessage=null}) => query('UPDATE gemini_requests SET ok=$1,status=$2,error_message=$3,finished_at=$4 WHERE id=$5',[ok?1:0,status,errorMessage?String(errorMessage).slice(0,500):null,nowIso(),id]);
export const hashValue = value => value ? crypto.createHash('sha256').update(`${auditSalt}:${value}`).digest('hex').slice(0,32) : null;
export const requestMeta = req => ({ip:String(req.headers['x-forwarded-for']||'').split(',')[0].trim()||req.socket?.remoteAddress||'',userAgent:String(req.headers['user-agent']||'')});
export const audit = ({userId=null,action,detail={},meta={}}) => query('INSERT INTO audit_logs(user_id,action,detail,ip_hash,user_agent_hash,created_at) VALUES($1,$2,$3,$4,$5,$6)',[userId,action,JSON.stringify(detail).slice(0,2000),hashValue(meta.ip),hashValue(meta.userAgent),nowIso()]);
