// db.js — SQLite 연결 + 스키마 초기화 + upsert (Step 2 구현)
// 스키마 정의: db/schema.sql (필드 매핑: docs/api-field-mapping.md)
'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'data', 'jobmarket.db');
const SCHEMA_PATH = path.join(__dirname, 'db', 'schema.sql');

// DB 인스턴스 (싱글턴)
let db = null;

/**
 * DB 연결 + 스키마 초기화
 * - data/ 폴더 생성
 * - WAL 모드 + 외래키 ON
 * - db/schema.sql 실행 (CREATE TABLE IF NOT EXISTS)
 */
function init() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // 기존 DB 호환 마이그레이션: collection_snapshots 에 recruit_counts 컬럼이 없으면 추가
  // (G파트 단위를 공고 → 모집직무 단위로 통일하기 위해 신설된 컬럼)
  const cols = db.prepare("PRAGMA table_info(collection_snapshots)").all().map((r) => r.name);
  if (cols.length && !cols.includes('recruit_counts')) {
    db.exec("ALTER TABLE collection_snapshots ADD COLUMN recruit_counts TEXT NOT NULL DEFAULT '{}'");
  }
  // Step 7: cover_letters 에 company 컬럼(지원 회사명)이 없으면 추가
  const clCols = db.prepare("PRAGMA table_info(cover_letters)").all().map((r) => r.name);
  if (clCols.length && !clCols.includes('company')) {
    db.exec("ALTER TABLE cover_letters ADD COLUMN company TEXT");
  }
  // Step 7: profiles 에 emphasis 컬럼(항목별 강조 포인트 JSON)이 없으면 추가
  // Step 8: profiles 에 소유자 컬럼(user_id)도 없으면 추가 (로그인 이력서 격리)
  // — 기존(Step 7) DB 호환: 컬럼만 추가하고 기존 행은 user_id=NULL 로 둔다.
  //   SQLite 는 ALTER ADD COLUMN 에 REFERENCES 절을 쓸 수 없어 FK 정의는 생략
  //   (참조 무결성은 애플리케이션 레이어에서 소유권 검증으로 보장)
  // ★ schema.sql 실행 "전"에 수행 — 신규 인덱스(idx_profiles_user)가 이 컬럼을 참조하기 때문
  const pCols = db.prepare("PRAGMA table_info(profiles)").all().map((r) => r.name);
  if (pCols.length && !pCols.includes('emphasis')) {
    db.exec("ALTER TABLE profiles ADD COLUMN emphasis TEXT");
  }
  if (pCols.length && !pCols.includes('user_id')) {
    db.exec("ALTER TABLE profiles ADD COLUMN user_id INTEGER");
  }
  // Step 9: cover_letters 에 요구사항 소스 컬럼들이 없으면 추가
  // — 자소서 생성의 근거가 되는 채용공고 요구사항 번들을 저장
  //   req_source: 'db' | 'url' | 'paste' | 'company' (4계층 폴백 중 어느 소스였는지)
  // ★ clCols9.length 가드: 빈 DB(신규 설치)에선 테이블 자체가 없다 — 이 경우 아래
  //   schema.sql 실행이 테이블을 최신 형태로 만들므로 ALTER 는 건너뛴다.
  const clCols9 = db.prepare("PRAGMA table_info(cover_letters)").all().map((r) => r.name);
  if (clCols9.length) {
    for (const [col, ddl] of [
      ['req_source', 'TEXT'],
      ['req_posting_id', 'TEXT'],   // db 소스: job_postings.emp_seqno
      ['req_url', 'TEXT'],          // url 소스: 시도한 공고 URL
      ['req_text', 'TEXT'],         // url/paste 소스 원문
      ['req_json', 'TEXT'],         // 분석 완료된 요구사항 JSON (번들)
    ]) {
      if (!clCols9.includes(col)) db.exec(`ALTER TABLE cover_letters ADD COLUMN ${col} ${ddl}`);
    }
  }

  // 스키마 실행 (CREATE TABLE IF NOT EXISTS — 이미 있는 테이블은 그대로)
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  db.exec(sql);

  // Step 8: 만료된 세션 정리 (로그인 세션 테이블 비대화 방지)
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString());
  return db;
}

function getDb() {
  if (!db) init();
  return db;
}

