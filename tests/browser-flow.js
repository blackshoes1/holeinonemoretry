// 로컬 전용: 400x800 테스트 브라우저에서 agent-browser eval --stdin < tests/browser-flow.js
// 설치 후 await playTestHole()을 9회 호출하고 finishTestRound()으로 저장을 확인한다.
(() => {
  const g = window.__golf, canvas = document.querySelector('canvas');
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const send = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, {
    clientX: x, clientY: y, bubbles: true, pointerId: 1, pointerType: 'touch',
  }));
  const tap = () => { send('pointerdown', 200, 300); send('pointerup', 200, 300); };
  window.golfFlow = [];
  let hitCount = 0;
  const hit = g.sfx.impactHit;
  g.sfx.impactHit = function(...args) { hitCount++; return hit.apply(this, args); };
  const beforeTotal = g.store.stats().totalPlays;
  window.startTestShot = async function() {
    if (g.state.phase === 'result') tap();
    if (g.state.phase === 'aim') {
      send('pointerdown', 200, 500); send('pointermove', 210, 500); send('pointerup', 210, 500);
      if (g.state.phase !== 'aim') throw Error('aim drag unexpectedly advanced');
      tap();
    }
    if (g.state.phase !== 'swing') throw Error('not in swing');
    const before = hitCount;
    send('pointerdown', 200, 300);
    await wait(400); send('pointermove', 200, 660);
    await wait(100); send('pointermove', 200, 420);
    await wait(50); send('pointermove', 200, 300);
    const crossing = { phase: g.state.phase,
      flash: document.getElementById('impactHint').classList.contains('on'), hits: hitCount - before };
    if (crossing.phase !== 'swing' || crossing.flash || crossing.hits) throw Error('early impact');
    await wait(100); send('pointermove', 200, 60);
    send('pointerup', 200, 60);
    if (g.state.phase !== 'fly' || hitCount !== before + 1 ||
        !document.getElementById('impactHint').classList.contains('on')) throw Error('release impact failed');
    return crossing;
  };
  window.playTestHole = async function() {
    const crossing = await window.startTestShot();
    const deadline = Date.now() + 16000;
    while (g.state.phase === 'fly' && Date.now() < deadline) await wait(100);
    if (g.state.phase !== 'result') throw Error('shot timed out');
    const result = { hole: g.state.holeIdx + 1, crossing, score: g.state.roundScore,
      loft: 10 + g.state.loft * 40, hitStatus: g.bank.impactStatus };
    window.golfFlow.push(result);
    return result;
  };
  window.finishTestRound = function() {
    if (golfFlow.length !== 9 || g.state.holeIdx !== 8) throw Error('9 holes not complete');
    tap();
    if (g.state.phase !== 'roundend') throw Error('round not ended');
    const stats = g.store.stats(), records = g.store.load();
    if (stats.totalPlays !== beforeTotal + 1 || records.at(-1).s !== g.state.roundScore) throw Error('save mismatch');
    g.sfx.impactHit = hit;
    return { pass: true, holes: golfFlow.length, hits: hitCount, score: g.state.roundScore, stats };
  };
  return 'Local browser flow ready';
})()
