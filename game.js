import * as THREE from 'three';

// =====================================================================
// 오디오 샘플 출처 (모두 CC0 / Public Domain — freesound.org)
// 각 원본에서 트랜지언트가 파일 맨 앞(약 1.5 ms)에 오도록 잘라 모노 정규화함.
// 앞쪽 여백이 10~40 ms 남아 있으면 타격음이 뭉개지고 화면보다 늦게 들린다.
//  - assets/hit.m4a         "golf swing.mp3" — jcampbe8 (타격 구간만, 사용자 청음 선정)
//      https://freesound.org/people/jcampbe8/sounds/638884/
//  - assets/cup.m4a         "Golf ball in hole.wav" — Scottrex05
//      https://freesound.org/people/Scottrex05/sounds/593482/
//  - assets/land-grass.m4a  "Tennis Bounce Ball on Grass" — jamesdrake89
//      https://freesound.org/people/jamesdrake89/sounds/662258/
//  - assets/land-sand.m4a   "Hard Impact on Sand" — Elements-Library
//      https://freesound.org/people/Elements-Library/sounds/683788/
// =====================================================================

// =====================================================================
// 물리 코어 — 실측 단위 (렌더와 완전 분리, 헤드리스 테스트 공용)
// =====================================================================
// 출처:
//  - 공 질량/반지름: R&A·USGA 규격 (≤45.93 g, ≥42.67 mm 지름)
//  - 공기밀도: 해수면 표준대기 1.225 kg/m³
//  - Cd/Cl 스핀비 선형 근사: Bearman & Harvey(1976) 딤플볼 풍동 실측 계열,
//    아래 계수는 TrackMan PGA 투어 평균 캐리에 맞춰 튜닝 (벤치마크는 window.__golf.bench)
//  - 스핀 감쇠 시정수 ~25 s: Smits & Smith(1994)
const M_BALL   = 0.04593;              // kg
const R_BALL   = 0.02135;              // m (물리 반지름)
const RHO      = 1.225;                // kg/m³
const AREA     = Math.PI * R_BALL * R_BALL;
const GRAV     = 9.81;                 // m/s²
const SPIN_TAU = 25;                   // s, 스핀 지수감쇠 시정수
// Cd = CD0 + CD_S·S, Cl = min(CL_S·S, CL_MAX), S = min(ωr/|v|, S_MAX)
// 계수는 TrackMan PGA 투어 평균 벤치마크에 피팅한 값:
//   드라이버(볼 167 mph·2700 rpm·11°) → 269 yd (목표 270, −0.4 %)
//   7아이언(볼 120 mph·7100 rpm·16°) → 172 yd (목표 172, +0.0 %)
const CD0      = 0.15;
const CD_S     = 0.80;
const CL_S     = 1.50;
const CL_MAX   = 0.30;
const S_MAX    = 0.22;                 // 스핀비 클램프
const MPH      = 0.44704;              // mph → m/s
const YD       = 0.9144;               // yd → m

// VISUAL_SCALE: 렌더/게임 판정용 과장 크기 — 공력 계산과 완전 디커플링
const BALL_VIS_R = 0.4;                // 렌더 공 반지름 · 지면 접촉 높이
const HOLE_R     = 1.75;               // 게임성 위해 과장 유지 (실제 0.054 m로 줄이지 않음)
const T_FALL     = Math.sqrt(2 * BALL_VIS_R / GRAV); // 홀 통과 중 공 반지름만큼 낙하하는 시간

// 임팩트 모델 (TrackMan 통계 근사)
const HEAD_MIN = 58, HEAD_MAX = 98;    // mph — 파워 바 범위 (밸런스 스윕으로 결정)
const LOFT_MIN = 10, LOFT_MAX = 50;    // ° — 다이내믹 로프트 바 범위
function smashFactor(loftDeg) { return 1.5 - 0.2 * (loftDeg - 10) / 40; }        // 1.5 → 1.3
function launchOfLoft(loftDeg) { return loftDeg * 0.85; }                        // 발사각 ≈ 로프트×0.85
function rpmOfLoft(loftDeg) { return 250 + 215 * loftDeg; }                      // 드라이버~2500 · 웨지~10000

// 지면/구름: 구름 저항은 등감속 a = −μ·g  (μ: 스팀프미터 환산 근사)
// firm(경도)은 바운스 반발과 결합
// name은 착지음 질감 분기에만 쓰이는 라벨 — 물리 계산에는 관여하지 않는다
const SURF = {
  green:   { name: 'green',   mu: 0.10, firm: 0.35 },
  fairway: { name: 'fairway', mu: 0.14, firm: 0.50 },
  rough:   { name: 'rough',   mu: 0.35, firm: 0.30 },
  sand:    { name: 'sand',    mu: 1.50, firm: 0.05 },
};

const FAIRWAY_W  = 14;
const GREEN_R    = 16;
const STOP_SPEED = 0.3;
// 배포 식별자 — index.html의 game.js?b= 와 맞춰 캐시를 깨고, 화면 구석에 표시한다.
// 값이 같으면 브라우저가 옛 코드를 실행 중인 것.
const BUILD = '0815j';
const SUB        = 1 / 480;            // 고정 물리 스텝
const SPIN_K     = Math.exp(-SUB / SPIN_TAU);
const FLY_TIMEOUT= 12;

function makeSim() {
  return {
    px: 0, py: BALL_VIS_R, pz: 0,
    vx: 0, vy: 0, vz: 0,
    spin: 0,                  // rad/s
    axx: 0, axy: 0, axz: 0,   // 스핀축 단위벡터
    grounded: true,
    time: 0,
    lipCool: 0, lipped: false,
    windX: 0, windZ: 0,       // 기준고도 2 m 풍속
    gustA: 0, gustB: 0,       // 돌풍 위상
    holeX: 0, holeZ: 100,
    slopeX: 0, slopeZ: 0,     // 그린 경사 그래디언트 (dh/dx, dh/dz)
    bunkerX: 0, bunkerZ: 70,
  };
}