// 공고 헤더 upsert (구인순번이 PK → 같은 공고 재수집 시 갱신)
const UPSERT_POSTING = `
  INSERT INTO job_postings (
    emp_seqno, title, company_name, company_type, employment_type,
    start_dt, end_dt, job_category, job_category_code, jobs_json,
    source_url, mobile_url, homepage, logo_url,
    recruit_summary, submit_doc, receipt_method, result_date, inquiry, etc_cont, common_cont,
    selfintro_json, selection_json, attach_files_json, collected_at
  ) VALUES (
    @emp_seqno, @title, @company_name, @company_type, @employment_type,
    @start_dt, @end_dt, @job_category, @job_category_code, @jobs_json,
    @source_url, @mobile_url, @homepage, @logo_url,
    @recruit_summary, @submit_doc, @receipt_method, @result_date, @inquiry, @etc_cont, @common_cont,
    @selfintro_json, @selection_json, @attach_files_json, @collected_at
  )
  ON CONFLICT(emp_seqno) DO UPDATE SET
    title=excluded.title, company_name=excluded.company_name, company_type=excluded.company_type,
    employment_type=excluded.employment_type, start_dt=excluded.start_dt, end_dt=excluded.end_dt,
    job_category=excluded.job_category, job_category_code=excluded.job_category_code, jobs_json=excluded.jobs_json,
    source_url=excluded.source_url, mobile_url=excluded.mobile_url, homepage=excluded.homepage, logo_url=excluded.logo_url,
    recruit_summary=excluded.recruit_summary, submit_doc=excluded.submit_doc, receipt_method=excluded.receipt_method,
    result_date=excluded.result_date, inquiry=excluded.inquiry, etc_cont=excluded.etc_cont, common_cont=excluded.common_cont,
    selfintro_json=excluded.selfintro_json, selection_json=excluded.selection_json, attach_files_json=excluded.attach_files_json,
    collected_at=excluded.collected_at
`;

const INSERT_RECRUIT = `
  INSERT INTO job_recruits (
    emp_seqno, recruit_name, job_desc, work_region, career, education,
    cert_etc, head_count, selection, memo
  ) VALUES (
    @emp_seqno, @recruit_name, @job_desc, @work_region, @career, @education,
    @cert_etc, @head_count, @selection, @memo
  )
`;

/**
 * 공고 1건 upsert (헤더 + 모집직무 N행)
 * - 트랜잭션으로 묶어 원자성 보장
 * - 갱신 시 기존 모집직무 행을 지우고 다시 넣는다 (1:N 이라 부분갱신이 어려움)
 * @param {object} posting - mapDetail() 결과 (recruits[] 포함)
 */
function upsertPosting(posting) {
  const d = getDb();
  const tx = d.transaction(() => {
    d.prepare(UPSERT_POSTING).run(posting);
    d.prepare(`DELETE FROM job_recruits WHERE emp_seqno = ?`).run(posting.emp_seqno);
    const ins = d.prepare(INSERT_RECRUIT);
    for (const r of (posting.recruits || [])) {
      ins.run({ ...r, emp_seqno: posting.emp_seqno });
    }
  });
  tx();
}

/**
 * 수집 이력 기록
 * @param {object} o { mode, fetchedCount, status, message }
 */
function logCollection({ mode, fetchedCount = 0, status, message = '' }) {
  const d = getDb();
  d.prepare(`INSERT INTO collection_logs (run_at, mode, fetched_count, status, message)
             VALUES (?, ?, ?, ?, ?)`)
    .run(new Date().toISOString(), mode, fetchedCount, status, message);
}

// --- 조회 헬퍼 (테스트/Step3 API용) ---
function countPostings() {
  return getDb().prepare(`SELECT COUNT(*) c FROM job_postings`).get().c;
}
function countRecruits() {
  return getDb().prepare(`SELECT COUNT(*) c FROM job_recruits`).get().c;
}
function recentLogs(limit = 10) {
  return getDb().prepare(`SELECT * FROM collection_logs ORDER BY id DESC LIMIT ?`).all(limit);
}

/**
 * 수집 시점 집계 스냅샷 저장 (인사이트 흐름 비교용)
 * - 현재 job_postings 의 직종별 카운트를 JSON으로 묶어 한 행 저장
 * @param {object} o { total, categoryCounts, recruitCounts }
 *   categoryCounts: [{ name, c }, ...]  공고 단위 (job_postings.job_category 기준)
 *   recruitCounts : [{ name, c }, ...]  모집직무 단위 (job_recruits 의 직종 기준) — G파트 단위 통일
 */
