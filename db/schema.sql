-- JobMarketRadar DB 스키마
-- API: 한국고용정보원_국민취업지원제도_채용정보 (dhsOpenEmpInfoDetailRoot)
-- 필드 매핑 상세: docs/api-field-mapping.md
-- 작성일: 2026-07-07

-- ============================================================
-- 1. 채용공고 헤더 (1건 = 1공고)
-- ============================================================
CREATE TABLE IF NOT EXISTS job_postings (
  emp_seqno          TEXT PRIMARY KEY,        -- empSeqno: 공개채용공고순번 (고유키)
  title              TEXT,                    -- empWantedTitle: 채용제목
  company_name       TEXT,                    -- empBusiNm: 채용업체명
  company_type       TEXT,                    -- coClcdNm: 기업구분명 (대기업/중소/공공 등)
  employment_type    TEXT,                    -- empWantedTypeNm: 고용형태
  start_dt           TEXT,                    -- empWantedStdt: 채용시작일자 (YYYYMMDD)
  end_dt             TEXT,                    -- empWantedEndt: 채용종료일자 (YYYYMMDD)

  job_category       TEXT,                    -- empJobsList 첫값 직종명 (집계용)
  job_category_code  TEXT,                    -- empJobsList 첫값 직종코드 (집계용)
  jobs_json          TEXT,                    -- empJobsList 전체 (JSON 배열)

  source_url         TEXT,                    -- empWantedHomepgDetail: 채용사이트 URL ★
  mobile_url         TEXT,                    -- empWantedMobileUrl: 모바일 채용 URL
  homepage           TEXT,                    -- empWantedHomepg: 기업 홈페이지
  logo_url           TEXT,                    -- regLogImgNm: 기업 로고

  recruit_summary    TEXT,                    -- empnRecrSummaryCont: 모집부분 전체요약
  submit_doc         TEXT,                    -- empSubmitDocCont: 제출서류
  receipt_method     TEXT,                    -- empRcptMthdCont: 접수방법
  result_date        TEXT,                    -- empAcptPsnAnncCont: 합격자발표일
  inquiry            TEXT,                    -- inqryCont: 문의사항
  etc_cont           TEXT,                    -- empnEtcCont: 기타사항
  common_cont        TEXT,                    -- recrCommCont: 공통사항

  selfintro_json     TEXT,                    -- empSelsList 자소서질문 (JSON 배열)
  selection_json     TEXT,                    -- empSelsList 전형단계 (JSON 배열)
  attach_files_json  TEXT,                    -- regFileList 첨부파일 (JSON 배열)

  collected_at       TEXT NOT NULL            -- 수집 시각 (ISO)
);

-- 목록/추이 집계용 인덱스
CREATE INDEX IF NOT EXISTS idx_postings_job_category ON job_postings(job_category);
CREATE INDEX IF NOT EXISTS idx_postings_collected   ON job_postings(collected_at);
CREATE INDEX IF NOT EXISTS idx_postings_end_dt      ON job_postings(end_dt);

-- ============================================================
-- 2. 모집직무 (1공고 : N직무) — 지역/경력/학력 집계의 주체
-- ============================================================
CREATE TABLE IF NOT EXISTS job_recruits (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  emp_seqno     TEXT NOT NULL,                -- FK -> job_postings.emp_seqno
  recruit_name  TEXT,                         -- empRecrNm: 채용모집명
  job_desc      TEXT,                         -- jobCont: 직무설명
  work_region   TEXT,                         -- workRegionNm: 근무지 ★
  career        TEXT,                         -- empWantedCareerNm: 경력 ★
  education     TEXT,                         -- empWantedEduNm: 학력 ★
  cert_etc      TEXT,                         -- sptCertEtc: 자격기타
  head_count    INTEGER,                      -- recrPsncnt: 모집인원수
  selection     TEXT,                         -- selsCont: 전형단계내용
  memo          TEXT,                         -- empRecrMemoCont: 비고
  FOREIGN KEY (emp_seqno) REFERENCES job_postings(emp_seqno) ON DELETE CASCADE
);

-- 집계용 인덱스
CREATE INDEX IF NOT EXISTS idx_recruits_emp_seqno  ON job_recruits(emp_seqno);
CREATE INDEX IF NOT EXISTS idx_recruits_region     ON job_recruits(work_region);
CREATE INDEX IF NOT EXISTS idx_recruits_career     ON job_recruits(career);
CREATE INDEX IF NOT EXISTS idx_recruits_education  ON job_recruits(education);

-- ============================================================
-- 3. 집계 스냅샷 (수집 시점별 직종 집계 — 인사이트 흐름 비교용)
--    매 수집 종료 시 직종별 카운트를 JSON으로 한 행 저장.
--    누적 DB(마감 공고 삭제 안 됨)의 한계를 넘어
--    "과거 vs 현재" 트렌드 비교를 가능케 함.
-- ============================================================
CREATE TABLE IF NOT EXISTS collection_snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at          TEXT NOT NULL,             -- 수집 시각 (ISO) — collection_logs.run_at 와 대응
  total           INTEGER NOT NULL,          -- 그 시점 전체 공고 수
  category_counts TEXT NOT NULL,             -- {"직종명": 카운트, ...} 공고 단위 (과거 호환/fallback)
  recruit_counts  TEXT NOT NULL DEFAULT '{}' -- {"직종명": 카운트, ...} 모집직무 단위 (G파트 단위 통일)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_run_at ON collection_snapshots(run_at);