function smoothstep(a, b, x) {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

// 그린 높이 함수 — 시각 메시와 물리가 이 함수를 공유
function greenH(sim, x, z) {
  const dx = x - sim.holeX, dz = z - sim.holeZ;
  const d = Math.hypot(dx, dz);
  if (d >= GREEN_R) return 0;
  const w = 1 - smoothstep(GREEN_R * 0.55, GREEN_R, d); // 림에서 0으로 수렴
  return (sim.slopeX * dx + sim.slopeZ * dz) * w;
}
function groundH(sim, x, z) { return greenH(sim, x, z); }
function groundGrad(sim, x, z, out) { // 수치 미분 (물리·시각 일관성 보장)
  const e = 0.25;
  out.x = (greenH(sim, x + e, z) - greenH(sim, x - e, z)) / (2 * e);
  out.z = (greenH(sim, x, z + e) - greenH(sim, x, z - e)) / (2 * e);
}

function surfaceAt(sim, x, z) {
  const bdx = x - sim.bunkerX, bdz = z - sim.bunkerZ;
  if (bdx * bdx + bdz * bdz < 36) return SURF.sand;
  const gdx = x - sim.holeX, gdz = z - sim.holeZ;
  if (gdx * gdx + gdz * gdz < GREEN_R * GREEN_R) return SURF.green;
  if (Math.abs(x) <= FAIRWAY_W && z >= -20 && z <= 350) return SURF.fairway;
  return SURF.rough;
}

// 고도별 풍속: 멱법칙 프로파일 (지수 0.14, 기준고도 2 m) + 저주파 돌풍
function windFactor(sim, y) {
  const gust = 1 + 0.22 * Math.sin(sim.time * 1.31 + sim.gustA) * Math.sin(sim.time * 0.47 + sim.gustB);
  return Math.pow(Math.max(y, 0.5) / 2, 0.14) * gust;
}

// 공력 가속도: F_drag = ½ρACd|v_rel|² (−v̂_rel), F_lift = ½ρACl|v_rel|² (ω̂×v̂_rel)
const _acc = { x: 0, y: 0, z: 0 };
function airAccel(sim, px, py, pz, vx, vy, vz) {
  const wf = windFactor(sim, py);
  const rx = vx - sim.windX * wf, ry = vy, rz = vz - sim.windZ * wf;
  const rs = Math.hypot(rx, ry, rz) || 1e-9;
  const S  = Math.min(sim.spin * R_BALL / rs, S_MAX);
  const cd = CD0 + CD_S * S;
  const cl = Math.min(CL_S * S, CL_MAX);
  const q  = 0.5 * RHO * AREA * rs / M_BALL;   // (â×r_vec)·q·cl == ½ρACl|v|²/M · (â×r̂)
  _acc.x = -q * cd * rx + q * cl * (sim.axy * rz - sim.axz * ry);
  _acc.y = -q * cd * ry + q * cl * (sim.axz * rx - sim.axx * rz) - GRAV;
  _acc.z = -q * cd * rz + q * cl * (sim.axx * ry - sim.axy * rx);
  return _acc;
}

// RK4 고정 스텝 (비행 단계)
function rk4Air(sim, h) {
  const { px, py, pz, vx, vy, vz } = sim;
  let a = airAccel(sim, px, py, pz, vx, vy, vz);
  const k1x = a.x, k1y = a.y, k1z = a.z;
  const v1x = vx + k1x * h / 2, v1y = vy + k1y * h / 2, v1z = vz + k1z * h / 2;
  a = airAccel(sim, px + vx * h / 2, py + vy * h / 2, pz + vz * h / 2, v1x, v1y, v1z);
  const k2x = a.x, k2y = a.y, k2z = a.z;
  const v2x = vx + k2x * h / 2, v2y = vy + k2y * h / 2, v2z = vz + k2z * h / 2;
  a = airAccel(sim, px + v1x * h / 2, py + v1y * h / 2, pz + v1z * h / 2, v2x, v2y, v2z);
  const k3x = a.x, k3y = a.y, k3z = a.z;
  const v3x = vx + k3x * h, v3y = vy + k3y * h, v3z = vz + k3z * h;
  a = airAccel(sim, px + v2x * h, py + v2y * h, pz + v2z * h, v3x, v3y, v3z);
  const k4x = a.x, k4y = a.y, k4z = a.z;

  sim.px += h / 6 * (vx + 2 * v1x + 2 * v2x + v3x);
  sim.py += h / 6 * (vy + 2 * v1y + 2 * v2y + v3y);
  sim.pz += h / 6 * (vz + 2 * v1z + 2 * v2z + v3z);
  sim.vx += h / 6 * (k1x + 2 * k2x + 2 * k3x + k4x);
  sim.vy += h / 6 * (k1y + 2 * k2y + 2 * k3y + k4y);
  sim.vz += h / 6 * (k1z + 2 * k2z + 2 * k3z + k4z);
  sim.spin *= SPIN_K;
}

// 임팩트(클럽→공): 스매시팩터·발사각·백스핀 (+ 사이드스핀 축 틸트)
function launch(sim, headMph, loftDeg, aim, tiltRad = 0) {
  const ballSpd = headMph * MPH * smashFactor(loftDeg);
  const la = launchOfLoft(loftDeg) * Math.PI / 180;
  const dx = Math.sin(aim), dz = Math.cos(aim);
  const h = ballSpd * Math.cos(la);
  sim.vx = dx * h; sim.vy = ballSpd * Math.sin(la); sim.vz = dz * h;
  sim.spin = rpmOfLoft(loftDeg) * Math.PI * 2 / 60;
  // 백스핀 축 = v̂_h × up 을 진행축 기준 tiltRad만큼 회전
  // (틸트 → 마그누스 양력에 좌우 성분 → 슬라이스/훅 커브. tilt>0 = 좌커브)
  const ct = Math.cos(tiltRad), st = Math.sin(tiltRad);
  sim.axx = -dz * ct; sim.axy = -st; sim.axz = dx * ct;
  sim.grounded = false;
  sim.lipped = false;
  sim.time = 0;
}

const _grad = { x: 0, z: 0 };
function physStep(sim, h, fxImpact) {
  sim.time += h;
  if (sim.lipCool > 0) sim.lipCool -= h;
  const gh = groundH(sim, sim.px, sim.pz) + BALL_VIS_R;

  if (!sim.grounded) {
    rk4Air(sim, h);
    if (sim.py <= gh && sim.vy < 0) {
      sim.py = gh;
      const surf = surfaceAt(sim, sim.px, sim.pz);
      const vh = Math.hypot(sim.vx, sim.vz);
      const sp = Math.hypot(vh, sim.vy) || 1e-9;
      const sinPhi = Math.abs(sim.vy) / sp;       // 입사각 (급할수록 1)
      if (-sim.vy > 1.5) {
        if (fxImpact) fxImpact(sim.px, sim.pz, sim.vy, surf.name);
        // 반발계수: 얕은 각 → 잘 튀고, 급한 각 → 죽음. 노면 경도로 스케일
        const e = Math.min(Math.max(surf.firm * (0.85 - 0.6 * sinPhi), 0.04), 0.5);
        sim.vy = -sim.vy * e;
        // 접선: 노면 마찰 감속 + 백스핀 바이트 (강한 스핀은 뒤로 뺌)
        const spinSurf = sim.spin * R_BALL;       // 표면 상대속도 (m/s)
        const kt = 0.15 + 0.55 * surf.firm;
        const bite = 0.35 * sinPhi * spinSurf;
        if (vh > 1e-6) {
          const ux = sim.vx / vh, uz = sim.vz / vh;
          const vt = Math.max(vh * kt - bite, -vh * 0.35);
          sim.vx = ux * vt; sim.vz = uz * vt;
        }
        sim.spin *= 0.55;
      } else {
        sim.vy = 0;
        sim.grounded = true;
      }
    }
  } else {
    // 구름: 등감속 μ·g + 그린 경사 중력 성분, 지형 추종
    const surf = surfaceAt(sim, sim.px, sim.pz);
    const vh = Math.hypot(sim.vx, sim.vz);
    if (vh > 1e-6) {
      const dec = surf.mu * GRAV * h;
      const k = Math.max(vh - dec, 0) / vh;
      sim.vx *= k; sim.vz *= k;
    }
    groundGrad(sim, sim.px, sim.pz, _grad);
    sim.vx -= GRAV * _grad.x * h;
    sim.vz -= GRAV * _grad.z * h;
    sim.px += sim.vx * h; sim.pz += sim.vz * h;
    sim.py = groundH(sim, sim.px, sim.pz) + BALL_VIS_R;
    sim.spin *= SPIN_K;
  }

  // ---- 홀 판정: 립아웃 물리 (과장 홀 크기에 맞춰 스케일) ----
  // 공이 홀 위를 가로지르는 동안 자유낙하로 공 반지름만큼 떨어질 수 있으면 인.
  // 통과 현(chord) 길이 / 속도 = 체공시간 t_cross ≥ T_FALL ⇔ v ≤ chord / T_FALL
  if (sim.py <= gh + BALL_VIS_R * 0.6) {
    const hdx = sim.px - sim.holeX, hdz = sim.pz - sim.holeZ;
    const d = Math.hypot(hdx, hdz);
    if (d < HOLE_R * 0.95) {
      const vh = Math.hypot(sim.vx, sim.vz);
      let chord = HOLE_R * 2;
      if (vh > 1e-6) {
        const ux = sim.vx / vh, uz = sim.vz / vh;
        const dperp = Math.abs(hdx * uz - hdz * ux); // 진행선-홀중심 수직거리
        chord = 2 * Math.sqrt(Math.max(HOLE_R * HOLE_R - dperp * dperp, 0));
      }
      if (vh <= chord / T_FALL) return 'in';
      if (sim.lipCool <= 0) {
        // 립아웃: 홀 반대편 림에 맞고 튕겨 나감
        const nx = d > 1e-6 ? hdx / d : 1, nz = d > 1e-6 ? hdz / d : 0;
        const vdotn = sim.vx * nx + sim.vz * nz;
        if (vdotn < 0) {
          sim.vx = (sim.vx - 2 * vdotn * nx) * 0.6;
          sim.vz = (sim.vz - 2 * vdotn * nz) * 0.6;
          sim.vy = Math.max(sim.vy, 1.6);
          sim.grounded = false;
          sim.lipCool = 0.4;
          sim.lipped = true;
        }
      }
    }
  }

  if (sim.grounded && Math.hypot(sim.vx, sim.vz) < STOP_SPEED) {
    sim.vx = sim.vz = 0;
    return 'stop';
  }
  return null;
}

// ---- 헤드리스 벤치마크: 런치 모니터 실측과 캐리 비교 ----
function benchCarry(ballMph, rpm, launchDeg) {
  const s = makeSim();
  s.holeZ = 1e6; s.bunkerZ = 1e6;      // 코스 요소 제거 (평지·무풍)
  const v = ballMph * MPH, la = launchDeg * Math.PI / 180;
  s.vy = v * Math.sin(la); s.vz = v * Math.cos(la);
  s.spin = rpm * Math.PI * 2 / 60;
  s.axx = -1;
  s.grounded = false;
  while (!(s.py <= BALL_VIS_R && s.vy < 0) && s.time < 20) rk4Air(s, SUB), s.time += SUB;
  return s.pz / YD; // yd
}
function bench() {
  const rows = [
    { name: 'Driver', ball: 167, rpm: 2700, launch: 11, target: 270 },
    { name: '7-Iron', ball: 120, rpm: 7100, launch: 16, target: 172 },
  ];
  return rows.map(r => {
    const carry = benchCarry(r.ball, r.rpm, r.launch);
    return { ...r, carry: +carry.toFixed(1), errPct: +((carry / r.target - 1) * 100).toFixed(1) };
  });
}

// ---- 헤드리스 밸런스 스윕: (헤드스피드, 로프트) 그리드에서 홀인원 성공률 ----
function aceSweep(dist) {
  let aces = 0, total = 0, maxT = 0;
  for (let lf = 0; lf <= 1.0001; lf += 0.05) {
    for (let pw = 0; pw <= 1.0001; pw += 0.02) {
      total++;
      const s = makeSim();
      s.holeZ = dist; s.bunkerZ = 1e6;
      launch(s, HEAD_MIN + pw * (HEAD_MAX - HEAD_MIN), LOFT_MIN + lf * (LOFT_MAX - LOFT_MIN), 0);
      let r = null;
      while (!r && s.time < FLY_TIMEOUT) r = physStep(s, SUB, null);
      if (r === 'in') { aces++; maxT = Math.max(maxT, s.time); }
    }
  }
  return { dist, acePct: +(aces / total * 100).toFixed(1), maxShotSec: +maxT.toFixed(1) };
}

// =====================================================================
// 렌더 (카툰 레이어 — 물리와 분리)
// =====================================================================
const PHASE = { AIM: 'aim', SWING: 'swing', FLY: 'fly', RESULT: 'result', ROUNDEND: 'roundend' };

const C = {
  skyTop: 0x2f9fe0, skyBottom: 0xbdeaff,
  grassDeep: 0x3f9a4a, grassLight: 0x6fd35f, green: 0x93e26c, hill: 0x50ab55,
  sand: 0xf2dfa8, trunk: 0x8a5a34, leaf: 0x2f8442, leafHi: 0x46a355,
  accent: 0xe8443a, white: 0xfdfdfd, outline: 0x14251a,
};

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(C.skyBottom, 150, 420);
// near가 작으면 원거리 깊이 정밀도가 급격히 나빠진다 (Δz ≈ z²/(near·2^24)).
// near=0.1 이면 130 m 에서 10 mm — 바닥 레이어 간격과 같아 z-파이팅이 생긴다.
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.5, 1200);

scene.add(new THREE.DirectionalLight(0xfff6e2, 1.9).translateX(-60).translateY(90).translateZ(-40));
scene.add(new THREE.HemisphereLight(0xd8f2ff, 0x4c8f42, 0.95));

const ramp = new THREE.DataTexture(
  new Uint8Array([90, 90, 90, 255, 180, 180, 180, 255, 255, 255, 255, 255]), 3, 1, THREE.RGBAFormat
);
ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
ramp.needsUpdate = true;
function toon(color, opts = {}) { return new THREE.MeshToonMaterial({ color, gradientMap: ramp, ...opts }); }

// 코플래너 바닥 레이어용 깊이 바이어스. y 간격(10 mm)은 원거리에서 깊이 해상도에
// 묻히지만, polygonOffset은 깊이 버퍼 단위로 밀어내므로 거리와 무관하게 순서가 고정된다.
// k가 클수록 위층 (러프 0 → 페어웨이 1 → 그린 2 → … → 임팩트 링 9)
function decal(k) { return { polygonOffset: true, polygonOffsetFactor: -k, polygonOffsetUnits: -k }; }
const outlineMat = new THREE.MeshBasicMaterial({ color: C.outline, side: THREE.BackSide });
function addOutline(mesh, thickness = 0.12) {
  const geo = mesh.geometry.clone();
  geo.computeVertexNormals();
  const pos = geo.attributes.position, nrm = geo.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(i,
      pos.getX(i) + nrm.getX(i) * thickness,
      pos.getY(i) + nrm.getY(i) * thickness,
      pos.getZ(i) + nrm.getZ(i) * thickness);
  }
  pos.needsUpdate = true;
  mesh.add(new THREE.Mesh(geo, outlineMat));
}
const blobMat = new THREE.MeshBasicMaterial({ color: C.outline, transparent: true, opacity: 0.2, ...decal(6) });
function blobShadow(radius, opacity = 0.2) {
  const m = new THREE.Mesh(new THREE.CircleGeometry(radius, 24), blobMat.clone());
  m.material.opacity = opacity;
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.06;
  return m;
}

// 하늘 + 구름
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(600, 24, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color(C.skyTop) }, bottom: { value: new THREE.Color(C.skyBottom) } },
    vertexShader: `varying float h; void main(){ h = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 top; uniform vec3 bottom; varying float h;
      void main(){ float t = smoothstep(-0.05, 0.55, h); gl_FragColor = vec4(mix(bottom, top, t), 1.0); }`,
  })
);
scene.add(sky);

const cloudMat = toon(C.white);
const clouds = new THREE.Group();
for (let i = 0; i < 9; i++) {
  const cloud = new THREE.Group();
  const lobes = 3 + Math.floor(Math.random() * 3);
  for (let j = 0; j < lobes; j++) {
    const r = 5 + Math.random() * 5;
    const lobe = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), cloudMat);
    lobe.position.set((j - lobes / 2) * r * 0.9, Math.random() * 2, Math.random() * 3);
    lobe.scale.y = 0.55;
    cloud.add(lobe);
  }
  cloud.position.set(-220 + Math.random() * 440, 48 + Math.random() * 34, -120 + Math.random() * 420);
  clouds.add(cloud);
}
scene.add(clouds);