function saveSnapshot({ total, categoryCounts, recruitCounts }) {
  const d = getDb();
  const map = {};
  for (const { name, c } of (categoryCounts || [])) map[name] = c;
  const recruitMap = {};
  for (const { name, c } of (recruitCounts || [])) recruitMap[name] = c;
  d.prepare(`INSERT INTO collection_snapshots (run_at, total, category_counts, recruit_counts)
             VALUES (?, ?, ?, ?)`)
    .run(new Date().toISOString(), total, JSON.stringify(map), JSON.stringify(recruitMap));
}

/**
 * 최근 스냅샷 N개 (오래된 → 최신순; 타임라인/라인차트용)
 */
function recentSnapshots(limit = 30) {
  return getDb().prepare(
    `SELECT id, run_at, total, category_counts, recruit_counts FROM collection_snapshots
     ORDER BY id DESC LIMIT ?`
  ).all(limit).reverse();
}

/* ============================================================
   Step 8: 회원/세션 — users / sessions
   ============================================================ */

// ---------- users ----------
// 회원 생성. password_hash 는 auth.js 의 hashPassword() 결과물만 받는다 (평문 금지).
function createUser({ name, userId, passwordHash }) {
  const r = getDb().prepare(
    `INSERT INTO users (name, user_id, password_hash, created_at) VALUES (?, ?, ?, ?)`
  ).run(name, userId, passwordHash, nowISO());
  return getUserById(r.lastInsertRowid);
}

function getUserByLoginId(userId) {
  return getDb().prepare(
    `SELECT id, name, user_id, password_hash, created_at FROM users WHERE user_id = ?`
  ).get(userId);
}

function getUserById(id) {
  return getDb().prepare(`SELECT id, name, user_id, created_at FROM users WHERE id = ?`).get(id);
}

