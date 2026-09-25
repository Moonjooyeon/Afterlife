import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { EventEmitter } from 'node:events';

// PostgreSQL runs must explicitly target a dedicated test database.
if (process.env.DATABASE_URL && !new URL(process.env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Use a dedicated *_test database');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'afterlife-test-'));
process.env.TICKET_ENABLED = 'true';
process.env.TICKET_FREE_CREDITS = '0';
process.env.TICKET_PASS_CREDITS = '11';
process.env.TOSS_MTLS_CERT_PATH = path.join(dir, 'fake-cert');
process.env.TOSS_MTLS_KEY_PATH = path.join(dir, 'fake-key');
await fs.writeFile(process.env.TOSS_MTLS_CERT_PATH, 'mock');
await fs.writeFile(process.env.TOSS_MTLS_KEY_PATH, 'mock');
const db = (await import('./database.js')).default;
const passes = await import('./passes.js');
await passes.init(dir, path.join(dir, 'test.sqlite'));
const suffix = db.uuid();

test('grant once, enforce ownership, charge once, persist result and logs', async () => {
  const user = await passes.ensureTossUser(`test-${suffix}`);
  const other = await passes.ensureTossUser(`other-${suffix}`);
  const orderId = `order-${suffix}`;
  await passes.grantIapPass(user, { orderId });
  assert.equal((await passes.grantIapPass(user, { orderId })).duplicated, true);
  await assert.rejects(passes.grantIapPass(other, { orderId }));
  assert.equal((await passes.status(user)).remaining, 11);
  const chargeKey = `charge-${suffix}`;
  const session = await passes.startSession(user, 'solo', chargeKey);
  const result = { text: 'saved' };
  await db.saveSessionResult(session.id, result);
  await passes.consume(user, { sessionId: session.id, chargeKey });
  await passes.consume(user, { sessionId: session.id, chargeKey });
  await assert.rejects(passes.consume(other, { sessionId: session.id, chargeKey }));
  assert.equal((await passes.status(user)).remaining, 10);
  assert.deepEqual(db.readSessionResult(await db.findSessionByChargeKey(chargeKey)), result);
  const request = await db.startGeminiRequest({userId:user.id,sessionId:session.id,keyMode:'test',requestedModel:'test',actualModel:'test',attempt:1});
  await db.finishGeminiRequest(request.id,{ok:true,status:200});
});

test('PostgreSQL concurrent grants and charges never duplicate credits or overspend', { skip: !process.env.DATABASE_URL }, async () => {
  const user = await passes.ensureTossUser(`concurrent-${suffix}`);
  const grants = await Promise.all(Array.from({length:10},()=>passes.grantIapPass(user,{orderId:`parallel-${suffix}`})));
  assert.equal(grants.filter(g=>!g.duplicated).length,1);
  const charged = await Promise.all(Array.from({length:20},(_,i)=>passes.consume(user,{sessionId:null,chargeKey:`parallel-${suffix}-${i}`})));
  assert.equal(charged.filter(c=>c.ok).length,11);
  assert.equal((await passes.status(user)).remaining,0);
  await passes.grantIapPass(user,{orderId:`refund-${suffix}`});
  await db.revokeOrder(`refund-${suffix}`);
  assert.equal((await passes.status(user)).remaining,0);
  await passes.grantIapPass(user,{orderId:`refund-${suffix}`});
  assert.equal((await passes.status(user)).remaining,0);
  const release = await db.lockGeneration(user.id);
  assert.ok(release);
  assert.equal(await db.lockGeneration(user.id),null);
  await release();
});

test('Toss order verification rejects wrong owner, SKU, status and order ID', async () => {
  const toss = await import('./toss.js');
  const original = https.request;
  let response;
  https.request = (options, callback) => {
    assert.equal(options.headers['x-toss-user-key'],'user-1');
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.write = data => assert.equal(JSON.parse(data).orderId,'order-1');
    request.end = () => queueMicrotask(() => {
      const res = new EventEmitter(); res.statusCode=200;res.setEncoding=()=>{};
      callback(res);res.emit('data',JSON.stringify(response));res.emit('end');
    });
    return request;
  };
  const check = ()=>toss.verifyOrder({orderId:'order-1',userKey:'user-1',sku:'sku-1'});
  try {
    response={resultType:'SUCCESS',success:{orderId:'order-1',sku:'sku-1',status:'PURCHASED'}};
    assert.equal((await check()).orderId,'order-1');
    for(const change of [{status:'REFUNDED'},{status:'PENDING'},{sku:'wrong'},{orderId:'wrong'}]) {
      response={resultType:'SUCCESS',success:{orderId:'order-1',sku:'sku-1',status:'PURCHASED',...change}};
      await assert.rejects(check());
    }
    response={resultType:'FAIL',error:{errorCode:'OWNER_MISMATCH'}};
    await assert.rejects(check());
  } finally { https.request=original; }
});

test('AI providers use server credentials, provider model and retry on quota', async () => {
  const {generateJson}=await import('./gemini.js');
  const original=globalThis.fetch;
  const calls=[];
  globalThis.fetch=async (url,options)=>{
    calls.push({url,...options,body:JSON.parse(options.body)});
    return calls.length===1 ? new Response('quota',{status:429}) : Response.json({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]});
  };
  try {
    const result=await generateJson([
      {apiKey:'test-mono',apiBase:'https://monogpt.kr/api/monorouter/v1/gemini',format:'monorouter',modelOverride:'model-a',keyMode:'test'},
      {apiKey:'test-cafe',apiBase:'https://llm-router.cafe24.com',format:'openai',modelOverride:'model-b',keyMode:'test'}
    ],{model:'fallback',system:'system',user:'user'});
    assert.deepEqual(result.data,{ok:true});
    assert.equal(calls[0].headers.Authorization,'Bearer test-mono');
    assert.equal(calls[1].url,'https://llm-router.cafe24.com/api/v1/chat/completions');
    assert.equal(calls[1].body.model,'model-b');
  } finally { globalThis.fetch=original; }
});

test.after(async()=>{await db.close?.();await fs.rm(dir,{recursive:true,force:true});});