// 지면
const rough = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), toon(C.grassDeep));
rough.rotation.x = -Math.PI / 2;
scene.add(rough);

const fairway = new THREE.Mesh(new THREE.PlaneGeometry(FAIRWAY_W * 2, 400), toon(C.grassLight, decal(1)));
fairway.rotation.set(-Math.PI / 2, 0, 0);
fairway.position.set(0, 0.01, 150);
scene.add(fairway);

// 그린 — 정점 높이를 물리와 같은 greenH()로 변위 (경사 공유)
const greenGeo = new THREE.CircleGeometry(GREEN_R, 64);
const green = new THREE.Mesh(greenGeo, toon(C.green, decal(2)));
green.rotation.x = -Math.PI / 2;
green.position.y = 0.02;
scene.add(green);

const greenRim = new THREE.Mesh(
  new THREE.RingGeometry(GREEN_R - 0.1, GREEN_R + 0.4, 64),
  new THREE.MeshBasicMaterial({ color: C.outline, transparent: true, opacity: 0.5, ...decal(3) })
);
greenRim.rotation.x = -Math.PI / 2;
greenRim.position.y = 0.03;
scene.add(greenRim);

const bunker = new THREE.Mesh(new THREE.CircleGeometry(6, 24), toon(C.sand, decal(4)));
bunker.rotation.x = -Math.PI / 2;
bunker.position.y = 0.04;
scene.add(bunker);
const bunkerRim = new THREE.Mesh(
  new THREE.RingGeometry(5.9, 6.35, 24),
  new THREE.MeshBasicMaterial({ color: C.outline, transparent: true, opacity: 0.45, ...decal(5) })
);
bunkerRim.rotation.x = -Math.PI / 2;
bunkerRim.position.y = 0.05;
scene.add(bunkerRim);

const hills = new THREE.Group();
for (let i = 0; i < 14; i++) {
  const r = 28 + Math.random() * 46;
  const hill = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), toon(C.hill));
  hill.scale.y = 0.28 + Math.random() * 0.2;
  const ang = Math.random() * Math.PI * 2;
  const dist = 240 + Math.random() * 190;
  hill.position.set(Math.sin(ang) * dist, -r * 0.16, 130 + Math.cos(ang) * dist);
  hills.add(hill);
}
scene.add(hills);

// 홀 + 깃대
const holeGroup = new THREE.Group();
const holeDisc = new THREE.Mesh(new THREE.CircleGeometry(HOLE_R, 28), new THREE.MeshBasicMaterial({ color: 0x0d160f, ...decal(7) }));
holeDisc.rotation.x = -Math.PI / 2;
holeDisc.position.y = 0.06;
holeGroup.add(holeDisc);
const holeRim = new THREE.Mesh(
  new THREE.RingGeometry(HOLE_R, HOLE_R + 0.3, 28),
  new THREE.MeshBasicMaterial({ color: C.white, ...decal(8) })
);
holeRim.rotation.x = -Math.PI / 2;
holeRim.position.y = 0.07;
holeGroup.add(holeRim);
const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 8, 8), toon(C.white));
pin.position.y = 4;
addOutline(pin, 0.055);
holeGroup.add(pin);
const flag = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.5), toon(C.accent, { side: THREE.DoubleSide }));
flag.position.set(1.3, 7.2, 0);
holeGroup.add(flag);
holeGroup.add(blobShadow(1.1, 0.16));
scene.add(holeGroup);

// 나무
const trunkMat = toon(C.trunk);
const leafMats = [toon(C.leaf), toon(C.leafHi)];
const trees = new THREE.Group();
for (let i = 0; i < 24; i++) {
  const t = new THREE.Group();
  const h = 5 + Math.random() * 4;
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.62, h, 7), trunkMat);
  trunk.position.y = h / 2;
  addOutline(trunk, 0.1);
  t.add(trunk);
  const leafMat = leafMats[i % 2];
  const lobes = 3 + Math.floor(Math.random() * 2);
  for (let j = 0; j < lobes; j++) {
    const r = 2.1 + Math.random() * 1.5;
    const lobe = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), leafMat);
    lobe.position.set((Math.random() - 0.5) * 3.2, h + 1.4 + Math.random() * 2.2, (Math.random() - 0.5) * 3.2);
    addOutline(lobe, 0.16);
    t.add(lobe);
  }
  t.add(blobShadow(2.6 + Math.random(), 0.17));
  const side = Math.random() < 0.5 ? -1 : 1;
  t.position.set(side * (FAIRWAY_W + 5 + Math.random() * 28), 0, -20 + Math.random() * 280);
  trees.add(t);
}
scene.add(trees);

// 공 / 화살표 / 궤적
const ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_VIS_R, 20, 14), toon(C.white));
addOutline(ball, 0.032);
scene.add(ball);
const ballShadow = blobShadow(BALL_VIS_R * 1.7, 0.26);
scene.add(ballShadow);

const arrow = new THREE.Group();
{
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.08, 7), toon(0xffd23f));
  shaft.position.z = 3.5;
  const tip = new THREE.Mesh(new THREE.ConeGeometry(1.0, 2, 10), toon(0xffd23f));
  tip.rotation.x = Math.PI / 2;
  tip.position.z = 8;
  addOutline(tip, 0.08);
  arrow.add(shaft, tip);
}
scene.add(arrow);

// 백스윙 호 게이지 — 당긴 만큼 공 뒤로 호가 자란다
const ARC_N = 24;
const arcPosArr = new Float32Array(ARC_N * 3);
const arcGeo = new THREE.BufferGeometry();
arcGeo.setAttribute('position', new THREE.BufferAttribute(arcPosArr, 3));
const backArc = new THREE.Line(arcGeo, new THREE.LineBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.9 }));
backArc.frustumCulled = false;
backArc.visible = false;
scene.add(backArc);

const TRAIL_MAX = 600;
const trailPos = new Float32Array(TRAIL_MAX * 3);
const trailGeo = new THREE.BufferGeometry();
trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
trailGeo.setDrawRange(0, 0);
const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: C.white, transparent: true, opacity: 0.55 }));
trail.frustumCulled = false;
scene.add(trail);

// 이펙트 (임팩트 링 / 스피드 라인 / 홀인원 폭죽)
const fx = (() => {
  const rings = [];
  for (let i = 0; i < 5; i++) {
    const m = new THREE.Mesh(
      new THREE.RingGeometry(0.7, 1.05, 22),
      new THREE.MeshBasicMaterial({ color: C.white, transparent: true, opacity: 0, side: THREE.DoubleSide, ...decal(9) })
    );
    m.rotation.x = -Math.PI / 2;
    m.visible = false;
    scene.add(m);
    rings.push({ mesh: m, life: 0, span: 0.5, power: 0 });
  }
  const LINES = 3;
  const slPos = new Float32Array(LINES * 6);
  const slGeo = new THREE.BufferGeometry();
  slGeo.setAttribute('position', new THREE.BufferAttribute(slPos, 3));
  const slMat = new THREE.LineBasicMaterial({ color: C.white, transparent: true, opacity: 0 });
  const speedLines = new THREE.LineSegments(slGeo, slMat);
  speedLines.frustumCulled = false;
  scene.add(speedLines);
  const parts = [];
  const partColors = [C.accent, 0xffd23f, C.white, 0x5b8ef0, C.grassLight];
  for (let i = 0; i < 34; i++) {
    const m = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.22, 0),
      new THREE.MeshBasicMaterial({ color: partColors[i % partColors.length], transparent: true })
    );
    m.visible = false;
    scene.add(m);
    parts.push({ mesh: m, vel: new THREE.Vector3(), life: 0 });
  }
  return {
    impact(x, z, vy) {
      const strength = Math.min(Math.abs(vy) / 18, 1);
      if (strength < 0.12) return;
      const r = rings.find(o => o.life <= 0);
      if (!r) return;
      r.mesh.position.set(x, 0.09, z);
      r.mesh.scale.setScalar(0.5);
      r.mesh.visible = true;
      r.life = r.span;
      r.power = strength;
    },
    burst(x, z) {
      for (const p of parts) {
        p.mesh.position.set(x, 0.4, z);
        p.vel.set((Math.random() - 0.5) * 9, 6 + Math.random() * 9, (Math.random() - 0.5) * 9);
        p.life = 1.4;
        p.mesh.visible = true;
      }
    },
    update(dt, pos, vel, flying) {
      for (const r of rings) {
        if (r.life <= 0) continue;
        r.life -= dt;
        const k = 1 - r.life / r.span;
        r.mesh.scale.setScalar(0.5 + k * (2 + r.power * 4));
        r.mesh.material.opacity = (1 - k) * 0.75 * r.power;
        if (r.life <= 0) r.mesh.visible = false;
      }
      const spd = vel.length();
      if (flying && spd > 30) {
        const dir = vel.clone().normalize();
        const side = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
        const len = Math.min(spd * 0.18, 10);
        for (let i = 0; i < LINES; i++) {
          const off = side.clone().multiplyScalar((i - 1) * 0.55).setY((i - 1) * 0.25);
          const a = pos.clone().add(off).addScaledVector(dir, -1.2);
          const b = a.clone().addScaledVector(dir, -len);
          slPos.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6);
        }
        slGeo.attributes.position.needsUpdate = true;
        slMat.opacity = Math.min((spd - 30) / 25, 1) * 0.6;
      } else {
        slMat.opacity = 0;
      }
      for (const p of parts) {
        if (p.life <= 0) continue;
        p.life -= dt;
        p.vel.y -= GRAV * dt;
        p.mesh.position.addScaledVector(p.vel, dt);
        p.mesh.rotation.x += dt * 6;
        p.mesh.rotation.y += dt * 4;
        p.mesh.material.opacity = Math.max(p.life / 1.4, 0);
        if (p.life <= 0) p.mesh.visible = false;
      }
    },
  };
})();

// =====================================================================
// 게임 상태
// =====================================================================
const sim = makeSim();
const state = {
  phase: PHASE.AIM,
  aim: 0, power: 0, loft: 0,
  flyTime: 0, acc: 0, trailCount: 0,
  lastAce: false, lipPlayed: false,
  shape: '', pure: true,
  // 라운드
  round: [],            // 9홀 코스 파라미터 (날짜 시드 생성)
  holeIdx: 0,
  holeScores: [],       // 홀별 획득 점수
  roundScore: 0,
  aces: 0,              // 이번 라운드 홀인원 수
  distance: 0,          // 현재 홀 전장 (HUD)
  seedKey: '',
  bounceCount: 0,       // 이번 샷 바운스 횟수 (착지음 감쇠용)
};

const HOLES = 9;
const DIST_MIN = 100, DIST_MAX = 180;   // 홀 전장 범위 (m)

// ---------- 시드 PRNG — 같은 날은 전원 동일한 9홀 코스 ----------
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function dayKey(d = new Date())  { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function monthKey(d = new Date()) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; }
function weekKey(d = new Date()) { // ISO 주 (월요일 시작)
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (t.getDay() + 6) % 7;
  t.setDate(t.getDate() - day + 3);          // 해당 주 목요일
  const first = new Date(t.getFullYear(), 0, 4);
  const fDay = (first.getDay() + 6) % 7;
  first.setDate(first.getDate() - fDay + 3);
  const w = 1 + Math.round((t - first) / (7 * 864e5));
  return `${t.getFullYear()}-W${pad2(w)}`;
}

