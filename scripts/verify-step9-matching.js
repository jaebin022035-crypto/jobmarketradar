// scripts/verify-step9-matching.js — Step 9 요구사항 매칭 통합 검증
// ------------------------------------------------------------
// 계획서(step9-recruit-matching-plan.md) 10절 완료 기준 자동 검증.
// 실행: node -r dotenv/config scripts/verify-step9-matching.js
// 주의: 붙여넣기 분석·URL 분석은 실제 Gemini 호출 포함 (수십 초 소요).
'use strict';

const { createApp } = require('../server');
const db = require('../db');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const http = require('http');
function listen(app) {
  return new Promise((res) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => res(server));
  });
}
function req(server, { method = 'GET', path, body, cookie }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port: server.address().port, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = null;
        if (data) { try { parsed = JSON.parse(data); } catch { parsed = data; } }
        resolve({ status: res.statusCode, setCookie: res.headers['set-cookie'] || [], body: parsed });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
const cookieOf = (r) => {
  const raw = r.setCookie.find((c) => c.startsWith('jmr_session='));
  return raw ? raw.split(';')[0] : '';
};

(async () => {
  const app = createApp();
  const server = await listen(app);
  const ts = Date.now();
  let r;

  console.log('\n[0] 로그인 (검증용 계정)');
  r = await req(server, { method: 'POST', path: '/api/auth/register',
    body: { name: '검증9', user_id: `v9_${ts}`, password: 'test1234' } });
  const cookie = cookieOf(r);
  check('계정 생성+로그인', !!cookie);

  console.log('\n[1] DB 경로 (1차 소스) — 회사검색 → 공고 → 요구사항');
  r = await req(server, { path: '/api/companies/search?q=' + encodeURIComponent('카카오'), cookie });
  check('회사 검색 결과 있음 (카카오)', Array.isArray(r.body) && r.body.length > 0, JSON.stringify(r.body).slice(0, 80));
  const seqno = r.body?.[0]?.emp_seqno;

  r = await req(server, { path: '/api/companies/search?q=' + encodeURIComponent('카'), cookie });
  check('1자 검색은 빈 배열 (가드)', Array.isArray(r.body) && r.body.length === 0);

  if (seqno) {
    r = await req(server, { path: `/api/postings/${seqno}/requirements`, cookie });
    const b = r.body || {};
    check('요구사항 번들 반환 (200)', r.status === 200);
    check('주요업무/자격 구조 포함', Array.isArray(b.duties) && Array.isArray(b.required));
    check('meta.source=db', b.meta?.source === 'db');
  }
  r = await req(server, { path: '/api/postings/999999/requirements', cookie });
  check('없는 공고 → 404', r.status === 404);

  console.log('\n[2] URL 경로 (2차 소스) — 차단 도메인 감지');
  r = await req(server, { method: 'POST', path: '/api/ai/fetch-url',
    cookie, body: { url: 'https://www.saramin.co.kr/job/123' } });
  check('사람인 URL → 400 + 붙여넣기 안내', r.status === 400 && r.body?.fallback === 'paste', JSON.stringify(r.body).slice(0, 90));
  r = await req(server, { method: 'POST', path: '/api/ai/fetch-url',
    cookie, body: { url: 'https://people.wanted.co.kr/req/1' } });
  check('원티드 URL → 400', r.status === 400 && r.body?.fallback === 'paste');
  r = await req(server, { method: 'POST', path: '/api/ai/fetch-url',
    cookie, body: { url: 'notaurl' } });
  check('잘못된 URL 형식 → 400', r.status === 400);

  console.log('\n[3] 붙여넣기 경로 (3차 소스) — 실제 2단 분석 [Gemini 호출]');
  const paste = `스타트업 (주)테스트 채용공고
모집분야: 백엔드 개발자 (Node.js)
주요 업무
- REST API 설계 및 개발
- MySQL 데이터 모델링
지원자격
- Node.js 2년 이상
- RDBMS 이해도
우대사항
- AWS 운영 경험
- Docker/Kubernetes
근무지: 서울 강남 / 정규직
로그인 공고 더보기 개인정보처리방침 이용약관`;
  r = await req(server, { method: 'POST', path: '/api/ai/analyze-requirements', cookie, body: { text: paste } });
  check('붙여넣기 분석 200', r.status === 200, JSON.stringify(r.body).slice(0, 120));
  const bundle = r.body?.bundle || {};
  check('2단 모델 기록 (pipe→quality)', Array.isArray(r.body?.models) && r.body.models.length === 2,
    JSON.stringify(r.body?.models));
  check('직무명 추출', /백엔드|개발/.test(bundle.position || ''), bundle.position);
  check('주요업무 추출', (bundle.duties || []).length >= 2);
  check('자격 추출', (bundle.required || []).length >= 2);
  check('우대 분리', (bundle.preferred || []).some((x) => /AWS|Docker|쿠버/.test(x)));

  r = await req(server, { method: 'POST', path: '/api/ai/analyze-requirements', cookie, body: { text: '짧음' } });
  check('너무 짧은 원문 → 400', r.status === 400);

  console.log('\n[4] 생성 연결 — req_json 저장 → 근거 기반 생성');
  // 프로필+자소서 생성 후 req_json 저장
  r = await req(server, { method: 'POST', path: '/api/profiles', cookie,
    body: { name: '검증프로필', experience: 'Node.js 백엔드 2년, 결제 API 개발', skills: 'Node.js, MySQL, AWS' } });
  const pid = r.body?.id;
  r = await req(server, { method: 'POST', path: '/api/cover-letters', cookie,
    body: { profile_id: pid, title: '검증자소서' } });
  const clId = r.body?.id;
  check('자소서 생성', !!clId);

  // 요구사항 저장 (db 소스 번들 재사용)
  const dbBundle = await req(server, { path: `/api/postings/${seqno}/requirements`, cookie });
  r = await req(server, { method: 'PUT', path: `/api/cover-letters/${clId}`, cookie,
    body: { req_source: 'db', req_posting_id: String(seqno), req_json: JSON.stringify(dbBundle.body) } });
  check('req_json 저장 (200)', r.status === 200 && r.body?.req_source === 'db');

  // 저장 복원 확인
  r = await req(server, { path: `/api/cover-letters/${clId}`, cookie });
  check('req_json 복원', (() => { try { return !!JSON.parse(r.body?.req_json || '').duties; } catch { return false; } })());

  // 실제 생성 (Gemini 호출 — 근거 반영 확인은 로그/성공 여부로)
  console.log('  ⏳ 실제 자소서 생성 중 (Gemini 호출, 수십 초)...');
  r = await req(server, { method: 'PUT', path: `/api/cover-letters/${clId}`, cookie,
    body: { target_job: '소프트웨어' } });
  r = await req(server, { method: 'POST', path: `/api/cover-letters/${clId}/generate`, cookie });
  check('요구사항 기반 생성 성공', r.status === 200 && (r.body?.motivation || '').length > 50,
    JSON.stringify(r.body).slice(0, 100));
  check('5항목 모두 생성', ['motivation','growth','strength','career','vision'].every((k) => (r.body?.[k] || '').length > 30));

  console.log('\n[5] 권한·회귀');
  for (const [m, p] of [
    ['GET', '/api/companies/search?q=' + encodeURIComponent('카카오')],
    ['GET', '/api/postings/' + seqno + '/requirements'],
    ['POST', '/api/ai/fetch-url'],
    ['POST', '/api/ai/analyze-requirements'],
  ]) {
    r = await req(server, { method: m, path: p, body: m === 'POST' ? {} : undefined });
    check(`미로그인 ${m} ${p.slice(0, 40)} → 401`, r.status === 401, `status=${r.status}`);
  }
  // req 없는 레거시 프롬프트 폴백은 단위 확인 완료 (buildPrompt 분기)
  check('generation_logs에 3.5 모델 기록', (() => {
    const row = db.getDb().prepare('SELECT model FROM generation_logs ORDER BY id DESC LIMIT 1').get();
    return /3\.5-flash/.test(row?.model || '');
  })(), db.getDb().prepare('SELECT model FROM generation_logs ORDER BY id DESC LIMIT 1').get()?.model);

  // 정리
  const d = db.getDb();
  const uid = d.prepare('SELECT id FROM users WHERE user_id = ?').get(`v9_${ts}`)?.id;
  if (uid) {
    d.prepare('DELETE FROM profiles WHERE user_id = ?').run(uid);
    d.prepare('DELETE FROM sessions WHERE user_id = ?').run(uid);
    d.prepare('DELETE FROM users WHERE id = ?').run(uid);
  }
  server.close();
  console.log(`\n========== 결과: ${pass} 통과 / ${fail} 실패 ==========`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('검증 오류:', e); process.exit(1); });
