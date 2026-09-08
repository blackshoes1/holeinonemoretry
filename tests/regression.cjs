// node --test tests/regression.cjs
// DOM/Web Audio만 대역으로 교체하고, 로직은 실제 game.js에서 읽어 실행한다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'game.js'), 'utf8');
const baseline = execFileSync('git', ['show', 'aec6684:game.js'], { cwd: root, encoding: 'utf8' });
function section(src, start, end) {
  const a = src.indexOf(start), b = src.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `source section: ${start}`);
  return src.slice(a, b);
}
const physics = src => section(src, 'const M_BALL', '// =====================================================================\n// 렌더');
function context(src = source, storage = new Map()) {
  const ctx = vm.createContext({ Math, innerHeight: 800, innerWidth: 400,
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) } });
  vm.runInContext(physics(src), ctx);
  vm.runInContext(section(src, 'const HOLES', 'function refreshGreenMesh'), ctx);
  vm.runInContext(section(src, 'const SWIPE_FULL_V', '// ---- 임팩트 존 HUD'), ctx);
  return { ctx, run: code => vm.runInContext(code, ctx), storage };
}
const plain = value => JSON.parse(JSON.stringify(value));

test('physics core unchanged; bench and aceSweep match the baseline', () => {
  assert.equal(physics(source), physics(baseline));
  const before = context(baseline), after = context();
  const command = '({bench:bench(), sweeps:[100,130,180].map(aceSweep)})';
  const actual = plain(after.run(command));
  assert.deepEqual(actual, plain(before.run(command)));
  console.log('physics:', JSON.stringify(actual));
});

function shot(env, points) {
  env.ctx.points = points;
  return plain(env.run(`(() => {
    const g = makeGesture(points[0].x, points[0].y, points[0].t);
    for (const p of points.slice(1)) gestureMove(g,p.x,p.y,p.t);
    const r = gestureEnd(g);
    return { ...r, impactX:g.impactX, impactV:g.impactV, mph:r && 58+r.power*40 };
  })()`));
}
const p = (t, y, x = 200) => ({ t, y, x });
test('gesture ranges and slow crossing after a fast downswing', () => {
  const env = context();
  const checks = plain(env.run('gestureTest()'));
  assert.equal(checks.pass, true);
  const fast = shot(env, [p(0,300),p(400,660),p(500,420),p(550,300),p(650,60)]);
  const slow = shot(env, [p(0,300),p(400,660),p(450,400),p(1450,300),p(1550,60)]);
  assert.equal(fast.mph,98);
  assert.equal(slow.impactV,100);
  assert.equal(slow.mph,68);
  assert.ok(checks.halfBack.mph < fast.mph);
  assert.ok(checks.hardSlice.tiltDeg >= -15 && checks.hardSlice.tiltDeg <= -13);
  const clamp = shot(env, [p(0,300),p(400,660),p(550,300,600)]);
  assert.equal(clamp.tiltDeg,-15);
  const legacy = shot(env, [p(0,600),p(100,300),p(150,200)]);
  assert.equal(legacy.kind,'legacy');
  assert.equal(legacy.mph,98);
  console.log('gestures:',JSON.stringify({fastMph:fast.mph,slowMph:slow.mph, ...checks}));
});

test('crossing x is interpolated; same linear trajectory at 30/60/120Hz stays within 0.5mph and 0.25 degrees', () => {
  const env = context();
  const interpolated = shot(env,[p(0,300),p(400,660),p(500,340,210),p(550,260,250)]);
  assert.equal(interpolated.impactX,230);
  const samples = hz => {
    const out = [p(0,300),p(400,660)];
    for (let t=400+1000/hz;t<850;t+=1000/hz) out.push(p(t,660-(t-400)*1.2,200+(t-400)*0.15));
    out.push(p(850,120,267.5));
    return out;
  };
  const results = [30,60,120].map(hz=>shot(env,samples(hz)));
  for (const r of results) {
    assert.ok(Math.abs(r.mph-results[0].mph)<=0.5);
    assert.ok(Math.abs(r.tiltDeg-results[0].tiltDeg)<=0.25);
    assert.ok(Math.abs(r.loft-results[0].loft)*40<=0.25);
  }
  console.log('sampling:',JSON.stringify(results.map(({mph,tiltDeg})=>({mph,tiltDeg}))));
});