function buildRound(seedKey) {
  const rng = mulberry32(hashStr(seedKey));
  const holes = [];
  for (let i = 0; i < HOLES; i++) {
    holes.push({
      distance: Math.round(DIST_MIN + rng() * (DIST_MAX - DIST_MIN)),
      lateral:  (rng() - 0.5) * 16,
      slopeG:   0.010 + rng() * 0.015,
      slopeA:   rng() * Math.PI * 2,
      bunkerDX: (rng() - 0.5) * 24,
      bunkerBack: 22 + rng() * 12,
      windSpd:  rng() * 7,
      windAng:  rng() * Math.PI * 2,
    });
  }
  return holes;
}

// ---------- 점수: 홀인원 1000점, 그 외 핀까지 5 m마다 반감 ----------
const ACE_SCORE = 1000;
function holeScore(distM, holed) {
  if (holed) return ACE_SCORE;
  return Math.max(Math.round(500 * Math.pow(0.5, distM / 5)), 0);
}

// ---------- 기록 저장 (localStorage) ----------
// statsCache: HUD가 매 프레임 읽으므로 라운드 종료 시에만 갱신
let statsCache;
const store = {
  key: 'hio.rounds.v1',
  load() {
    try { return JSON.parse(localStorage.getItem(this.key)) || []; } catch { return []; }
  },
  add(rec) {
    const all = this.load();
    all.push(rec);
    if (all.length > 300) all.splice(0, all.length - 300);
    try { localStorage.setItem(this.key, JSON.stringify(all)); } catch {}
    return all;
  },
  // 기간별 최고 점수 (일 / 주 / 월 / 전체) + 플레이 수
  stats(all = this.load()) {
    const dk = dayKey(), wk = weekKey(), mk = monthKey();
    const best = (rows) => rows.reduce((m, r) => Math.max(m, r.s), 0);
    const day = all.filter(r => r.d === dk);
    const week = all.filter(r => r.w === wk);
    const month = all.filter(r => r.m === mk);
    return {
      day: best(day), week: best(week), month: best(month), all: best(all),
      todayPlays: day.length, totalPlays: all.length,
      todayAces: day.reduce((n, r) => n + (r.a || 0), 0),
    };
  },
};

function refreshGreenMesh() {
  // 시각 메시 정점을 물리와 같은 greenH()로 변위
  // (rotation.x = −π/2 → 로컬 (lx,ly,lz) = 월드 (cx+lx, lz, cz−ly))
  const pos = greenGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const lx = pos.getX(i), ly = pos.getY(i);
    pos.setZ(i, greenH(sim, sim.holeX + lx, sim.holeZ - ly));
  }
  pos.needsUpdate = true;
  greenGeo.computeVertexNormals();
}

// 라운드 시작 — 오늘 날짜 시드로 9홀 생성 (같은 날은 어디서나 동일 코스)
function startRound() {
  state.seedKey = dayKey();
  state.round = buildRound(state.seedKey);
  state.holeIdx = 0;
  state.holeScores = [];
  state.roundScore = 0;
  state.aces = 0;
  loadHole(0);
}

function loadHole(i) {
  const h = state.round[i];
  state.holeIdx = i;
  state.distance = h.distance;
  sim.holeX = h.lateral; sim.holeZ = h.distance;
  sim.slopeX = Math.cos(h.slopeA) * h.slopeG;
  sim.slopeZ = Math.sin(h.slopeA) * h.slopeG;
  sim.bunkerX = h.lateral + h.bunkerDX;
  sim.bunkerZ = h.distance - h.bunkerBack;

  holeGroup.position.set(sim.holeX, 0, sim.holeZ);
  green.position.set(sim.holeX, 0.02, sim.holeZ);
  greenRim.position.set(sim.holeX, 0.03, sim.holeZ);
  bunker.position.set(sim.bunkerX, 0.04, sim.bunkerZ);
  bunkerRim.position.set(sim.bunkerX, 0.05, sim.bunkerZ);
  refreshGreenMesh();
  resetShot();
}

function resetShot() {
  state.phase = PHASE.AIM;
  sim.px = 0; sim.py = BALL_VIS_R; sim.pz = 0;
  sim.vx = sim.vy = sim.vz = 0;
  sim.spin = 0; sim.grounded = true; sim.time = 0; sim.lipCool = 0; sim.lipped = false;
  state.flyTime = 0; state.acc = 0;
  state.power = state.loft = 0; state.lipPlayed = false;
  state.shape = ''; state.pure = true; state.bounceCount = 0;
  gest = null;
  hideImpactLine();
  state.trailCount = 0;
  trailGeo.setDrawRange(0, 0);
  state.aim = Math.atan2(sim.holeX, sim.holeZ);
  // 바람도 홀 시드에서 — 같은 홀은 항상 같은 조건
  const h = state.round[state.holeIdx];
  sim.windX = Math.cos(h.windAng) * h.windSpd;
  sim.windZ = Math.sin(h.windAng) * h.windSpd;
  sim.gustA = h.windAng; sim.gustB = h.slopeA;
  arrow.visible = true;
  hideMsg();
  sfx.silence();
  updateCamera(true);
}

