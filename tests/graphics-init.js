// 그래픽 비교 전용 브라우저 init script. 실제 게임에서 로드하지 않는다.
let graphicsSeed = 72319;
Math.random = () => { graphicsSeed = (Math.imul(graphicsSeed, 1664525) + 1013904223) >>> 0; return graphicsSeed / 4294967296; };
try { localStorage.setItem('hio.tutorial.v1', 'done'); localStorage.removeItem('hio.active.v1'); } catch {}
window.measureGraphics = () => new Promise(resolve => {
  const intervals = []; let previous = null, warmup = 30;
  function tick(now) {
    if (warmup > 0) warmup--;
    else if (previous !== null) intervals.push(now - previous);
    previous = now;
    if (intervals.length < 180) requestAnimationFrame(tick);
    else {
      intervals.sort((a,b) => a-b);
      resolve({ samples: intervals.length, medianMs: intervals[90], p95Ms: intervals[171],
        meanMs: intervals.reduce((a,b)=>a+b,0)/intervals.length, ...window.__golf.graphicsStats() });
    }
  }
  requestAnimationFrame(tick);
});