function record(env, score = 500) {
  return plain(env.run(`({d:dayKey(),w:weekKey(),m:monthKey(),s:${score},a:0})`));
}
test('malformed storage and records do not throw; valid records survive migration', () => {
  for (const raw of ['{','{}','null','1','[null,{},"bad"]']) {
    const env=context(source,new Map([['hio.rounds.v1',raw]]));
    assert.equal(env.run('store.stats().totalPlays'),0);
  }
  const env=context(), valid=record(env,1200);
  env.storage.set('hio.rounds.v1',JSON.stringify([null,valid,{...valid,s:'9000'}, {...valid,a:10}, {...valid,d:'2026-02-30'}]));
  assert.equal(env.run('store.stats().totalPlays'),1);
  assert.deepEqual(plain(env.run('store.load()')),[valid]);
  const saved=env.storage.get('hio.rounds.v2');
  for(let i=0;i<3;i++) assert.equal(env.run('store.stats().totalPlays'),1);
  assert.equal(env.storage.get('hio.rounds.v2'),saved);
  assert.ok(env.storage.has('hio.rounds.v1'));
  const reload=context(source,env.storage);
  assert.equal(reload.run('store.stats().totalPlays'),1);
  env.storage.set('hio.rounds.v2',JSON.stringify({version:2,rounds:[null,valid],best:'bad',total:-1}));
  assert.equal(env.run('store.stats().totalPlays'),1);
  assert.equal(env.run('store.stats().all'),1200);
  assert.deepEqual(plain(env.run('store.load()')),[valid]);
});

test('300 round retention preserves lifetime best/count, including after reload', () => {
  const env=context();
  env.ctx.rec=record(env,9000);
  assert.equal(env.run('store.add(rec)'),true);
  env.ctx.rec=record(env,100);
  for(let i=0;i<305;i++) assert.equal(env.run('store.add(rec)'),true);
  assert.equal(env.run('store.load().length'),300);
  const reload=context(source,env.storage);
  assert.equal(reload.run('store.stats().all'),9000);
  assert.equal(reload.run('store.stats().totalPlays'),306);
});

test('save failure returns false and result UI explicitly says it was not saved', () => {
  const env=context();
  env.ctx.rec=record(env);
  env.run('store.read(); localStorage.setItem=()=>{throw new Error("quota")};');
  assert.equal(env.run('store.add(rec)'),false);
  assert.equal(env.run('store.stats().totalPlays'),0);
  Object.assign(env.ctx,{PHASE:{ROUNDEND:'roundend'},state:{roundScore:500,aces:0,holeScores:[{ace:false,dist:0,score:500}]},ACT:'탭',showMsg:html=>{env.ctx.message=html;},
    telemetry:{track(){}},visitId:'test',document:{getElementById:()=>({addEventListener(){}})},shareRound(){}});
  env.run('statsCache=store.stats()');
  vm.runInContext(section(source,'function endRound()','addEventListener(\'resize\''),env.ctx);
  env.run('endRound()');
  assert.match(env.ctx.message,/이번 결과는 저장되지 않았습니다/);
});

