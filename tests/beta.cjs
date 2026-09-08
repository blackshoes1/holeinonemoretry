const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'game.js'), 'utf8');
const betaSource = fs.readFileSync(path.join(root, 'beta.js'), 'utf8');
const beta = import('data:text/javascript;base64,' + Buffer.from(betaSource).toString('base64'));
function memory() {
  const rows = new Map();
  return { rows, getItem: k => rows.get(k) ?? null, setItem: (k, v) => rows.set(k, v) };
}
// 점수 공식은 실제 game.js에서 읽는다.
const scoreContext = vm.createContext({});
vm.runInContext(source.slice(source.indexOf('const ACE_SCORE'), source.indexOf('// ---------- 기록 저장')), scoreContext);
const score = vm.runInContext('holeScore', scoreContext);
const snapshot = () => ({ id: 'round-1', seed: '2026-09-08', scores: [], shot: null, completedAt: null });

test('tutorial first visit, done, skipped and storage failure are independent of records', async () => {
  const b = await beta, storage = memory();
  storage.setItem('hio.rounds.v2', 'preserve');
  assert.equal(b.tutorialSeen(storage), false);
  assert.equal(b.saveTutorial(storage, 'done'), true);
  assert.equal(b.tutorialSeen(storage), true);
  assert.equal(b.saveTutorial(storage, 'skipped'), true);
  assert.equal(storage.getItem('hio.rounds.v2'), 'preserve');
  storage.setItem = () => { throw Error('quota'); };
  assert.equal(b.saveTutorial(storage, 'done'), false);
});

test('progress preserves seed across midnight, completed holes and replay input across reload', async () => {
  const b = await beta, storage = memory(), progress = b.createProgress(storage, score);
  const s = snapshot();
  s.scores = [{ ace: false, dist: 5, score: score(5, false) }];
  s.shot = { mph: 85, loft: 30, aim: 0.1, tilt: -0.1 };
  assert.equal(progress.save(s), true);
  const restored = b.createProgress(storage, score).read();
  assert.equal(restored.status, 'ready');
  assert.equal(restored.data.seed, '2026-09-08');
  assert.deepEqual(restored.data.shot, s.shot);
  assert.deepEqual(restored.data.scores, s.scores);
  assert.equal(restored.data.scores.length, 1);
});

test('progress rejects incompatible, malformed and impossible data without altering completed records', async () => {
  const b = await beta, storage = memory(), progress = b.createProgress(storage, score);
  storage.setItem('hio.rounds.v2', 'preserve');
  assert.equal(progress.read().status, 'missing');
  for (const raw of ['{', '{}', 'null', '[]']) {
    storage.setItem(b.PROGRESS_KEY, raw);
    assert.ok(['invalid', 'incompatible'].includes(progress.read().status));
  }
  progress.save(snapshot());
  const saved = JSON.parse(storage.getItem(b.PROGRESS_KEY));
  storage.setItem(b.PROGRESS_KEY, JSON.stringify({ ...saved, rules: 'other' }));
  assert.equal(progress.read().status, 'incompatible');
  assert.equal(progress.save({ ...snapshot(), shot: { mph: 999, loft: 30, aim: 0, tilt: 0 } }), false);
  assert.equal(progress.save({ ...snapshot(), seed: '2026-02-30' }), false);
  assert.equal(progress.save({ ...snapshot(), scores: [{ dist: 10, ace: false, score: 9999 }] }), false);
  assert.equal(storage.getItem('hio.rounds.v2'), 'preserve');
  storage.getItem = () => { throw Error('denied'); };
  assert.equal(progress.read().status, 'unavailable');
  storage.setItem = () => { throw Error('quota'); };
  assert.equal(progress.save(snapshot()), false);
});

test('a completed checkpoint can only contain 9 valid holes and a completion timestamp', async () => {
  const b = await beta, progress = b.createProgress(memory(), score);
  const s = snapshot();
  s.scores = Array.from({length:9}, () => ({ ace: true, dist: 0, score: 1000 }));
  assert.equal(progress.save(s), false);
  s.completedAt = '2026-09-09T00:00:01Z';
  assert.equal(progress.save(s), true);
  assert.equal(progress.read().data.completedAt, s.completedAt);
});

test('telemetry is local-only, deduplicates across reload and excludes raw coordinates and PII', async () => {
  const b = await beta, storage = memory(), telemetry = b.createTelemetry(storage);
  assert.equal(telemetry.track('first_shot', { roundId:'round-1', email:'user@example.com', x:200, reason:'raw personal info' }, 'shot-round-1'), true);
  assert.equal(b.createTelemetry(storage).track('first_shot', {}, 'shot-round-1'), false);
  const state = telemetry.snapshot();
  assert.equal(state.mode, 'local-only');
  assert.deepEqual(state.events[0].data, { roundId:'round-1' });
  assert.equal(telemetry.track('unknown'), false);
});

test('storage and async transport failure never block telemetry or trigger retries', async () => {
  const b = await beta, storage = memory(), telemetry = b.createTelemetry(storage);
  storage.setItem = () => { throw Error('quota'); };
  let calls = 0;
  telemetry.setTransport(async () => { calls++; throw Error('network'); });
  assert.equal(telemetry.track('visit'), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(telemetry.snapshot().failures, 2);
  assert.equal(telemetry.snapshot().events.length, 1);
});

test('native share, cancellation, failure and clipboard fallback report actual outcomes', async () => {
  const b = await beta, result = { seed:'2026-09-08', score:1234 };
  let payload;
  assert.deepEqual(await b.shareResult({share:async data=>{payload=data;}}, result), {outcome:'shared',method:'native'});
  assert.match(payload.text, /1234점/);
  assert.match(payload.text, /공식 랭킹 아님/);
  assert.equal(payload.url, 'https://holeinonemoretry.vercel.app/');
  assert.equal((await b.shareResult({share:async()=>{throw {name:'AbortError'};}},result)).outcome,'cancelled');
  assert.equal((await b.shareResult({share:async()=>{throw Error();}},result)).outcome,'failed');
  assert.equal((await b.shareResult({clipboard:{writeText:async text=>{payload=text;}}},result)).outcome,'copied');
  assert.match(payload,/2026-09-08/);
  assert.equal((await b.shareResult({clipboard:{writeText:async()=>{throw Error();}}},result)).outcome,'failed');
  assert.equal((await b.shareResult({},result)).outcome,'failed');
});

test('completed record round id prevents duplicate saves after restoring a checkpoint', () => {
  const storage = memory(), ctx = vm.createContext({localStorage:storage});
  vm.runInContext(source.slice(source.indexOf('const HOLES'), source.indexOf('function refreshGreenMesh')),ctx);
  vm.runInContext(`const rec={id:'round-1',d:'2026-09-08',w:'2026-W37',m:'2026-09',s:1000,a:1};`,ctx);
  assert.equal(vm.runInContext('store.add(rec)',ctx), true);
  assert.equal(vm.runInContext('store.add(rec)',ctx), true);
  assert.equal(vm.runInContext('store.stats().totalPlays',ctx), 1);
  assert.equal(vm.runInContext('store.load().length',ctx), 1);
});
