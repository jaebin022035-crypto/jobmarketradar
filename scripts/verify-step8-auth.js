// scripts/verify-step8-auth.js — Step 8 인증 시스템 통합 검증
// ------------------------------------------------------------
// 계획서(step8-auth-plan.md) 6절 완료 기준 체크리스트를 자동 검증.
// 실행: node scripts/verify-step8-auth.js  (서버 자체 기동 — 별도 서버 불필요)
// 계정 2개(A/B)를 만들어 개인정보 격리·차단 시나리오를 확인하고 종료 시 정리한다.
'use strict';

const { createApp } = require('../server');
const db = require('../db');
const auth = require('../auth');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// 최소 테스트 서버 (supertest 없이 http 모듈로 직접)
const http = require('http');
function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
function req(server, { method = 'GET', path, body, cookie }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers.Cookie = cookie;
    const r = http.request({
      host: '127.0.0.1', port: server.address().port, path, method, headers,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = null;
        if (data) { try { parsed = JSON.parse(data); } catch { parsed = data; } } // HTML 등은 원문 그대로
        resolve({
          status: res.statusCode,
          setCookie: res.headers['set-cookie'] || [],
          body: parsed,
        });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
const cookieOf = (res) => {
  const raw = res.setCookie.find((c) => c.startsWith('jmr_session='));
  return raw ? raw.split(';')[0] : '';
};

(async () => {
  const app = createApp();
  const server = await listen(app);
  const base = { A: null, B: null };
  const ts = Date.now();

  console.log('\n[1] 회원가입');
  let r = await req(server, { method: 'POST', path: '/api/auth/register',
    body: { name: '테스트A', user_id: `test_a_${ts}`, password: 'pass1234' } });
  check('이름/ID/PW 3필드로 가입 성공 (201)', r.status === 201, `status=${r.status}`);
  base.A = cookieOf(r);
  check('가입 즉시 세션 쿠키 발급 (자동 로그인)', !!base.A);

  r = await req(server, { method: 'POST', path: '/api/auth/register',
    body: { name: '중복', user_id: `test_a_${ts}`, password: 'pass1234' } });
  check('중복 ID 가입 → 409 거부', r.status === 409, `status=${r.status}`);

  r = await req(server, { method: 'POST', path: '/api/auth/register',
    body: { name: '짧은비번', user_id: `test_x_${ts}`, password: '12' } });
  check('6자 미만 비밀번호 → 400 거부', r.status === 400, `status=${r.status}`);

  console.log('\n[2] 로그인');
  r = await req(server, { method: 'POST', path: '/api/auth/login',
    body: { user_id: `test_a_${ts}`, password: 'pass1234' } });
  check('정확한 ID/PW 로그인 성공', r.status === 200 && !!cookieOf(r));
  check('응답에 사용자명 포함', r.body?.name === '테스트A');

  r = await req(server, { method: 'POST', path: '/api/auth/login',
    body: { user_id: `test_a_${ts}`, password: 'wrongpw' } });
  check('틀린 비밀번호 → 401', r.status === 401);

  r = await req(server, { method: 'POST', path: '/api/auth/login',
    body: { user_id: `nouser_${ts}`, password: 'whatever' } });
  check('없는 ID → 401', r.status === 401);
  check('열거 방지: 없는 ID와 틀린 PW 메시지 동일',
    r.body?.error === '아이디 또는 비밀번호가 올바르지 않습니다');

  r = await req(server, { path: '/api/auth/me', cookie: base.A });
  check('GET /me 로그인 상태 복원', r.status === 200 && r.body?.user_id === `test_a_${ts}`);

  console.log('\n[3] 미로그인 이력서 API 차단 (401)');
  for (const [m, p] of [
    ['GET', '/api/profiles'], ['GET', '/api/profiles/1'],
    ['GET', '/api/cover-letters'], ['POST', '/api/cover-letters'],
    ['GET', '/api/target-jobs'],
  ]) {
    r = await req(server, { method: m, path: p, body: m === 'POST' ? {} : undefined });
    check(`${m} ${p} → 401`, r.status === 401, `status=${r.status}`);
  }

  console.log('\n[4] 개인정보 격리 (A/B 서로 다른 데이터)');
  // 사용자 B 가입
  r = await req(server, { method: 'POST', path: '/api/auth/register',
    body: { name: '테스트B', user_id: `test_b_${ts}`, password: 'pass5678' } });
  base.B = cookieOf(r);
  check('사용자 B 가입 성공', r.status === 201);

  // A가 프로필+자소서 생성
  r = await req(server, { method: 'POST', path: '/api/profiles', cookie: base.A,
    body: { name: 'A의 이력서', experience: 'A의 개인 경력', skills: 'A의 기술' } });
  check('A 프로필 생성', r.status === 201, JSON.stringify(r.body));
  const pidA = r.body?.id;

  r = await req(server, { method: 'POST', path: '/api/cover-letters', cookie: base.A,
    body: { profile_id: pidA, title: 'A의 자소서' } });
  check('A 자소서 생성', r.status === 201, JSON.stringify(r.body));
  const clA = r.body?.id;

  // A에게는 보이고 B에게는 안 보임
  r = await req(server, { path: '/api/profiles', cookie: base.A });
  check('A는 자기 프로필 1개 목록 표시', Array.isArray(r.body) && r.body.length === 1);
  r = await req(server, { path: '/api/profiles', cookie: base.B });
  check('B의 프로필 목록에 A 프로필 없음 (0개)', Array.isArray(r.body) && r.body.length === 0);

  // B가 A의 리소스를 ID 직접 지정해 접근 시도
  r = await req(server, { path: `/api/profiles/${pidA}`, cookie: base.B });
  check('B가 A 프로필 ID 직접 조회 → 404', r.status === 404, `status=${r.status}`);
  r = await req(server, { path: `/api/cover-letters/${clA}`, cookie: base.B });
  check('B가 A 자소서 ID 직접 조회 → 404', r.status === 404, `status=${r.status}`);
  r = await req(server, { method: 'PUT', path: `/api/profiles/${pidA}`, cookie: base.B,
    body: { name: '해킹' } });
  check('B가 A 프로필 수정 시도 → 404', r.status === 404);
  r = await req(server, { method: 'DELETE', path: `/api/cover-letters/${clA}`, cookie: base.B });
  check('B가 A 자소서 삭제 시도 → 404', r.status === 404);
  r = await req(server, { method: 'POST', path: '/api/cover-letters', cookie: base.B,
    body: { profile_id: pidA, title: 'B가 A 프로필에 끼워넣기' } });
  check('B가 A 프로필에 자소서 생성 시도 → 404', r.status === 404);

  // B도 자기 프로필은 정상 생성 가능
  r = await req(server, { method: 'POST', path: '/api/profiles', cookie: base.B,
    body: { name: 'B의 이력서' } });
  check('B는 자기 프로필 정상 생성', r.status === 201);
  const pidB = r.body?.id;
  r = await req(server, { path: `/api/profiles/${pidB}`, cookie: base.B });
  check('B는 자기 프로필 조회 가능', r.status === 200);

  console.log('\n[5] 로그아웃');
  r = await req(server, { method: 'POST', path: '/api/auth/logout', cookie: base.A });
  check('로그아웃 요청 성공', r.status === 200);
  check('로그아웃 응답이 쿠키 만료 지시', r.setCookie.some((c) => c.includes('Expires=Thu, 01 Jan 1970')));
  r = await req(server, { path: '/api/profiles', cookie: base.A });
  check('로그아웃 후 이력서 API → 401 (세션 무효)', r.status === 401, `status=${r.status}`);

  console.log('\n[6] 공개 API 회귀 (로그인 없어도 대시보드 정상)');
  r = await req(server, { path: '/api/summary' });
  check('GET /api/summary 로그인 없이 200', r.status === 200);
  r = await req(server, { path: '/api/postings?page=1&size=1' });
  check('GET /api/postings 로그인 없이 200', r.status === 200);
  r = await req(server, { path: '/' });
  check('정적 index.html 서빙 200', r.status === 200);

  console.log('\n[7] 세션 하트비트 (5분 세션 + 3분 슬라이딩 연장)');
  // 재로그인 (위 [5]에서 A 로그아웃됨)
  r = await req(server, { method: 'POST', path: '/api/auth/login',
    body: { user_id: `test_a_${ts}`, password: 'pass1234' } });
  base.A = cookieOf(r);
  check('하트비트 검증용 재로그인', r.status === 200 && !!base.A);

  r = await req(server, { method: 'POST', path: '/api/auth/heartbeat', cookie: base.A });
  check('유효한 세션 하트비트 → 200 연장', r.status === 200 && r.body?.ok === true);

  // 로그인 응답 쿠키에 Expires가 없어야 함 (세션 쿠키 = 브라우저 종료 시 소멸)
  r = await req(server, { method: 'POST', path: '/api/auth/login',
    body: { user_id: `test_b_${ts}`, password: 'pass5678' } });
  const rawCookieB = r.setCookie.find((c) => c.startsWith('jmr_session='));
  check('로그인 쿠키는 세션 쿠키 (Expires 없음 → 브라우저 종료 시 소멸)',
    !rawCookieB || !/Expires=/i.test(rawCookieB), rawCookieB);

  // 세션을 강제 만료시킨 뒤 하트비트 → 부활하면 안 됨 (핵심 보안 속성)
  const d0 = db.getDb();
  const tokenHashA = require('crypto').createHash('sha256')
    .update(base.A.split('=')[1]).digest('hex');
  d0.prepare(`UPDATE sessions SET expires_at = ? WHERE token_hash = ?`)
    .run(new Date(Date.now() - 1000).toISOString(), tokenHashA);
  r = await req(server, { method: 'POST', path: '/api/auth/heartbeat', cookie: base.A });
  check('만료된 세션 하트비트 → 401 (부활 금지)', r.status === 401, `status=${r.status}`);
  r = await req(server, { path: '/api/auth/me', cookie: base.A });
  check('만료 후 /me → 401 (세션 무효 유지)', r.status === 401, `status=${r.status}`);

  // 미로그인(쿠키 없음) 하트비트도 401
  r = await req(server, { method: 'POST', path: '/api/auth/heartbeat' });
  check('쿠키 없는 하트비트 → 401', r.status === 401, `status=${r.status}`);

  // 정리: 테스트 사용자/프로필 삭제
  const d = db.getDb();
  const delA = d.prepare('SELECT id FROM users WHERE user_id = ?').get(`test_a_${ts}`);
  const delB = d.prepare('SELECT id FROM users WHERE user_id = ?').get(`test_b_${ts}`);
  d.prepare('DELETE FROM profiles WHERE user_id IN (?, ?)').run(delA.id, delB.id);
  d.prepare('DELETE FROM sessions WHERE user_id IN (?, ?)').run(delA.id, delB.id);
  d.prepare('DELETE FROM users WHERE id IN (?, ?)').run(delA.id, delB.id);
  console.log('\n🧹 테스트 데이터 정리 완료');

  server.close();
  console.log(`\n========== 결과: ${pass} 통과 / ${fail} 실패 ==========`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('검증 스크립트 오류:', e); process.exit(1); });