// =====================================================================
// 사운드 합성 코어 (외부 오디오 파일 없음)
// 모든 함수가 (c, dest, t0, …) 형태로 컨텍스트를 인자로 받으므로 라이브 출력과
// OfflineAudioContext 렌더링에서 동일하게 동작한다 → audioTest()가 실측 검증 가능.
// =====================================================================
const SND = (() => {
  const noiseCache = new WeakMap(), irCache = new WeakMap();
  let created = 0;   // 생성된 오디오 노드 수 (프레임당 0 검증용)

  function noiseBuf(c) {
    let b = noiseCache.get(c);
    if (!b) {
      // 4초 — 지속음 보이스가 이 버퍼를 무한 반복한다. 짧으면 반복 주기가 귀에 잡혀
      // 바람이 아니라 지직거리는 노이즈로 들린다.
      b = c.createBuffer(1, Math.floor(c.sampleRate * 4), c.sampleRate);
      const d = b.getChannelData(0);
      let s = 22222;   // 결정론적 노이즈 (렌더 검증 재현성)
      for (let i = 0; i < d.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; d[i] = s / 0x3fffffff - 1; }
      noiseCache.set(c, b);
    }
    return b;
  }
  // 야외 반사용 합성 임펄스 응답 — 200 ms 감쇠 노이즈
  function ir(c) {
    let b = irCache.get(c);
    if (!b) {
      const n = Math.floor(c.sampleRate * 0.2);
      b = c.createBuffer(2, n, c.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = b.getChannelData(ch);
        let s = 7777 + ch;
        for (let i = 0; i < n; i++) {
          s = (s * 1103515245 + 12345) & 0x7fffffff;
          d[i] = (s / 0x3fffffff - 1) * Math.pow(1 - i / n, 3.2) * 0.6;
        }
      }
      irCache.set(c, b);
    }
    return b;
  }

  // 필터 걸린 노이즈 버스트 (트랜지언트·질감)
  function burst(c, dest, t, o) {
    const dur = o.dur, s = c.createBufferSource();
    s.buffer = noiseBuf(c); s.loop = true;
    const f = c.createBiquadFilter();
    f.type = o.type || 'bandpass'; f.Q.value = o.q ?? 1;
    f.frequency.setValueAtTime(o.f0, t);
    if (o.f1 && o.f1 !== o.f0) f.frequency.exponentialRampToValueAtTime(Math.max(o.f1, 20), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(1e-4, t);
    g.gain.linearRampToValueAtTime(o.vol, t + Math.min(0.0015, dur * 0.25));
    g.gain.exponentialRampToValueAtTime(1e-4, t + dur);
    s.connect(f).connect(g).connect(dest);
    s.start(t); s.stop(t + dur + 0.02);
    created += 3;
    return g;
  }
  // 감쇠 사인/삼각 (금속 링·저역 바디·UI 톤)
  function ping(c, dest, t, o) {
    const dur = o.dur, os = c.createOscillator(), g = c.createGain();
    os.type = o.type || 'sine';
    os.frequency.setValueAtTime(o.f, t);
    if (o.slideTo) os.frequency.exponentialRampToValueAtTime(Math.max(o.slideTo, 20), t + dur);
    g.gain.setValueAtTime(1e-4, t);
    g.gain.linearRampToValueAtTime(o.vol, t + Math.min(0.002, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(1e-4, t + dur);
    os.connect(g).connect(dest);
    os.start(t); os.stop(t + dur + 0.02);
    created += 2;
    return g;
  }

  // ---- 임팩트 타격음: ①클릭 트랜지언트 ②페이스 금속 링 ③저역 바디 ----
  function impact(c, dest, t, ballSpd, pure) {
    const k = Math.min(Math.max(ballSpd / 60, 0.2), 1);   // 볼 스피드 정규화 (m/s)
    const out = [];
    out.push(burst(c, dest, t, {                          // ① 0~6 ms 파열
      dur: 0.004 + 0.002 * k, vol: 0.55 * k, type: 'highpass', f0: 3000 + 2500 * k, q: 0.7 }));
    const base = 2100 + 900 * k;                          // ② 비조화 배음 링
    const ratios = pure ? [1, 1.71, 2.43] : [1, 1.58];
    ratios.forEach((r, i) => out.push(ping(c, dest, t + 0.001, {
      f: base * r, dur: (pure ? 0.095 : 0.030) - i * 0.018,
      vol: (pure ? 0.17 : 0.07) / (i + 1) })));
    out.push(ping(c, dest, t, {                           // ③ 저역 바디
      f: 135 + 45 * k, dur: 0.018, vol: 0.32 * k, slideTo: 90 }));
    if (!pure) out.push(burst(c, dest, t + 0.002, {       // 미스히트: 둔탁한 "퍽"
      dur: 0.05, vol: 0.18, f0: 500, f1: 260, q: 1.2 }));
    return out;
  }

  // ---- 착지음: 노면별 질감 (벙커 = 고역, 러프 = 광대역, 그린/페어웨이 = 저역 톡) ----
  function land(c, dest, t, surfName, spd, idx = 0) {
    const k = Math.min(spd / 18, 1) * Math.pow(0.72, idx);
    if (k < 0.04) return [];
    if (surfName === 'sand') return [
      burst(c, dest, t, { dur: 0.08, vol: 0.36 * k, type: 'highpass', f0: 7000, q: 0.5 }),
      ping(c, dest, t, { f: 105, dur: 0.02, vol: 0.05 * k }),
    ];
    if (surfName === 'rough') return [
      burst(c, dest, t, { dur: 0.15, vol: 0.30 * k, f0: 3400, f1: 1200, q: 0.4 }),
    ];
    return [                                              // green / fairway
      ping(c, dest, t, { f: 128 + 40 * k, dur: 0.042, vol: 0.32 * k, slideTo: 70 }),
      burst(c, dest, t, { dur: 0.04, vol: 0.13 * k, f0: 620, f1: 230, q: 1.1 }),
    ];
  }

  // ---- 지속음 보이스: 노드를 한 번만 만들고 이후엔 파라미터만 갱신 ----
  function loopVoice(c, dest, f0, q, type = 'bandpass') {
    const s = c.createBufferSource(); s.buffer = noiseBuf(c); s.loop = true;
    const f = c.createBiquadFilter(); f.type = type; f.frequency.value = f0; f.Q.value = q;
    const g = c.createGain(); g.gain.value = 0;
    s.connect(f).connect(g).connect(dest);
    s.start(0);
    created += 3;
    return { src: s, filt: f, gain: g };
  }

  // 근접장 감쇠 — 공이 청자 곁을 스칠 때만 들린다. 20 m에서 −21 dB, 그 밖은 사실상 무음.
  function nearField(d) { return 1 / (1 + Math.pow(d / 6, 2)); }
  // 거리에 따른 고역 흡수 — 멀수록 둔탁해진다 (컷오프에 곱한다)
  function airAbsorb(d) { return 1 / (1 + d / 25); }

  return { noiseBuf, ir, burst, ping, impact, land, loopVoice, nearField, airAbsorb,
           nodesCreated: () => created };
})();

// ---------- 샘플 뱅크 (CC0 녹음 — 트랜지언트 계열은 실녹음, 지속음은 합성 유지) ----------
const SAMPLES = {
  impact: ['assets/hit.mp3'],   // 원본 파일 바이트 그대로 — 어떤 가공도 없음
  landGrass:  ['assets/land-grass.m4a'],
  landSand:   ['assets/land-sand.m4a'],
  cup:        ['assets/cup.m4a'],
};
const bank = { ready: false, buf: {}, rr: {} };   // rr: 카테고리별 라운드로빈 인덱스

async function loadSamples(c) {
  if (bank.loading || bank.ready) return;
  bank.loading = true;
  try {
    for (const [cat, urls] of Object.entries(SAMPLES)) {
      const bufs = [];
      for (const u of urls) {
        const res = await fetch(u + '?b=' + BUILD);
        if (!res.ok) throw new Error(u + ' ' + res.status);   // 404 HTML을 디코드하지 않는다
        bufs.push(await c.decodeAudioData(await res.arrayBuffer()));
      }
      bank.buf[cat] = bufs;
      bank.rr[cat] = 0;
    }
    bank.ready = true;
  } catch (e) {
    // 로드 실패(오프라인 등) → 합성 폴백 유지
    bank.ready = false;
  }
  bank.loading = false;
  // 폰에서 육안 진단용: 빌드 + 현재 사운드 엔진
  const tag = document.getElementById('build');
  if (tag) tag.textContent = 'b' + BUILD + (bank.ready ? ' · 녹음' : ' · 합성');
}

// ---------- 라이브 사운드 엔진 ----------
const sfx = (() => {
  const SPEED_OF_SOUND = 343, MAX_VOICES = 12;
  const HIT_ONLY = true;   // 사용자 지시: 우선 타격음만 재생, 나머지 전부 무음
  let c = null, master = null, bus = null, muted = false;
  let air = null, roll = null, amb = null;
  let live = [];   // 재생 중인 원샷 게인 노드 {g, end}

  // 샘플 원샷 재생: 라운드로빈 + 피치/게인 랜덤 (반복 청취 대응)
  // jitter 0~1: 랜덤 폭 배율. dry: 리버브 버스를 우회해 원본 그대로 재생.
  function samplePlay(cat, t, { gain = 1, rate = 1, lowpass = 0, jitter = 1, dry = false } = {}) {
    const bufs = bank.buf[cat];
    if (!bufs || !bufs.length) return null;
    const i = bank.rr[cat] % bufs.length;
    bank.rr[cat]++;
    const s = c.createBufferSource();
    s.buffer = bufs[i];
    s.playbackRate.value = rate * (1 + (Math.random() - 0.5) * 0.08 * jitter);
    const g = c.createGain();
    g.gain.value = gain * Math.pow(10, ((Math.random() - 0.5) * 4 * jitter) / 20);
    const dest = dry ? master : bus;
    if (lowpass) {
      const f = c.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = lowpass;
      s.connect(f).connect(g).connect(dest);
    } else {
      s.connect(g).connect(dest);
    }
    s.start(t);
    return g;
  }

  function ac() {
    if (!c) {
      c = new (window.AudioContext || window.webkitAudioContext)();
      master = c.createGain();
      // 클리핑 안전장치 수준으로만 — 강하게 걸면 타격의 첫 수 ms 크랙이 눌려 소리가 변한다
      const comp = c.createDynamicsCompressor();
      comp.threshold.value = -8; comp.knee.value = 10; comp.ratio.value = 2;
      comp.attack.value = 0.001; comp.release.value = 0.12;
      master.connect(comp).connect(c.destination);

      // 원샷 버스: 드라이 0.85 + 컨볼루션 웨트 0.15 (야외 반사감)
      bus = c.createGain();
      const dry = c.createGain(); dry.gain.value = 0.85;
      const wet = c.createGain(); wet.gain.value = 0.15;
      const conv = c.createConvolver(); conv.buffer = SND.ir(c);
      bus.connect(dry).connect(master);
      bus.connect(wet).connect(conv).connect(master);

      // 지속음 3개 (통과음 / 구름음 / 필드 앰비언스) — 이후 노드 생성 없음
      air  = SND.loopVoice(c, master, 3000, 0.3, 'lowpass');
      roll = SND.loopVoice(c, master, 400, 1.0);
      amb  = SND.loopVoice(c, master, 480, 0.2, 'lowpass');

      loadSamples(c);   // 샘플은 백그라운드 로드 — 완료 전엔 합성 폴백
    }
    if (c.state === 'suspended') c.resume();
    return c;
  }

  // 동시 발음 상한 — 초과 시 가장 오래된 것부터 끊는다
  function register(gains) {
    const now = c.currentTime;
    live = live.filter(v => v.end > now);
    for (const g of gains) live.push({ g, end: now + 0.3 });
    while (live.length > MAX_VOICES) {
      const old = live.shift();
      try { old.g.gain.cancelScheduledValues(now); old.g.gain.setTargetAtTime(0, now, 0.01); } catch {}
    }
  }
  // delay = 음속 전파 지연(초). 먼 곳의 사건일수록 늦게 들린다.
  function play(fn, delay = 0) {
    if (muted) return;
    const cc = ac();
    register(fn(cc, bus, cc.currentTime + 0.005 + delay) || []);
  }

  return {
    unlock() { try { ac(); } catch {} },
    toggle() {
      muted = !muted;
      if (c) master.gain.setTargetAtTime(muted ? 0 : 1, c.currentTime, 0.02);
      if (muted) this.silence();
      return muted;
    },
    // UI 피드백 — 전자음(구형파 삐빅) 대신 둔한 노이즈 틱. 실녹음 샘플과 이질감이 없어야 한다.
    tap() { if (HIT_ONLY) return; play((cc, d, t) => [SND.burst(cc, d, t, { dur: 0.02, vol: 0.05, f0: 2400, f1: 1500, q: 2 })]); },
    // 백스윙 시작 — 톱니파 대신 옷깃/공기 스치는 스윕
    takeback() { if (HIT_ONLY) return; play((cc, d, t) => [SND.burst(cc, d, t, { dur: 0.22, vol: 0.03, f0: 900, f1: 350, q: 0.7 })]); },
    // 타격음 — 원본 파일을 타격 지점(2.46s)부터 무가공 재생. 게인 1, 필터 없음, 판정 없음.
    impactHit() {
      if (!bank.ready || muted) return;
      const cc = ac();
      const buf = bank.buf.impact[0];
      const s = cc.createBufferSource();
      s.buffer = buf;
      s.connect(cc.destination);   // 컴프레서·리버브·게인 전부 우회 — 스피커 직결
      s.start(cc.currentTime + 0.005, Math.min(2.46, buf.duration));
    },
    // 착지음 — 노면별 실녹음 (잔디/모래), 바운스 횟수마다 감쇠·둔화 (상대 레벨 −6 dB)
    bounce(spd, surfName, idx, delay = 0) {
      if (HIT_ONLY) return;
      const k = Math.min(spd / 18, 1) * Math.pow(0.72, idx);
      if (k < 0.04) return;
      if (bank.ready) {
        play((cc, d, t) => {
          const cat = surfName === 'sand' ? 'landSand' : 'landGrass';
          const dull = surfName === 'rough' ? 1800 : (idx > 0 ? 3500 : 0);
          return [samplePlay(cat, t, { gain: 0.5 * k, rate: 0.94 + 0.1 * k, lowpass: dull })].filter(Boolean);
        }, delay);
      } else {
        play((cc, d, t) => SND.land(cc, d, t, surfName, spd, idx), delay);
      }
    },
    // 립아웃 — 트라이앵글 핑 대신 컵 테두리를 두 번 스치는 둔탁한 틱
    lipout(delay = 0) {
      if (HIT_ONLY) return;
      play((cc, d, t) => [
        SND.burst(cc, d, t, { dur: 0.03, vol: 0.14, f0: 1600, f1: 900, q: 1.6 }),
        SND.burst(cc, d, t + 0.07, { dur: 0.05, vol: 0.1, f0: 800, f1: 450, q: 1.2 }),
      ], delay);
    },
    // 홀인 — 실녹음 컵 소리 + (보상 신호로) 낮은 음량의 아르페지오 유지
    // 홀인 — 실녹음 컵 소리만. 8비트 아르페지오는 사실성을 깨서 제거 (보상감은 화면 연출이 맡는다)
    holeIn(delay = 0) {
      if (HIT_ONLY) return;
      play((cc, d, t) => {
        if (bank.ready) return [samplePlay('cup', t, { gain: 0.95 })].filter(Boolean);
        return [SND.burst(cc, d, t, { dur: 0.12, vol: 0.2, f0: 1200, f1: 500, q: 2 })];
      }, delay);
    },
    miss() {},   // 홀인 실패 전자음 제거 — 실제 필드에선 아무 소리도 나지 않는다

    // 통과음 — 공이 청자 곁을 스치는 동안에만 들린다.
    // 임팩트 직후 0.3초 남짓이면 20 m를 벗어나 사실상 무음이 된다(실제 필드와 동일).
    // 프레임마다 파라미터만 갱신 (노드 생성 0). radialV > 0 = 멀어짐 → 도플러 하강.
    flight(spd, dist, radialV, on) {
      if (HIT_ONLY) return;
      if (!c || muted) return;
      const t = c.currentTime;
      if (!on) { air.gain.gain.setTargetAtTime(0, t, 0.02); return; }
      const dop = SPEED_OF_SOUND / (SPEED_OF_SOUND + Math.max(Math.min(radialV, 150), -150));
      // 광대역 난류 히스: 멀어질수록 고역이 깎여 둔탁해진다
      const f = Math.min(Math.max((2200 + 22 * spd) * dop * SND.airAbsorb(dist), 300), 12000);
      air.filt.frequency.setTargetAtTime(f, t, 0.03);
      // 느린 어택(0.1s): 발사 직후 타격 샘플 위에 노이즈가 겹치지 않게 — 타격이 끝난 뒤 멀리서 스친다
      const g = Math.min(spd * spd / 3600, 1) * SND.nearField(dist) * 0.14;
      air.gain.gain.setTargetAtTime(g < 0.004 ? 0 : g, t, 0.1);
    },
    // 필드 앰비언스 — 실제 바람 세기로 구동. 비행음이 빠진 정적을 필드로 읽히게 한다.
    ambient(windSpd) {
      if (HIT_ONLY) return;
      if (!c || muted) return;
      const t = c.currentTime;
      // 서로 어긋나는 두 주기로 세기와 음색을 함께 흔든다 — 고정된 노이즈는 바람으로 안 들린다
      const gust = 1 + 0.45 * Math.sin(t * 0.23) * Math.sin(t * 0.09);
      amb.filt.frequency.setTargetAtTime((300 + 22 * windSpd) * (1 + 0.3 * Math.sin(t * 0.17)), t, 0.8);
      amb.gain.gain.setTargetAtTime((0.006 + 0.0035 * windSpd) * gust, t, 0.8);   // 약 −33 dBFS
    },
    // 구름음
    rolling(spd, on) {
      if (HIT_ONLY) return;
      if (!c || muted) return;
      const t = c.currentTime;
      if (!on || spd < 0.4) { roll.gain.gain.setTargetAtTime(0, t, 0.04); return; }
      roll.filt.frequency.setTargetAtTime(300 + 60 * Math.min(spd, 8), t, 0.05);
      roll.gain.gain.setTargetAtTime(Math.min(spd / 12, 1) * 0.11, t, 0.05);
    },
    // 앰비언스는 끄지 않는다 — 샷 사이의 정적이 "음소거"가 아니라 필드로 들려야 한다
    silence() {
      if (!c) return;
      const t = c.currentTime;
      air.gain.gain.setTargetAtTime(0, t, 0.02);
      roll.gain.gain.setTargetAtTime(0, t, 0.02);
    },
  };
})();

// ---------- 입력 (터치 스윙 메인 + 키보드 겸용) ----------
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window || navigator.maxTouchPoints > 0;
const keys = new Set();
addEventListener('keydown', (e) => {
  if (e.code === 'Space') { e.preventDefault(); advance(); return; }
  if (e.code === 'KeyR') { startRound(); return; }   // ↻ 버튼과 동일 (홀 단위 재시도 없음)
  keys.add(e.code);
});
addEventListener('keyup', (e) => keys.delete(e.code));

// AIM: 드래그 = 조준, 탭 = 스윙 준비
// SWING: 아래로 드래그 = 백스윙(파워 축적) → 위로 반전 = 다운스윙 → 시작점 재통과 = 임팩트
//        임팩트 이후 릴리즈까지의 팔로스루 길이 = 로프트. 임팩트 이후 이동은 결과 불변.
//        백스윙 없이 그냥 위로 스와이프하면 기존 방식 (하위 호환)
const SWIPE_FULL_V   = 3.0;   // 화면높이/초 — 하위호환 스와이프 풀파워
const SWIPE_FULL_L   = 0.5;   // 화면높이 비율 — 하위호환 최대 로프트
const BACK_FULL_L    = 0.45;  // 화면높이 비율 — 풀 백스윙 (파워 상한 100%)
const REALIZE_FULL_V = 2.2;   // 화면높이/초 — 임팩트 순간 속도가 이 값이면 실현율 100%
const FOLLOW_FULL_L  = 0.35;  // 화면높이 비율 — 팔로스루 이 길이면 최대 로프트
const TILT_MAX_DEG   = 15;    // 임팩트 x편차 최대 스핀축 틸트 (°)
let pDown = false, pStartX = 0, pStartY = 0, pLastX = 0, pMoved = 0;
let gest = null;

function peakUpVel(s) { // 샘플열의 최대 상향 속도 (px/s)
  let v = 0;
  for (let i = 1; i < s.length; i++) {
    const dt = (s[i].t - s[i - 1].t) / 1000;
    if (dt > 1e-4) v = Math.max(v, (s[i - 1].y - s[i].y) / dt);
  }
  return v;
}

// ---- 제스처 상태머신 (실입력·gestureTest 공용 순수 로직) ----
// ADDRESS → (아래로 3%H) BACKSWING → (8px 위로 반전) DOWNSWING → (y0 재통과) 임팩트 → RELEASE
function makeGesture(x, y, t) {
  return {
    x0: x, y0: y, mode: 'address', maxY: y, backLen: 0,
    prevY: y, prevT: t, downV: 0,
    impacted: false, impactX: 0, impactV: 0, minYAfter: Infinity,
    samples: [{ x, y, t }],
  };
}
function gestureMove(g, x, y, t) {
  g.samples.push({ x, y, t });
  const dt = (t - g.prevT) / 1000;
  const vUp = dt > 1e-4 ? (g.prevY - y) / dt : 0;
  if (g.mode !== 'down') {
    if (y > g.maxY) {
      g.maxY = y;
      g.backLen = g.maxY - g.y0;
      if (g.backLen > innerHeight * 0.03) g.mode = 'back';
    } else if (g.mode === 'back' && g.maxY - y > 8) {
      g.mode = 'down'; // 방향 반전 → 다운스윙 시작
    }
  }
  if (g.mode === 'down') {
    g.downV = Math.max(g.downV, vUp);
    if (!g.impacted && y <= g.y0) { // 시작점 재통과 = 임팩트
      g.impacted = true; g.impactX = x; g.impactV = g.downV;
    }
    if (g.impacted) g.minYAfter = Math.min(g.minYAfter, y);
  }
  g.prevY = y; g.prevT = t;
}
function gestureEnd(g) {
  const H = innerHeight, W = innerWidth;
  if (g.impacted) { // 백스윙 샷
    const powerCap = Math.min(Math.max(g.backLen / (H * BACK_FULL_L), 0.15), 1);  // 백스윙 길이 = 상한
    const realize  = Math.min(Math.max(g.impactV / (H * REALIZE_FULL_V), 0.25), 1); // 다운스윙 속도 = 실현율
    const devN = Math.min(Math.max((g.impactX - g.x0) / (W * 0.22), -1), 1);
    return {
      kind: 'back',
      power: Math.max(powerCap * realize, 0.05),
      loft: Math.min(Math.max((g.y0 - g.minYAfter) / (H * FOLLOW_FULL_L), 0), 1),
      tiltDeg: -devN * TILT_MAX_DEG, // 우편차 → 우커브(페이드/슬라이스), 좌편차 → 좌커브(드로/훅)
      aimDelta: devN * 0.08,         // 심한 편차는 방향 오차도 추가
      devN,
    };
  }
  // 하위 호환: 단순 위로 스와이프
  const s = g.samples;
  let top = s[0];
  for (const p of s) if (p.y < top.y) top = p;
  const dyUp = s[0].y - top.y;
  const vPeak = peakUpVel(s);
  if (dyUp < H * 0.06 || vPeak < H * 0.35) return null;
  return {
    kind: 'legacy',
    power: Math.min(Math.max(vPeak / (H * SWIPE_FULL_V), 0.05), 1),
    loft: Math.min(dyUp / (H * SWIPE_FULL_L), 1),
    tiltDeg: 0,
    aimDelta: Math.min(Math.max(Math.atan2(top.x - s[0].x, dyUp) * 0.6, -0.3), 0.3),
    devN: 0,
  };
}

// ---- 제스처→launch 매핑 단위 테스트 (window.__golf.gestureTest) ----
function gestureTest() {
  const H = innerHeight, W = innerWidth;
  const run = (samples) => {
    const g = makeGesture(samples[0].x, samples[0].y, samples[0].t);
    for (let i = 1; i < samples.length; i++) gestureMove(g, samples[i].x, samples[i].y, samples[i].t);
    const r = gestureEnd(g);
    return r && {
      kind: r.kind,
      mph: +(HEAD_MIN + r.power * (HEAD_MAX - HEAD_MIN)).toFixed(1),
      loftDeg: +(LOFT_MIN + r.loft * (LOFT_MAX - LOFT_MIN)).toFixed(1),
      tiltDeg: +r.tiltDeg.toFixed(1),
    };
  };
  const x0 = W * 0.5, y0 = H * 0.7;
  function seq(backH, downMs, followH, sideW) {
    const s = [{ x: x0, y: y0, t: 0 }];
    let t = 0;
    for (let i = 1; i <= 10; i++) s.push({ x: x0, y: y0 + H * backH * i / 10, t: t += 40 });
    const n = Math.max(Math.round(downMs / 20), 2);
    for (let i = 1; i <= n; i++) s.push({ x: x0 + W * (sideW || 0) * i / n, y: y0 + H * backH * (1 - i / n), t: t += 20 });
    for (let i = 1; i <= 5; i++) s.push({ x: x0 + W * (sideW || 0), y: y0 - H * followH * i / 5, t: t += 20 });
    return s;
  }
  return {
    fullPure:  run(seq(0.45, 160, 0.30, 0)),    // 풀백스윙 + 빠른 다운스윙 정타 → 최대급 mph, tilt 0
    halfBack:  run(seq(0.20, 200, 0.20, 0)),    // 하프 백스윙 → 중간 mph
    hardSlice: run(seq(0.40, 160, 0.25, 0.2)),  // 심한 우편차 → tilt ≈ −14°
    aceSweep130: aceSweep(130),                 // launch() 직접 호출 경로 불변 확인
  };
}

// ---- 임팩트 존 HUD ----
const impactLineEl = document.getElementById('impactLine');
const impactHintEl = document.getElementById('impactHint');
let hintTimer = 0;
function showImpactLine(x, y) {
  impactLineEl.style.left = x + 'px';
  impactLineEl.style.top = y + 'px';
  impactLineEl.classList.add('on');
}
function hideImpactLine() { impactLineEl.classList.remove('on'); }
function flashImpact(devN) {
  impactHintEl.style.left = impactLineEl.style.left;
  impactHintEl.style.top = impactLineEl.style.top;
  impactHintEl.textContent = Math.abs(devN) < 0.25 ? '✦' : (devN > 0 ? '▶' : '◀');
  impactHintEl.style.color = Math.abs(devN) < 0.25 ? '#fff' : '#ffd23f';
  impactHintEl.classList.add('on');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => impactHintEl.classList.remove('on'), 600);
}

function shapeName(tiltDeg) {
  if (Math.abs(tiltDeg) < 3) return '스트레이트';
  if (tiltDeg <= -8) return '슬라이스';
  if (tiltDeg < 0) return '페이드';
  if (tiltDeg >= 8) return '훅';
  return '드로';
}

function fireShot(r) {
  state.power = r.power;
  state.loft = r.loft;
  state.aim += r.aimDelta;
  state.shape = shapeName(r.tiltDeg);
  state.pure = Math.abs(r.devN) < 0.25;
  shoot(r.tiltDeg * Math.PI / 180);
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  sfx.unlock();
  pDown = true; pStartX = pLastX = e.clientX; pStartY = e.clientY; pMoved = 0;
  if (state.phase === PHASE.SWING) {
    gest = makeGesture(e.clientX, e.clientY, performance.now());
    gest.creaked = gest.hitPlayed = false;
    showImpactLine(e.clientX, e.clientY);
  }
});
addEventListener('pointermove', (e) => {
  if (!pDown) return;
  pMoved = Math.max(pMoved, Math.hypot(e.clientX - pStartX, e.clientY - pStartY));
  if (state.phase === PHASE.AIM) {
    state.aim += (e.clientX - pLastX) * 0.004;
    pLastX = e.clientX;
  } else if (state.phase === PHASE.SWING && gest) {
    gestureMove(gest, e.clientX, e.clientY, performance.now());
    if (gest.mode === 'back' && !gest.creaked) { gest.creaked = true; sfx.takeback(); }
    if (gest.impacted && !gest.hitPlayed) {
      gest.hitPlayed = true;
      flashImpact(Math.min(Math.max((gest.impactX - gest.x0) / (innerWidth * 0.22), -1), 1));
    }
    // 라이브 프리뷰 (바에 표시)
    if (gest.impacted) {
      state.loft = Math.min(Math.max((gest.y0 - Math.min(gest.minYAfter, e.clientY)) / (innerHeight * FOLLOW_FULL_L), 0), 1);
    } else if (gest.mode !== 'address') {
      const cap = Math.min(gest.backLen / (innerHeight * BACK_FULL_L), 1);
      state.power = gest.mode === 'down'
        ? cap * Math.min(gest.downV / (innerHeight * REALIZE_FULL_V), 1)
        : cap;
    } else {
      const dyUp = Math.max(gest.y0 - e.clientY, 0);
      state.loft = Math.min(dyUp / (innerHeight * SWIPE_FULL_L), 1);
      state.power = Math.min(peakUpVel(gest.samples) / (innerHeight * SWIPE_FULL_V), 1);
    }
  }
});
addEventListener('pointerup', () => {
  if (!pDown) return;
  pDown = false;
  if (state.phase === PHASE.SWING && gest) {
    const r = gestureEnd(gest);
    gest = null;
    hideImpactLine();
    if (r) { fireShot(r); return; }
    state.power = state.loft = 0; // 무효 제스처 → 프리뷰 리셋
  }
  if (pMoved < 8) advance(); // 탭
});
addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
// ↻ = 라운드 처음부터 (홀당 1샷이므로 홀 단위 재시도는 없음)
document.getElementById('retry').addEventListener('pointerup', (e) => {
  e.stopPropagation();
  sfx.tap();
  startRound();
});
const soundBtn = document.getElementById('sound');
soundBtn.addEventListener('pointerup', (e) => {
  e.stopPropagation();
  sfx.unlock();
  soundBtn.textContent = sfx.toggle() ? '🔇' : '🔊';
});

// 📊 기록 패널 — 일 / 주 / 월 / 전체 최고 점수
const recordsEl = document.getElementById('records');
const recCardEl = document.getElementById('recCard');
document.getElementById('recBtn').addEventListener('pointerup', (e) => {
  e.stopPropagation();
  sfx.tap();
  statsCache = store.stats();
  const s = statsCache;
  recCardEl.innerHTML =
    `<h3>📊 내 기록</h3>` +
    `<table>` +
    `<tr><td>오늘 최고</td><td>${s.day || '—'}</td></tr>` +
    `<tr><td>이번 주 최고</td><td>${s.week || '—'}</td></tr>` +
    `<tr><td>이번 달 최고</td><td>${s.month || '—'}</td></tr>` +
    `<tr><td>역대 최고</td><td>${s.all || '—'}</td></tr>` +
    `</table>` +
    `<div class="sub">오늘 ${s.todayPlays}라운드 · 홀인원 ${s.todayAces}개<br>` +
    `통산 ${s.totalPlays}라운드 · 만점 ${HOLES * ACE_SCORE}점<br>` +
    `코스 시드 ${state.seedKey} (매일 0시 갱신)</div>` +
    `<div class="close">탭하면 닫기</div>`;
  recordsEl.classList.add('on');
});
recordsEl.addEventListener('pointerup', (e) => {
  e.stopPropagation();
  recordsEl.classList.remove('on');
});

function advance() {
  switch (state.phase) {
    case PHASE.AIM:      state.phase = PHASE.SWING; sfx.tap(); break;
    case PHASE.RESULT:   sfx.tap(); nextHole(); break;
    case PHASE.ROUNDEND: sfx.tap(); startRound(); break;
  }
}

function headMphNow() { return HEAD_MIN + state.power * (HEAD_MAX - HEAD_MIN); }
function loftDegNow() { return LOFT_MIN + state.loft * (LOFT_MAX - LOFT_MIN); }

function shoot(tiltRad = 0) {
  state.phase = PHASE.FLY;
  state.flyTime = 0; state.acc = 0;
  state.bounceCount = 0;
  arrow.visible = false;
  // 타격음은 실제 볼 스피드(m/s)로 구동 — 비행 공기음은 프레임 루프에서 지속 재생
  const ballSpd = headMphNow() * MPH * smashFactor(loftDegNow());
  sfx.impactHit();
  launch(sim, headMphNow(), loftDegNow(), state.aim, tiltRad);
}

function nextHole() {
  if (state.holeIdx + 1 < HOLES) loadHole(state.holeIdx + 1);
  else endRound();
}

function pushTrail() {
  if (state.trailCount >= TRAIL_MAX) return;
  const i = state.trailCount * 3;
  trailPos[i] = sim.px; trailPos[i + 1] = sim.py; trailPos[i + 2] = sim.pz;
  state.trailCount++;
  trailGeo.setDrawRange(0, state.trailCount);
  trailGeo.attributes.position.needsUpdate = true;
}

// ---------- 카메라 ----------
const camTarget = new THREE.Vector3();
const camWant = new THREE.Vector3();
const _ballPos = new THREE.Vector3();
const _ballVel = new THREE.Vector3();
function updateCamera(instant) {
  _ballPos.set(sim.px, sim.py, sim.pz);
  if (state.phase === PHASE.FLY || state.phase === PHASE.RESULT || state.phase === PHASE.ROUNDEND) {
    const dir = new THREE.Vector3(sim.vx, 0, sim.vz);
    if (dir.lengthSq() < 0.01) dir.set(Math.sin(state.aim), 0, Math.cos(state.aim));
    dir.normalize();
    camWant.copy(_ballPos).addScaledVector(dir, -13).setY(sim.py + 6);
    camTarget.copy(_ballPos);
  } else {
    const dir = new THREE.Vector3(Math.sin(state.aim), 0, Math.cos(state.aim));
    camWant.copy(_ballPos).addScaledVector(dir, -11).setY(5.5);
    camTarget.copy(_ballPos).addScaledVector(dir, 14).setY(1.5);
  }
  if (instant) camera.position.copy(camWant);
  else camera.position.lerp(camWant, 0.08);
  camera.lookAt(camTarget);
}

// ---------- HUD ----------
const el = {
  info: document.getElementById('info'),
  score: document.getElementById('score'),
  powerWrap: document.getElementById('powerWrap'),
  loftWrap: document.getElementById('loftWrap'),
  powerLabel: document.getElementById('powerLabel'),
  loftLabel: document.getElementById('loftLabel'),
  powerFill: document.querySelector('#powerBar > i'),
  loftFill: document.querySelector('#loftBar > i'),
  powerVal: document.querySelector('#powerBar .bar-val'),
  loftVal: document.querySelector('#loftBar .bar-val'),
  msg: document.getElementById('msg'),
  prompt: document.getElementById('prompt'),
};
const ACT = isTouch ? '탭' : '클릭';
el.powerLabel.textContent = '스윙 스피드';
el.loftLabel.textContent = '로프트';

const DIRS = ['↑ 앞', '↗', '→ 오른쪽', '↘', '↓ 뒤', '↙', '← 왼쪽', '↖'];
function windText() {
  const s = Math.hypot(sim.windX, sim.windZ);
  if (s < 0.4) return '무풍';
  const a = Math.atan2(sim.windX, sim.windZ);
  const i = Math.round(((a + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
  return `${DIRS[i]} ${s.toFixed(1)} m/s`;
}
function showMsg(html) { el.msg.innerHTML = html; el.msg.classList.add('on'); }
function hideMsg() { el.msg.classList.remove('on'); }

function updateHud() {
  const toPin = Math.hypot(sim.px - sim.holeX, sim.pz - sim.holeZ);
  el.info.innerHTML =
    `HOLE <b>${state.holeIdx + 1}</b> / ${HOLES}<br>` +
    `핀까지 <b>${(state.phase === PHASE.FLY ? toPin : state.distance).toFixed(0)} m</b><br>` +
    `바람 ${windText()}`;
  el.score.innerHTML =
    `총점 <b>${state.roundScore}</b><br>` +
    `홀인원 ${state.aces}<br>` +
    `오늘 최고 ${statsCache.day || '—'}`;

  el.powerWrap.classList.toggle('on', state.phase === PHASE.SWING || state.phase === PHASE.FLY);
  el.loftWrap.classList.toggle('on', state.phase === PHASE.SWING || state.phase === PHASE.FLY);
  el.powerFill.style.width = (state.power * 100).toFixed(0) + '%';
  el.loftFill.style.width = (state.loft * 100).toFixed(0) + '%';
  el.powerVal.textContent = Math.round(headMphNow()) + ' mph';
  el.loftVal.textContent = Math.round(loftDegNow()) + '°';

  const prompts = {
    [PHASE.AIM]: `드래그로 조준 · ${ACT}하면 스윙 준비`,
    [PHASE.SWING]: '아래로 당겨 백스윙 → 위로 휘두르기!',
    [PHASE.FLY]: '…',
    [PHASE.RESULT]: `${ACT}으로 계속`,
    [PHASE.ROUNDEND]: `${ACT}으로 새 라운드`,
  };
  el.prompt.textContent = prompts[state.phase];
}

// ---------- 루프 ----------
let last = performance.now();
// 청자는 카메라가 아니라 티에 선 플레이어다. 카메라는 공을 쫓지만(연출) 귀는 티에 남는다.
// 이 구분이 없으면 추격 카메라 때문에 공이 늘 13 m 앞에 있는 셈이 되어 통과음이 영원히 꺼지지 않는다.
const EAR_Y = 1.6;
function listenerDist(x, y, z) { return Math.hypot(x, y - EAR_Y, z); }
// 음속 전파 지연 — 130 m 지점의 착지음은 약 0.38초 뒤에 들린다
function propDelay(x, y, z) { return listenerDist(x, y, z) / 343; }

function impactFx(x, z, vy, surfName) {
  fx.impact(x, z, vy);
  sfx.bounce(Math.abs(vy), surfName, state.bounceCount++, propDelay(x, 0, z));
}

// 통과음 / 구름음 / 앰비언스 파라미터 갱신 — 노드를 만들지 않고 AudioParam만 건드린다
function updateFlightAudio() {
  sfx.ambient(Math.hypot(sim.windX, sim.windZ));   // 앰비언스는 항상 살아 있다
  if (state.phase !== PHASE.FLY) { sfx.flight(0, 0, 0, false); sfx.rolling(0, false); return; }
  const spd = Math.hypot(sim.vx, sim.vy, sim.vz);
  const dist = Math.max(listenerDist(sim.px, sim.py, sim.pz), 0.001);
  // 티 기준 상대속도 (양수 = 멀어짐) → 도플러 하강
  const radialV = (sim.vx * sim.px + sim.vy * (sim.py - EAR_Y) + sim.vz * sim.pz) / dist;
  sfx.flight(spd, dist, radialV, !sim.grounded);
  sfx.rolling(Math.hypot(sim.vx, sim.vz), sim.grounded);
}

function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  if (state.phase === PHASE.AIM) {
    const left = keys.has('ArrowLeft') || keys.has('KeyA');
    const right = keys.has('ArrowRight') || keys.has('KeyD');
    if (left) state.aim -= 0.9 * dt;
    if (right) state.aim += 0.9 * dt;
    arrow.position.set(sim.px, 0.1, sim.pz);
    arrow.rotation.y = state.aim;
  } else if (state.phase === PHASE.FLY) {
    state.flyTime += dt;
    state.acc += dt;
    let result = null;
    let guard = 0;
    while (state.acc >= SUB && !result && guard++ < 60) {
      result = physStep(sim, SUB, impactFx);
      state.acc -= SUB;
    }
    if (sim.lipped && !state.lipPlayed) { state.lipPlayed = true; sfx.lipout(propDelay(sim.holeX, 0, sim.holeZ)); }
    pushTrail();
    if (state.flyTime > FLY_TIMEOUT && !result) result = 'stop';
    if (result) finish(result);
  }

  ball.position.set(sim.px, sim.py, sim.pz);

  // 백스윙 호 게이지 갱신
  if (state.phase === PHASE.SWING && gest && (gest.mode === 'back' || gest.mode === 'down')) {
    const cap = Math.min(gest.backLen / (innerHeight * BACK_FULL_L), 1);
    const span = 0.3 + 1.3 * cap;
    const adx = Math.sin(state.aim), adz = Math.cos(state.aim);
    const R = 3.2;
    for (let k = 0; k < ARC_N; k++) {
      const a = span * k / (ARC_N - 1);
      const i = k * 3;
      arcPosArr[i]     = sim.px - adx * Math.sin(a) * R;
      arcPosArr[i + 1] = sim.py + (1 - Math.cos(a)) * R;
      arcPosArr[i + 2] = sim.pz - adz * Math.sin(a) * R;
    }
    arcGeo.attributes.position.needsUpdate = true;
    backArc.visible = true;
  } else backArc.visible = false;

  const gh = groundH(sim, sim.px, sim.pz);
  const h = Math.max(sim.py - gh - BALL_VIS_R, 0);
  ballShadow.position.set(sim.px, gh + 0.07, sim.pz);
  ballShadow.scale.setScalar(1 + h * 0.05);
  ballShadow.material.opacity = 0.26 * Math.max(1 - h / 30, 0.12);
  ballShadow.visible = state.phase !== PHASE.RESULT || !state.lastAce;

  flag.rotation.y = Math.sin(now / 400) * 0.25;
  flag.scale.x = 1 + Math.sin(now / 260) * 0.06;
  for (const c of clouds.children) {
    c.position.x += dt * 0.9;
    if (c.position.x > 240) c.position.x = -240;
  }

  _ballPos.set(sim.px, sim.py, sim.pz);
  _ballVel.set(sim.vx, sim.vy, sim.vz);
  fx.update(dt, _ballPos, _ballVel, state.phase === PHASE.FLY);
  updateFlightAudio();
  updateCamera(false);
  updateHud();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

function finish(result) {
  state.phase = PHASE.RESULT;
  sfx.silence();   // 통과음·구름음 페이드아웃 (앰비언스는 유지)
  const toPin = Math.hypot(sim.px - sim.holeX, sim.pz - sim.holeZ);
  const holed = result === 'in';
  const gained = holeScore(toPin, holed);

  state.lastAce = holed;
  state.holeScores[state.holeIdx] = { score: gained, dist: holed ? 0 : toPin, ace: holed };
  // 홀별 점수의 합으로 재계산 — 같은 홀을 다시 쳐도 중복 적립되지 않음
  state.roundScore = state.holeScores.reduce((n, h) => n + (h ? h.score : 0), 0);
  state.aces = state.holeScores.reduce((n, h) => n + (h && h.ace ? 1 : 0), 0);

  const last = state.holeIdx + 1 === HOLES;
  const nextLabel = last ? '라운드 결과 보기' : `${state.holeIdx + 2}번 홀`;
  const shapeTxt = state.shape ? ` · ${state.shape}` : '';

  if (holed) {
    ball.position.set(sim.holeX, -BALL_VIS_R, sim.holeZ);
    sim.px = sim.holeX; sim.pz = sim.holeZ; sim.py = -BALL_VIS_R;
    fx.burst(sim.holeX, sim.holeZ);
    sfx.holeIn(propDelay(sim.holeX, 0, sim.holeZ));
    showMsg(
      `<span class="big">🏌️ HOLE IN ONE!</span>` +
      `+${gained}점 · ${state.distance} m${shapeTxt}<br>` +
      `누적 <b>${state.roundScore}</b>점<br>` +
      `<span class="hint">${ACT} — ${nextLabel}</span>`
    );
  } else {
    sfx.miss();
    const lip = sim.lipped ? '립아웃! ' : '';
    const near = toPin < 3 ? '아깝다! 홀 바로 옆.' : toPin < 10 ? '나쁘지 않아요.' : '조금 더 정밀하게.';
    showMsg(
      `<span class="big">+${gained}점</span>` +
      `${lip}핀까지 ${toPin.toFixed(1)} m${shapeTxt} · ${near}<br>` +
      `누적 <b>${state.roundScore}</b>점<br>` +
      `<span class="hint">${ACT} — ${nextLabel}</span>`
    );
  }
}

function endRound() {
  state.phase = PHASE.ROUNDEND;
  const prev = statsCache;
  const now = new Date();
  store.add({ d: dayKey(now), w: weekKey(now), m: monthKey(now), s: state.roundScore, a: state.aces });
  statsCache = store.stats();

  const rows = state.holeScores.map((h, i) =>
    `<tr><td>${i + 1}H</td><td>${h.ace ? '<span class="ace">HOLE IN ONE</span>' : h.dist.toFixed(1) + ' m'}</td>` +
    `<td${h.ace ? ' class="ace"' : ''}>${h.score}</td></tr>`
  ).join('');

  const badges = [];
  if (state.roundScore > prev.all) badges.push('🏆 개인 최고 기록!');
  else if (state.roundScore > prev.day) badges.push('⭐ 오늘 최고 기록');
  const badge = badges.length ? `<div style="color:#ffd23f;font-weight:700;margin-bottom:6px">${badges[0]}</div>` : '';

  showMsg(
    `<span class="big">${state.roundScore}점</span>` +
    badge +
    `9홀 완주 · 홀인원 ${state.aces}개<br>` +
    `<table class="sum">${rows}</table>` +
    `<div style="font-size:12px;opacity:.75;margin-top:8px">` +
    `오늘 최고 ${statsCache.day} · 이번 주 ${statsCache.week} · 이번 달 ${statsCache.month}</div>` +
    `<span class="hint">${ACT} — 새 라운드</span>`
  );
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---- 오디오 실측 검증: OfflineAudioContext 렌더링 → 피크·RMS·길이·스펙트럼 중심 ----
function spectralCentroid(d, sr) {
  const N = 1024;
  let pi = 0, pv = 0;
  for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > pv) { pv = a; pi = i; } }
  const start = Math.max(0, Math.min(pi, d.length - N));
  let num = 0, den = 0;
  for (let k = 1; k < N / 2; k++) {
    let re = 0, im = 0;
    for (let n = 0; n < N; n++) {
      const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / (N - 1));
      const x = d[start + n] * w, a = -2 * Math.PI * k * n / N;
      re += x * Math.cos(a); im += x * Math.sin(a);
    }
    const mag = Math.hypot(re, im);
    num += mag * (k * sr / N); den += mag;
  }
  return den > 0 ? num / den : 0;
}

async function audioTest() {
  const Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const SR = 44100;
  async function render(fn, secs = 0.5) {
    const oc = new Off(1, Math.ceil(SR * secs), SR);
    fn(oc, oc.destination, 0.005);
    const buf = await oc.startRendering();
    const d = buf.getChannelData(0);
    let peak = 0, sum = 0, lastIdx = 0;
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
      sum += d[i] * d[i];
      if (a > 2e-3) lastIdx = i;
    }
    return {
      peak: +peak.toFixed(3),
      clipping: peak >= 1,
      rms: +Math.sqrt(sum / d.length).toFixed(4),
      durMs: +(lastIdx / SR * 1000).toFixed(1),
      centroidHz: Math.round(spectralCentroid(d, SR)),
    };
  }

  const impactFast = await render((c, d, t) => SND.impact(c, d, t, 60, true));
  const impactMiss = await render((c, d, t) => SND.impact(c, d, t, 60, false));
  const green  = await render((c, d, t) => SND.land(c, d, t, 'green', 14, 0));
  const rough  = await render((c, d, t) => SND.land(c, d, t, 'rough', 14, 0));
  const sand   = await render((c, d, t) => SND.land(c, d, t, 'sand', 14, 0));
  const holeIn = await render((c, d, t) => {
    SND.burst(c, d, t, { dur: 0.12, vol: 0.2, f0: 1200, f1: 500, q: 2 });
    [523, 659, 784, 1047].forEach((f, i) =>
      SND.ping(c, d, t + 0.12 + i * 0.11, { f, dur: 0.18, vol: 0.16, type: 'triangle' }));
  }, 0.8);

  // 통과음 모델: 곁을 스칠 때만 들리고 20 m를 넘으면 사실상 무음이어야 한다
  const near1 = SND.nearField(1), near20 = SND.nearField(20), near100 = SND.nearField(100);
  const absorb1 = SND.airAbsorb(1), absorb100 = SND.airAbsorb(100);
  // 샘플 뱅크 상태 (라이브 컨텍스트 기준) — 로드 실패 시 합성 폴백이 동작해야 함
  const sampleStatus = {};
  for (const cat of Object.keys(SAMPLES)) {
    const bufs = bank.buf[cat] || [];
    sampleStatus[cat] = bufs.map(b => ({ durMs: Math.round(b.duration * 1000), ch: b.numberOfChannels, sr: b.sampleRate }));
  }
  return {
    impactFast, impactMiss, green, rough, sand, holeIn,
    samples: { ready: bank.ready, status: sampleStatus },
    checks: {
      noClipping: [impactFast, impactMiss, green, rough, sand, holeIn].every(r => !r.clipping),
      impactDurInRange: impactFast.durMs >= 60 && impactFast.durMs <= 120,
      centroidOrder_sand_gt_rough_gt_green: sand.centroidHz > rough.centroidHz && rough.centroidHz > green.centroidHz,
      passbyFadesBy20m: near20 / near1 < 0.1,          // 20 m에서 −20 dB 이하
      passbyInaudibleAt100m: near100 * 0.32 < 0.004,   // 게이트에 걸려 완전 무음
      highsDarkenWithDistance: absorb100 < absorb1 * 0.25,
      propDelay130mMs: +(130 / 343 * 1000).toFixed(0),
      samplesLoaded: bank.ready && Object.values(sampleStatus).every(a => a.length > 0),
    },
  };
}

// 헤드리스 검증 훅 (벤치마크·밸런스 스윕·오디오)
window.__golf = {
  bench, aceSweep, benchCarry, gestureTest, audioTest, makeSim, launch, physStep,
  buildRound, holeScore, store, dayKey, weekKey, monthKey, state, sim, SND, sfx, bank,
  SUB, HEAD_MIN, HEAD_MAX, LOFT_MIN, LOFT_MAX, HOLES, DIST_MIN, DIST_MAX,
};

document.getElementById('loading').remove();
// 샘플 로드 후 엔진 표시가 덧붙는다. 구버전 index.html(배지 없음)과 섞여도 죽지 않게 가드.
const _buildTag = document.getElementById('build');
if (_buildTag) _buildTag.textContent = 'b' + BUILD;
statsCache = store.stats();
startRound();
requestAnimationFrame(frame);