-- ============================================================
-- 4. 수집 이력 (배치 실행 기록 — 운영/디버깅)
-- ============================================================
CREATE TABLE IF NOT EXISTS collection_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at        TEXT NOT NULL,                -- 실행 시각 (ISO)
  mode          TEXT,                         -- list / detail / backfill
  fetched_count INTEGER DEFAULT 0,            -- 수집 건수
  status        TEXT,                         -- success / fail
  message       TEXT                          -- 비고/에러메시지
);

-- ============================================================
-- 5. 이력서 관리 (Step 7) — 다중 프로필 + AI 자기소개서
-- ============================================================

-- 회원 계정 (Step 8) — 로그인 시스템. 이력서 개인정보 격리의 주체
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,                -- 이름 (표시용)
  user_id       TEXT NOT NULL UNIQUE,         -- 로그인 ID (영문/숫자/._-)
  password_hash TEXT NOT NULL,                -- "scrypt$N$r$p$salt$hash" 형식 (평문 저장 금지)
  created_at    TEXT NOT NULL                 -- 가입시각 (ISO)
);

-- 로그인 세션 (Step 8) — 발급 토큰의 SHA-256을 저장. 서버 재시작에도 로그인 유지
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,               -- 세션 토큰(쿠키값)의 SHA-256 hex
  user_id     INTEGER NOT NULL,               -- FK -> users.id
  created_at  TEXT NOT NULL,                  -- 발급시각 (ISO)
  expires_at  TEXT NOT NULL,                  -- 만료시각 (ISO, 5분 + 하트비트 슬라이딩 연장)
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- 사용자 프로필 (다중) — 직무별로 별도 프로필 관리 가능
--                    Step 8: 소유자(users.id) 지정 → 회원별 이력서 격리
CREATE TABLE IF NOT EXISTS profiles (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER,                      -- FK -> users.id (소유자. 레거시 행은 NULL)
  name          TEXT NOT NULL,                -- 프로필명 (예: "백엔드 지원용")
  experience    TEXT,                         -- 경력/경험 (자유 텍스트)
  skills        TEXT,                         -- 기술/스택 (예: "Java, Spring, MySQL")
  portfolio     TEXT,                         -- 포트폴리오 (링크/설명)
  emphasis      TEXT,                         -- 항목별 강조 포인트 JSON {"motivation":..,"growth":..,"strength":..,"career":..,"vision":..} (AI 작성 요구사항)
  created_at    TEXT NOT NULL,                -- 생성시각 (ISO)
  updated_at    TEXT NOT NULL                 -- 수정시각 (ISO)
  -- user_id FK은 ALTER 마이그레이션(db.js)으로 추가 — 기존 DB 호환
);
CREATE INDEX IF NOT EXISTS idx_profiles_user ON profiles(user_id);

-- 자기소개서 (프로필 1:N) — 표준 5항목. 소유자는 profile_id 경유 판정
CREATE TABLE IF NOT EXISTS cover_letters (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id    INTEGER NOT NULL,             -- FK -> profiles.id
  title         TEXT NOT NULL,                -- 자소서 제목
  target_job    TEXT,                         -- 타겟 직무 (워크넷 job_category)
  company       TEXT,                         -- 지원 회사명 (입력 시 그 회사 인재상 반영)
  motivation    TEXT,                         -- ① 지원동기
  growth        TEXT,                         -- ② 성장과정
  strength      TEXT,                         -- ③ 성격의 장단점
  career        TEXT,                         -- ④ 직무경험
  vision        TEXT,                         -- ⑤ 입사 후 포부
  -- Step 9: 채용공고 요구사항 번들 (자소서 생성의 근거 — 소스 무관 동일 형태)
  req_source    TEXT,                         -- 'db' | 'url' | 'paste' | 'company'
  req_posting_id TEXT,                        -- db 소스: job_postings.emp_seqno
  req_url       TEXT,                         -- url 소스: 시도한 공고 URL
  req_text      TEXT,                         -- url/paste 소스 원문
  req_json      TEXT,                         -- 분석 완료 요구사항 JSON
  created_at    TEXT NOT NULL,                -- 생성시각 (ISO)
  updated_at    TEXT NOT NULL,                -- 수정시각 (ISO)
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

-- AI 생성 이력 (디버깅/비용 추적)
CREATE TABLE IF NOT EXISTS generation_logs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  cover_letter_id INTEGER NOT NULL,           -- FK -> cover_letters.id
  action          TEXT,                       -- generate / regenerate
  model           TEXT,                       -- 사용 모델 (예: gemini-2.5-flash)
  target_job      TEXT,                       -- 생성 시 타겟 직무
  status          TEXT,                       -- success / fail
  error           TEXT,                       -- 실패 시 메시지
  tokens          INTEGER DEFAULT 0,          -- 사용 토큰 수
  created_at      TEXT NOT NULL,              -- 생성시각 (ISO)
  FOREIGN KEY (cover_letter_id) REFERENCES cover_letters(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cover_letters_profile ON cover_letters(profile_id);
CREATE INDEX IF NOT EXISTS idx_gen_logs_letter ON generation_logs(cover_letter_id);
