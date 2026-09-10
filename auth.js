// auth.js — 회원 인증 모듈 (Step 8)
// ------------------------------------------------------------
// 로그인/회원가입/세션 관리. 이력서 개인정보 격리의 핵심.
//
// 설계 노트 (docs/step8-auth-plan.md 3.1절):
//   - 비밀번호: Node 내장 crypto.scrypt + per-user salt (bcrypt 등
//     네이티브 의존성 없음 → 어떤 환경에서도 빌드 이슈 0)
//   - 세션: 랜덤 토큰(64hex)을 쿠키로 발급, DB에는 SHA-256 해시만 저장
//     (DB 유출 시에도 토큰 재현 불가)
//   - 쿠키: HttpOnly + SameSite=Lax → JS/XSS 접근 차단
// ------------------------------------------------------------

'use strict';

const crypto = require('crypto');
const db = require('./db');

// ---------- 설정 ----------
const SESSION_COOKIE = 'jmr_session';   // 쿠키 이름
const SESSION_TTL_MS = 5 * 60 * 1000; // 5분 (300000)짧은 세션 수명->  브라우저 자동로그아웃,보안성 극대화 
const COOKIE_PATH = '/';

// 배포 환경이 HTTPS면 Secure 플래그 부여 (환경변수로 제어)
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';

// scrypt 파라미터 (OWASP 권장 기본선)
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

// ---------- 비밀번호 해싱 ----------
/**
 * 비밀번호 → "scrypt$N$r$p$salt$hash" 단일 문자열.
 * 저장 컬럼 하나로 파라미터까지 보존 → 나중에 파라미터 강화 시 구형 해시와 공존 가능.
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('hex'), hash.toString('hex')].join('$');
}

/**
 * 비밀번호 검증 — 저장된 해시와 재계산 값을 timingSafeEqual 로 비교.
 * @returns {boolean}
 */
function verifyPassword(password, stored) {
  try {
    const [algo, N, r, p, saltHex, hashHex] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(password), salt, expected.length,
      { N: Number(N), r: Number(r), p: Number(p) });
    return crypto.timingSafeEqual(actual, expected); // 길이 다르면 예외 → catch false
  } catch {
    return false;
  }
}

// ---------- 세션 ----------
/** 랜덤 세션 토큰 발급 (쿠키값용, 64자 hex) */
function newSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

/** 토큰 → DB 저장용 SHA-256 hex */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * 로그인 처리 — 세션 생성.
 * @returns {{token: string, expiresAt: string, user: object}}
 */
function issueSession(userId) {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.createSession({ tokenHash: hashToken(token), userId, expiresAt });
  return { token, expiresAt, user: db.getUserById(userId) };
}

/** 요청의 쿠키 헤더 파싱 → { name: value } */
function parseCookies(req) {
  const out = {};
  const raw = req.headers?.cookie;
  if (!raw) return out;
  for (const pair of raw.split(';')) {
    const i = pair.indexOf('=');
    if (i < 0) continue;
    out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  }
  return out;
}

/**
 * 요청 → 로그인 사용자 (미로그인/만료면 null).
 * 세션 토큰을 SHA-256 해시해 DB 조회 (토큰 자체는 DB에 두지 않음).
 */
function getUserFromRequest(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  return db.getSessionUser(hashToken(token)) || null;
}

/** 세션 수명 5분연장 (Heartbeat용) */
function extendSession(req){
  const token = parseCookies(req)[SESSION_COOKIE];
  if(!token) return false; // 토큰이 없으면 실패

  //5분 뒤의 시간 계산
  const newExpiresAt = new Date(Date.now() + (5 * 60 * 1000)).toISOString();

  //DB업데이트 함수 호출
}

/** 세션 종료 (로그아웃) */
function revokeSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) db.deleteSession(hashToken(token));
}

// ---------- 쿠키 헬퍼 ----------
/** 로그인 성공 시 Set-Cookie 헤더 값 조립 */
function sessionCookie(token, expiresAt) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'SameSite=Lax',
    `Path=${COOKIE_PATH}`,
    //`Expires=${new Date(expiresAt).toUTCString()}`,   브라우저가 종료되면 로그아웃시키기위해 우선 주석처리
  ];
  if (COOKIE_SECURE) parts.push('Secure');
  return parts.join('; ');
}

/** 로그아웃 시 Set-Cookie (즉시 만료) */
function clearCookie() {
  const parts = [`${SESSION_COOKIE}=`, 'HttpOnly', 'SameSite=Lax', `Path=${COOKIE_PATH}`, 'Expires=Thu, 01 Jan 1970 00:00:00 GMT'];
  if (COOKIE_SECURE) parts.push('Secure');
  return parts.join('; ');
}

// ---------- Express 미들웨어 ----------
/**
 * 로그인 필수 미들웨어 — 이력서 API 보호용.
 * 미로그인 → 401 { error } 로 즉시 응답, 로그인이면 req.user 를 채우고 next().
 */
function requireAuth(req, res, next) {
  const user = getUserFromRequest(req);
  if (!user) {
    return res.status(401).json({ error: '로그인이 필요합니다' });
  }
  req.user = user; // 이후 핸들러에서 req.user.id 로 소유권 스코핑
  next();
}

module.exports = {
  SESSION_COOKIE,
  hashPassword, verifyPassword,
  issueSession, revokeSession, getUserFromRequest,
  sessionCookie, clearCookie,
  requireAuth, extendSession,
};
