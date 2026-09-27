import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const questions = JSON.parse(fs.readFileSync(new URL('../data/questions.json', import.meta.url)));
const source = fs.readFileSync(new URL('./src/main.js', import.meta.url), 'utf8')
  .replace("import questions from '../../data/questions.json';", '')
  .replaceAll('import.meta.env', '({})');

function app(fetch) {
  const ids = new Map();
  class Element {
    nodeType = 1; children = []; attrs = {}; listeners = {}; disabled = false;
    classList = { add() {}, remove() {}, toggle() {} };
    setAttribute(k, v) { this.attrs[k] = v; if (k === 'id') ids.set(v, this); }
    getAttribute(k) { return this.attrs[k]; }
    addEventListener(k, f) { this.listeners[k] = f; }
    append(...kids) { this.children.push(...kids); }
    replaceChildren(...kids) { this.children = kids; }
    set textContent(value) { this.children = [String(value)]; }
    get textContent() { return this.children.map(x => typeof x === 'string' ? x : x.textContent).join(''); }
  }
  const document = { createElement: () => new Element(), createTextNode: s => ({nodeType:3,textContent:s}),
    getElementById: id => { if (!ids.has(id)) ids.set(id, new Element()); return ids.get(id); },
    querySelectorAll: () => [] };
  const context = vm.createContext({ questions, document, fetch, console: {error() {}},
    localStorage: {getItem() {return null;},setItem() {},removeItem() {}},
    crypto: {randomUUID: () => 'test-device'}, window: {addEventListener() {}}, setTimeout });
  vm.runInContext(source, context);
  return { context, get: document.getElementById };
}

test('questions remain complete during loading and mode switches; submission stays blocked on config failure', async () => {
  let reject;
  const a = app(() => new Promise((_, r) => { reject = r; }));
  assert.match(a.get('form').textContent, /関係|관계의 온도/);
  assert.equal(a.get('btn-submit').disabled, true);
  a.get('mode-solo').listeners.click();
  assert.match(a.get('form').textContent, /받을 사람/);
  reject(new Error('offline'));
  await new Promise(r => setImmediate(r));
  a.get('mode-pair').listeners.click();
  assert.match(a.get('form').textContent, /떠난 방식/);
  assert.equal(a.get('btn-submit').disabled, true);
});

test('logged-out visitor gets login action before name validation or generation', async () => {
  const a = app(async () => ({ok:true,json:async () => ({loginEnabled:true,ticketEnabled:true,iapEnabled:false})}));
  await new Promise(r => setImmediate(r));
  assert.equal(a.get('btn-submit').textContent, '토스 로그인');
  assert.equal(a.get('btn-submit').disabled, false);
  vm.runInContext('onLogin = () => { globalThis.loginRequested = true; }; onSubmit();', a.context);
  assert.equal(a.context.loginRequested, true);
  assert.equal(a.get('form-err').textContent, '');
});