function audioEnv(fetcher) {
  const sources=[], tag={textContent:''}, calls=[];
  const param=()=>({value:0,setTargetAtTime(){},setValueAtTime(){},cancelScheduledValues(){}});
  const node=()=>({connections:[],gain:param(),frequency:param(),Q:param(),threshold:param(),knee:param(),ratio:param(),attack:param(),release:param(),connect(dest){this.connections.push(dest);return dest;}});
  const buffer={duration:3.9,numberOfChannels:2,sampleRate:44100};
  class AudioContext {
    constructor(){this.currentTime=10;this.state='running';this.destination={speaker:true};}
    createGain(){return node();} createDynamicsCompressor(){return node();} createConvolver(){return node();}
    createBufferSource(){const s={...node(),playbackRate:{value:1},start(...args){this.started=args;}};sources.push(s);return s;}
    async decodeAudioData(){return buffer;}
  }
  // The synthesized initialization graph is stubbed; impactHit itself is real production code.
  const SND={ir:()=>null,loopVoice:()=>({gain:node()}),impact:()=>{throw Error('synthesis fallback');}};
  const ctx=vm.createContext({window:{AudioContext},SND,BUILD:'test',document:{getElementById:()=>tag},fetch:async u=>{calls.push(u);return fetcher(u);}});
  vm.runInContext(section(source,'const HIT_ONLY','// ---------- 입력'),ctx);
  return {ctx,tag,calls,sources,buffer,run:code=>vm.runInContext(code,ctx),settle:()=>new Promise(resolve=>setImmediate(resolve))};
}
const ok=()=>({ok:true,arrayBuffer:async()=>new ArrayBuffer(1)});
test('hit-only loads no disabled assets, and impactHit plays the original buffer directly', async () => {
  const env=audioEnv(u=>u.includes('hit.mp3')?ok():({ok:false,status:404}));
  env.run('sfx.unlock()');
  assert.match(env.tag.textContent,/타격음 로딩 중/);
  await env.settle();
  assert.deepEqual(env.calls,['assets/hit.mp3?b=test']);
  assert.match(env.tag.textContent,/타격음 준비됨/);
  // A failed optional bank must not gate the ready hit buffer.
  env.run('bank.ready=false;sfx.impactHit()');
  assert.equal(env.sources.length,1);
  const s=env.sources[0];
  assert.equal(s.buffer,env.buffer);
  assert.equal(s.playbackRate.value,1);
  assert.deepEqual(s.started,[10.005,2.46]);
  assert.equal(s.connections.length,1);
  assert.equal(s.connections[0].speaker,true);
  env.run('sfx.tap();sfx.takeback();sfx.bounce(20,"green",0);sfx.holeIn();sfx.lipout();sfx.miss();sfx.flight(60,1,1,true);sfx.rolling(5,true);sfx.ambient(5)');
  assert.equal(env.sources.length,1);
  env.run('sfx.toggle();sfx.impactHit()');
  assert.equal(env.sources.length,1);
});

test('failed hit stays silent, retries only on user action, and stops after three attempts', async () => {
  const env=audioEnv(()=>({ok:false,status:404}));
  env.run('sfx.unlock();sfx.unlock();sfx.impactHit()');
  assert.equal(env.calls.length,1);
  await env.settle();
  assert.match(env.tag.textContent,/타격음 로드 실패/);
  assert.equal(env.sources.length,0);
  env.run('sfx.impactHit()');
  assert.equal(env.calls.length,1);
  for(let i=0;i<5;i++){env.run('sfx.unlock()');await env.settle();}
  assert.equal(env.calls.length,3);
  assert.equal(env.sources.length,0);
  assert.doesNotMatch(env.tag.textContent,/합성/);
});

test('retry recovers and no subsequent unlock reloads a ready hit', async () => {
  let fail=true;
  const env=audioEnv(()=>fail?({ok:false,status:500}):ok());
  env.run('sfx.unlock()');await env.settle();fail=false;
  env.run('sfx.unlock()');await env.settle();
  assert.match(env.tag.textContent,/준비됨/);
  env.run('sfx.unlock();sfx.impactHit()');
  assert.equal(env.calls.length,2);
  assert.equal(env.sources.length,1);
});

test('B policy: crossing does not flash/fire; release flashes and fires with follow-through loft', () => {
  const env=context(), handlers={}, events=[];
  Object.assign(env.ctx,{betaBlocked:false,renderer:{domElement:{addEventListener:(name,fn)=>handlers[name]=fn}},addEventListener:(name,fn)=>handlers[name]=fn,
    sfx:{unlock(){},takeback(){}},performance:{now:()=>env.ctx.time},time:0,
    state:{phase:'swing'},PHASE:{SWING:'swing',AIM:'aim'},showImpactLine(){},hideImpactLine(){},
    flashImpact:()=>events.push('flash'),fireShot:r=>{events.push('fire');env.ctx.fired=r;},advance(){}});
  vm.runInContext(section(source,"renderer.domElement.addEventListener('pointerdown'","addEventListener('touchmove'"),env.ctx);
  const event={clientX:200,clientY:300,preventDefault(){}};
  handlers.pointerdown(event);
  for(const pt of [p(400,660),p(500,420),p(550,300),p(650,60)]){
    env.ctx.time=pt.t;handlers.pointermove({...event,clientY:pt.y});
    assert.equal(events.length,0);
  }
  handlers.pointerup();
  assert.deepEqual(events,['flash','fire']);
  assert.ok(Math.abs(env.ctx.fired.loft-240/280)<1e-8);
});

test('original mp3 bytes unchanged', () => {
  const before=execFileSync('git',['show','aec6684:assets/hit.mp3'],{cwd:root});
  const after=fs.readFileSync(path.join(root,'assets/hit.mp3'));
  assert.deepEqual(after,before);
  console.log('hit.mp3 sha256:',createHash('sha256').update(after).digest('hex'));
});
