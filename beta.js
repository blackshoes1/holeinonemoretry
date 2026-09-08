// 베타 지원 로직. 네트워크 연결은 없으며 게임 물리와 독립적이다.
export const PROGRESS_KEY = 'hio.active.v1';
export const RULES_VERSION = 'golf-1';
export const TUTORIAL_KEY = 'hio.tutorial.v1';
const EVENT_KEY = 'hio.events.v1';
const EVENTS = new Set(['visit', 'round_start', 'first_shot', 'hole_complete', 'round_complete',
  'retry', 'share', 'restore', 'save_failed', 'runtime_error', 'tutorial']);

export function createTelemetry(storage) {
  let rows = [], transport = null, failures = 0;
  try {
    const saved = JSON.parse(storage.getItem(EVENT_KEY));
    if (Array.isArray(saved)) rows = saved.filter(r => r && EVENTS.has(r.name) && typeof r.id === 'string').slice(-300);
  } catch {}
  return {
    // 외부 서비스 승인 전 기본값 null. 연결하더라도 과거 로컬 이벤트를 소급 전송하지 않는다.
    setTransport(fn) { transport = typeof fn === 'function' ? fn : null; },
    track(name, fields = {}, id = crypto.randomUUID()) {
      if (!EVENTS.has(name) || rows.some(r => r.id === id)) return false;
      const data = {};
      for (const key of ['roundId', 'seed', 'method', 'outcome', 'reason']) {
        if (typeof fields[key] === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(fields[key])) data[key] = fields[key];
      }
      for (const key of ['hole', 'score']) if (Number.isFinite(fields[key])) data[key] = fields[key];
      const row = { id, name, at: new Date().toISOString(), data };
      rows.push(row); rows = rows.slice(-300);
      try { storage.setItem(EVENT_KEY, JSON.stringify(rows)); } catch { failures++; }
      if (transport) Promise.resolve().then(() => transport(structuredClone(row))).catch(() => { failures++; });
      return true;
    },
    snapshot() { return { mode: transport ? 'custom-transport' : 'local-only', failures, events: structuredClone(rows) }; },
  };
}

export function createProgress(storage, scoreForHole) {
  function valid(s) {
    if (!s || typeof s.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(s.id) ||
        typeof s.seed !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.seed)) return false;
    const date = new Date(s.seed + 'T12:00:00Z');
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== s.seed) return false;
    if (!Array.isArray(s.scores) || s.scores.length > 9 || !s.scores.every(h =>
      h && typeof h.ace === 'boolean' && Number.isFinite(h.dist) && h.dist >= 0 &&
      (!h.ace || h.dist === 0) && h.score === scoreForHole(h.dist, h.ace))) return false;
    if (s.scores.length === 9) {
      if (s.shot !== null || typeof s.completedAt !== 'string' || !Number.isFinite(Date.parse(s.completedAt))) return false;
    } else if (s.completedAt !== null) return false;
    if (s.shot !== null) {
      const p = s.shot;
      if (!p || !['mph', 'loft', 'aim', 'tilt'].every(k => Number.isFinite(p[k])) ||
          p.mph < 58 || p.mph > 98 || p.loft < 10 || p.loft > 50 || Math.abs(p.tilt) > Math.PI / 12 + 1e-9) return false;
    }
    return true;
  }
  return {
    read() {
      let raw;
      try { raw = storage.getItem(PROGRESS_KEY); } catch { return { status: 'unavailable' }; }
      if (raw === null) return { status: 'missing' };
      let data;
      try { data = JSON.parse(raw); } catch { return { status: 'invalid' }; }
      if (!data || data.version !== 1 || data.rules !== RULES_VERSION) return { status: 'incompatible' };
      return valid(data) ? { status: 'ready', data } : { status: 'invalid' };
    },
    save(snapshot) {
      if (!valid(snapshot)) return false;
      try {
        storage.setItem(PROGRESS_KEY, JSON.stringify({ ...snapshot, version: 1, rules: RULES_VERSION }));
        return true;
      } catch { return false; }
    },
  };
}

export function tutorialSeen(storage) {
  try { return ['done', 'skipped'].includes(storage.getItem(TUTORIAL_KEY)); } catch { return false; }
}
export function saveTutorial(storage, outcome) {
  if (!['done', 'skipped'].includes(outcome)) return false;
  try { storage.setItem(TUTORIAL_KEY, outcome); return true; } catch { return false; }
}

export async function shareResult(nav, result) {
  const text = `Hole in One — ${result.seed} 코스\n9홀 ${result.score}점 · 기기 내 개인 기록 (공식 랭킹 아님)`;
  const url = 'https://holeinonemoretry.vercel.app/';
  if (typeof nav.share === 'function') {
    try { await nav.share({ title: '9홀 홀인원 챌린지', text, url }); return { outcome: 'shared', method: 'native' }; }
    catch (e) {
      if (e?.name === 'AbortError') return { outcome: 'cancelled', method: 'native' };
      return { outcome: 'failed', method: 'native' };
    }
  }
  try {
    if (!nav.clipboard?.writeText) return { outcome: 'failed', method: 'clipboard' };
    await nav.clipboard.writeText(text + '\n' + url);
    return { outcome: 'copied', method: 'clipboard' };
  } catch { return { outcome: 'failed', method: 'clipboard' }; }
}