// ---------- sessions ----------
// 세션 저장. tokenHash = 세션 토큰(쿠키값)의 SHA-256 hex (auth.js 가 계산해 전달)
function createSession({ tokenHash, userId, expiresAt }) {
  getDb().prepare(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`
  ).run(tokenHash, userId, nowISO(), expiresAt);
}

// 세션 조회 — user 정보를 JOIN 해 한 번에 반환 (만료 세션은 NULL)
function getSessionUser(tokenHash) {
  return getDb().prepare(
    `SELECT u.id, u.name, u.user_id, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at >= ?`
  ).get(tokenHash, new Date().toISOString());
}

function deleteSession(tokenHash) {
  return getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash).changes;
}

// 세션 만료 시간 갱신 (Heartbeat용) — 아직 만료되지 않은 세션만 연장.
// WHERE 의 현재시각 조건이 "만료된 세션의 부활"을 원자적으로 차단한다
// (브라우저를 안 닫은 채 5분 방치 후 복귀한 탭이 만료 세션을 되살리는 것 방지).
// @returns {boolean} 실제 갱신되었는지 (만료/없는 세션이면 false)
function updateSessionExpiration(tokenHash, newExpiresAt) {
  return getDb().prepare(
    `UPDATE sessions SET expires_at = ? WHERE token_hash = ? AND expires_at >= ?`
  ).run(newExpiresAt, tokenHash, new Date().toISOString()).changes > 0;
}



/* ============================================================
   Step 7: 이력서 관리 — profiles / cover_letters / generation_logs
   Step 8: 모든 함수가 ownerId(로그인 사용자 id) 스코프로 동작 → 개인정보 격리
   ============================================================ */

// 현재 ISO 타임스탬프 (생성/수정 시각용)
const nowISO = () => new Date().toISOString();

// ---------- profiles (다중 프로필) ----------
// ownerId 스코프: 해당 사용자의 프로필만 반환
function listProfiles(ownerId) {
  return getDb().prepare(
    `SELECT p.*,
       (SELECT COUNT(*) FROM cover_letters c WHERE c.profile_id = p.id) AS letter_count
     FROM profiles p WHERE p.user_id = ? ORDER BY p.updated_at DESC`
  ).all(ownerId);
}

// 소유자 일치 조회 — 다른 사용자 프로필은 null (404 처리)
function getProfile(id, ownerId) {
  return getDb().prepare('SELECT * FROM profiles WHERE id = ? AND user_id = ?')
    .get(id, ownerId);
}

function createProfile(ownerId, { name, experience, skills, portfolio, emphasis }) {
  const ts = nowISO();
  const r = getDb().prepare(
    `INSERT INTO profiles (user_id, name, experience, skills, portfolio, emphasis, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(ownerId, name, experience || '', skills || '', portfolio || '', emphasis || null, ts, ts);
  return getProfile(r.lastInsertRowid, ownerId);
}

function updateProfile(id, ownerId, { name, experience, skills, portfolio, emphasis }) {
  const cur = getProfile(id, ownerId);
  if (!cur) return null;
  getDb().prepare(
    `UPDATE profiles SET name = ?, experience = ?, skills = ?, portfolio = ?, emphasis = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).run(
    name !== undefined ? name : cur.name,
    experience !== undefined ? experience : cur.experience,
    skills !== undefined ? skills : cur.skills,
    portfolio !== undefined ? portfolio : cur.portfolio,
    emphasis !== undefined ? emphasis : cur.emphasis,
    nowISO(), id, ownerId
  );
  return getProfile(id, ownerId);
}

function deleteProfile(id, ownerId) {
  // cover_letters / generation_logs 는 ON DELETE CASCADE 로 자동 삭제
  return getDb().prepare('DELETE FROM profiles WHERE id = ? AND user_id = ?')
    .run(id, ownerId).changes;
}

// ---------- cover_letters (자소서, 프로필 1:N) ----------
// 프로필 경유 소유 검증: 해당 사용자 소유 프로필의 자소서만 반환
function listCoverLetters(profileId, ownerId) {
  if (!profileId) return [];
  return getDb().prepare(
    `SELECT c.* FROM cover_letters c
       JOIN profiles p ON p.id = c.profile_id
      WHERE c.profile_id = ? AND p.user_id = ?
      ORDER BY c.updated_at DESC`
  ).all(profileId, ownerId);
}

function getCoverLetter(id, ownerId) {
  return getDb().prepare(
    `SELECT c.* FROM cover_letters c
       JOIN profiles p ON p.id = c.profile_id
      WHERE c.id = ? AND p.user_id = ?`
  ).get(id, ownerId);
}

function createCoverLetter(ownerId, { profile_id, title, target_job, company }) {
  // 소유한 프로필에만 생성 허용 (타인 프로필 id 지정 → null → 라우터에서 404)
  if (!getProfile(profile_id, ownerId)) return null;
  const ts = nowISO();
  const r = getDb().prepare(
    `INSERT INTO cover_letters (profile_id, title, target_job, company, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(profile_id, title || '제목 없음', target_job || '', company || '', ts, ts);
  return getCoverLetter(r.lastInsertRowid, ownerId);
}

function updateCoverLetter(id, ownerId, fields) {
  const cur = getCoverLetter(id, ownerId);
  if (!cur) return null;
  const allowed = ['title', 'target_job', 'company', 'motivation', 'growth', 'strength', 'career', 'vision',
                   'req_source', 'req_posting_id', 'req_url', 'req_text', 'req_json'];
  const sets = [];
  const params = [];
  for (const k of allowed) {
    if (fields[k] !== undefined) { sets.push(`${k} = ?`); params.push(fields[k]); }
  }
  if (!sets.length) return cur;
  sets.push('updated_at = ?'); params.push(nowISO()); params.push(id);
  getDb().prepare(
    `UPDATE cover_letters SET ${sets.join(', ')}
      WHERE id = ? AND profile_id IN (SELECT id FROM profiles WHERE user_id = ?)`
  ).run(...params, ownerId);
  return getCoverLetter(id, ownerId);
}

function deleteCoverLetter(id, ownerId) {
  return getDb().prepare(
    `DELETE FROM cover_letters WHERE id = ? AND profile_id IN (SELECT id FROM profiles WHERE user_id = ?)`
  ).run(id, ownerId).changes;
}

/* ============================================================
   Step 9: 채용공고 요구사항 매칭 — 회사 검색 + 요구사항 번들
   ============================================================ */

// 워크넷 원문의 HTML 엔티티/태그 잔여 정리 (&#xd; 줄바꿈, &amp; 등 → 일반 텍스트)
function cleanRecruitText(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/&#x0*[0-9a-f]+;/gi, '\n')      // &#xd; 등 → 줄바꿈
    .replace(/&#x?[0-9a-f]+;/gi, ' ')         // 그 외 엔티티 → 공백
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 빈 줄/불릿 정리 후 항목 배열로 분해
function toLines(raw) {
  const t = cleanRecruitText(raw);
  if (!t) return [];
  return t.split(/\n+/)
    .map((l) => l.replace(/^[\s\-*·•]+/, '').trim())
    .filter((l) => l.length > 1);
}

/**
 * 회사명으로 DB 공고 검색 (Step 9 1차 소스)
 * @param {string} q 검색어 (회사명 일부)
 * @returns {Array} [{emp_seqno, title, company_name, job_category, end_dt, employment_type}]
 */
function searchPostingsByCompany(q) {
  const like = '%' + String(q || '').replace(/[%_\\]/g, (c) => '\\' + c) + '%';
  return getDb().prepare(
    `SELECT emp_seqno, title, company_name, job_category, employment_type, start_dt, end_dt
       FROM job_postings
      WHERE company_name LIKE ? ESCAPE '\\'
      ORDER BY end_dt DESC LIMIT 30`
  ).all(like);
}

/**
 * 공고 → 요구사항 번들 (Step 9 — 모든 소스가 이 형태로 수렴)
 * DB 컬럼에서 주요업무/자격/우대/기타를 추출. 모집직무가 여러 개면 전부 합산.
 * @returns {object|null} {company, position, duties[], required[], preferred[], notes[], meta}
 */
function getPostingRequirements(empSeqno) {
  const p = getDb().prepare(
    `SELECT emp_seqno, title, company_name, job_category, employment_type, start_dt, end_dt
       FROM job_postings WHERE emp_seqno = ?`
  ).get(empSeqno);
  if (!p) return null;

  const recruits = getDb().prepare(
    `SELECT recruit_name, job_desc, work_region, career, education, cert_etc
       FROM job_recruits WHERE emp_seqno = ?`
  ).all(empSeqno);

  const duties = [];
  const required = [];
  const preferred = [];
  const notes = [];

  for (const r of recruits) {
    // 주요 업무
    for (const line of toLines(r.job_desc)) duties.push(line);
    // 자격: 경력/학력은 개별 항목으로
    if (r.career && r.career.trim()) required.push(`경력: ${r.career.trim()}`);
    if (r.education && r.education.trim()) required.push(`학력: ${r.education.trim()}`);
    // cert_etc: "우대" 문맥 행은 preferred, 나머지는 required
    for (const line of toLines(r.cert_etc)) {
      (/(우대|우수|가점)/.test(line) ? preferred : required).push(line);
    }
    if (r.work_region && r.work_region.trim()) notes.push(`근무지역: ${r.work_region.trim()}`);
  }
  if (p.employment_type && p.employment_type.trim()) notes.push(`고용형태: ${p.employment_type.trim()}`);

  const dedupe = (arr) => [...new Set(arr)];
  return {
    company: p.company_name || '',
    position: recruits.length === 1 && recruits[0].recruit_name
      ? recruits[0].recruit_name
      : (p.title || ''),
    duties: dedupe(duties).slice(0, 15),
    required: dedupe(required).slice(0, 15),
    preferred: dedupe(preferred).slice(0, 10),
    notes: dedupe(notes).slice(0, 8),
    meta: {
      source: 'db', emp_seqno: p.emp_seqno,
      recruit_count: recruits.length,
      period: [p.start_dt, p.end_dt].filter(Boolean).join(' ~ '),
    },
  };
}

// ---------- generation_logs (AI 생성 이력) ----------
function logGeneration({ cover_letter_id, action, model, target_job, status, error, tokens }) {
  return getDb().prepare(
    `INSERT INTO generation_logs (cover_letter_id, action, model, target_job, status, error, tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(cover_letter_id, action || 'generate', model || '', target_job || '',
    status || 'success', error || '', tokens || 0, nowISO()).lastInsertRowid;
}

module.exports = {
  init, getDb,
  upsertPosting, logCollection,
  saveSnapshot, recentSnapshots,
  countPostings, countRecruits, recentLogs,
  DB_PATH,
  // Step 8: 회원/세션
  createUser, getUserByLoginId, getUserById,
  createSession, getSessionUser, deleteSession,
  updateSessionExpiration,
  // Step 7: 이력서 관리 (Step 8부터 ownerId 스코프)
  listProfiles, getProfile, createProfile, updateProfile, deleteProfile,
  listCoverLetters, getCoverLetter, createCoverLetter, updateCoverLetter, deleteCoverLetter,
  logGeneration,
  // Step 9: 채용공고 요구사항 매칭
  cleanRecruitText, searchPostingsByCompany, getPostingRequirements,
};
