# Step 8: 로그인 시스템 설계 (계획서)

> 작성일: 2026-08-31
> 관련 문서: [step8-auth-worklog.md](./step8-auth-worklog.md) (수행 순서·진행 관리)
> 전체 인덱스: [README.md](./README.md)

---

## 1. 배경 · 문제 정의

현재 JobMarketRadar의 **이력서 관리(Step 7)** 기능은 인증 없이 누구나 접근 가능:

```
public/index.html (SPA) ── GET /api/profiles ──▶ 전체 프로필 목록
                     ── GET /api/profiles/:id ──▶ 경력·기술·포트폴리오·자소서 전문
```

- `GET /api/profiles` 가 **DB의 모든 사용자 프로필**을 반환 (server.js:508)
- 프로필에는 경력·기술 스택·포트폴리오 링크 등 **개인 식별 정보**가 포함
- 웹 페이지를 아는 다른 사용자가 내 이력서를 열람할 수 있음 → **개인정보 유출**

→ 이를 막기 위해 **회원가입/로그인 시스템**을 추가하고, 이력서 데이터를 **개별 회원 단위로 격리**한다.

---

## 2. 요구사항 (사용자 원문 기반 정리)

| # | 요구사항 | 구현 방향 |
|---|---|---|
| R1 | 다른 사용자가 내 이력서 개인정보를 볼 수 없어야 함 | 모든 이력서 API에 인증 + 소유권 검증 |
| R2 | 로그인 버튼은 **div.header-meta 아래**, **둥근 모양** | 헤더 우측 `header-meta` 하단에 pill 형태 버튼 배치 |
| R3 | 버튼 클릭 → **로그인 화면으로 전환** | 오버레이 형태 로그인 화면 (기존 대시보드 위에 표시) |
| R4 | **아이디 + 비밀번호** 입력 로그인 | `POST /api/auth/login` → 세션 쿠키 발급 |
| R5 | 로그인 성공 → **첫 메인 페이지(대시보드)로 이동** | 로그인 후 오버레이 닫고 `switchView('dashboard')` |
| R6 | 아이디 없을 시 **회원가입 버튼**으로 이동 | 로그인 화면 하단 "회원가입" 토글 버튼 |
| R7 | 회원가입 입력은 **이름 / ID / 비밀번호 3개만** | 3필드 폼 → `POST /api/auth/register` |
| R8 | 이력서를 **개별 회원 단위로 관리** | `profiles.user_id` 컬럼 추가, 모든 쿼리에 사용자 스코핑 |
| R9 | 이력서 페이지는 **로그인 없이 접근 불가** | 프론트: 탭 클릭 시 가드 / 서버: API 401 |

---

## 3. 설계 개요

### 3.1 인증 방식 선정

| 후보 | 선택 | 이유 |
|---|---|---|
| **쿠키 + 서버 세션 (SQLite 저장)** | ✅ 채택 | 의존성 0 (express-session 불필요), SQLite 이미 사용 중, 서버 재시작에도 로그인 유지, 구현 단순 |
| JWT (무상태 토큰) | ❌ | 로그아웃/만료 관리가 복잡, 이 프로젝트 규모에 과함 |
| OAuth (구글/카카오) | ❌ | 외부 키 발급 필요, 요구사항은 자체 ID/PW |

**비밀번호 저장**: Node 내장 `crypto.scrypt` + 랜덤 salt (bcrypt 네이티브 빌드 의존성 회피 — labport/raspberry pi 환경 안전)

```
저장 형식: scrypt$N$r$p$salt_hex$hash_hex   (단일 문자열 컬럼)
검증:      동일 파라미터로 재계산 → timingSafeEqual 비교
```

**세션 토큰**: `crypto.randomBytes(32)` → 64자 hex, SHA-256으로 해시해 DB 저장 (유출 시 대응 가능)
**쿠키**: `HttpOnly` + `SameSite=Lax` (+ 배포 HTTPS 환경에서 `Secure`) — JS에서 토큰 접근 불가 → XSS 방어

### 3.2 DB 스키마 변경

```sql
-- 신설: 회원
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,             -- 이름 (표시용)
  user_id       TEXT NOT NULL UNIQUE,      -- 로그인 ID
  password_hash TEXT NOT NULL,             -- scrypt$salt$hash
  created_at    TEXT NOT NULL
);

-- 신설: 세션 (로그인 유지)
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,             -- 세션 토큰의 SHA-256
  user_id    INTEGER NOT NULL,             -- FK -> users.id
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,                -- 발급 후 7일
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 변경: profiles 에 소유자 컬럼 추가 (마이그레이션)
ALTER TABLE profiles ADD COLUMN user_id INTEGER REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_profiles_user ON profiles(user_id);
```

- 기존 `profiles` 행에는 `user_id = NULL` (현재 DB에 프로필 0건이므로 실질 영향 없음)
- `cover_letters`는 `profile_id` 경유로 자동 소유 판정 (별도 컬럼 불필요)

### 3.3 API 설계

| 메서드·경로 | 인증 | 설명 |
|---|---|---|
| `POST /api/auth/register` | ✕ | 회원가입 (name, user_id, password). 중복 ID → 409 |
| `POST /api/auth/login` | ✕ | 로그인 → `Set-Cookie: jmr_session` |
| `POST /api/auth/logout` | ✓ | 세션 삭제 + 쿠키 만료 |
| `GET /api/auth/me` | ✓ | 현재 로그인 사용자 정보 (페이지 새로고침 시 상태 복원용) |
| `/api/profiles*`, `/api/cover-letters*` | **✓** | **requireAuth 미들웨어** — 미로그인 401 |
| `/api/target-jobs` | ✓ | 이력서 페이지 전용 데이터 |
| 대시보드/인사이트/맞춤공고 API | ✕ | 공공 채용 통계는 로그인 없이 그대로 이용 (요구사항 R9는 이력서 페이지만 차단) |

**소유권 검증 (중요)**: 로그인만 하면 다른 사람 프로필을 ID로 열람하는 것도 차단 —
모든 profile/cover-letter 조회·수정·삭제 쿼리에 `AND user_id = ?` 조건 부여.

### 3.4 프론트 설계

**화면 구조 (index.html)**:

```
<div class="app">
  <header class="app-header">
    <div class="brand">…</div>
    <div class="header-meta">수집상태…</div>
    <div class="header-auth">          ★ 신설 (header-meta 아래)
      <button id="btn-login" class="auth-btn">🔑 로그인</button>   ← 둥근 버튼
      <!-- 로그인 후: 사용자명 + 로그아웃 버튼으로 교체 -->
    </div>
  </header>
  <nav class="nav-bar">…</nav>
  <main data-view="dashboard">…</main>
  …
</div>

<!-- 로그인/회원가입 오버레이 (전체 화면) -->
<div id="auth-overlay" class="auth-overlay hidden">
  … 로그인 폼 (ID/PW) ⇄ 회원가입 폼 (이름/ID/PW) 토글 …
</div>
```

**동작 흐름**:
1. 페이지 로드 → `GET /api/auth/me`로 로그인 상태 복원
2. 로그인 버튼 클릭 → 오버레이 표시 (로그인 폼)
3. 로그인 성공 → 오버레이 닫힘 → 헤더가 "사용자명 · 로그아웃"으로 변경 → **대시보드(첫 메인)로 전환**
4. "회원가입" 버튼 → 폼이 이름/ID/PW 3필드로 전환 → 가입 성공 시 자동 로그인
5. **이력서 관리 탭 클릭 시 미로그인** → 로그인 오버레이 자동 표시 + "로그인이 필요합니다" 안내
6. 로그아웃 → 헤더 원복, 이력서 탭 접근 시 다시 로그인 유도

---

## 4. 보안 정책

| 항목 | 정책 |
|---|---|
| 비밀번호 해싱 | scrypt (N=16384, r=8, p=1, keylen=64) + per-user salt |
| 비밀번호 최소 길이 | 6자 (포트폴리오 규모에 맞춤, 과도한 제약 지양) |
| ID 규칙 | 3~30자, 영문/숫자/._- 허용, 대소문자 구분 (trim 적용) |
| 세션 만료 | 7일 (기본), 만료 시 자동 삭제 |
| 쿠키 | `HttpOnly; SameSite=Lax; Path=/` (+HTTPS 배포 시 `Secure`) |
| 로그인 실패 응답 | "아이디 또는 비밀번호가 올바르지 않습니다" — 존재하지 않는 ID인지 PW 틀린 것인지 구분하지 않음 (사용자 열거 방지) |
| 회원가입 중복 | ID UNIQUE 제약 → 409 "이미 사용 중인 아이디입니다" |
| SQL 인젝션 | 기존과 동일하게 파라미터 바인딩만 사용 |
| XSS | 기존 escapeHTML 유지 + 인증 응답의 사용자명 표시 시 escape |
| 개인정보 격리 | 소유자 불일치 시 404 (존재 자체를 숨김 — 403보다 정보 노출 적음) |

---

## 5. 변경 파일 목록 (예상)

| 파일 | 변경 내용 |
|---|---|
| `db/schema.sql` | users, sessions 테이블 + 인덱스 추가 |
| `db.js` | 마이그레이션(profiles.user_id), 사용자/세션 CRUD, 프로필·자소서 쿼리에 user 스코핑 |
| `auth.js` **신규** | 해싱/검증, 세션 발급/조회/삭제, 쿠키 헬퍼, requireAuth 미들웨어 |
| `server.js` | /api/auth/* 라우트 추가, 이력서 API에 requireAuth + 소유권 검증 |
| `public/index.html` | header-auth 영역, 로그인/회원가입 오버레이 |
| `public/app.js` | 인증 상태 관리, 로그인/가입/로그아웃 흐름, 이력서 탭 가드 |
| `public/style.css` | 둥근 로그인 버튼, 오버레이, 폼 스타일 |
| `docs/README.md` | Step 8 인덱스 추가 |

**의존성 추가 없음** (Node 내장 crypto만 사용) — package.json 변경 없음.

---

## 6. 완료 기준 (검수 체크리스트)

> ✅ 2026-08-31 구현 완료 — `scripts/verify-step8-auth.js` 자동 검증 33/33 통과.
> 브라우저 동작 항목(탭 가드·새로고침 유지)은 구현 및 수동 확인 완료.

- [x] 회원가입: 이름/ID/PW 3필드만으로 가입 성공
- [x] 중복 ID 회원가입 → 409 거부
- [x] 로그인 성공 → 쿠키 발급 → 첫 메인(대시보드) 이동
- [x] 로그인 실패(틀린 PW / 없는 ID) → 동일 메시지로 거부
- [x] 미로그인 상태에서 `/api/profiles` → 401
- [x] 미로그인 상태에서 이력서 관리 탭 클릭 → 로그인 화면 표시 (콘텐츠 미노출)
- [x] 사용자 A의 프로필/자소서를 사용자 B가 ID 직접 지정 조회 → 404 (격리 확인)
- [x] 사용자 A/B 각각 자신의 프로필만 목록에 보임
- [x] 로그아웃 → 세션 무효, 이력서 탭 재차단
- [x] 페이지 새로고침 후에도 로그인 상태 유지 (세션 쿠키)
- [x] 대시보드/인사이트/맞춤공고는 로그인 없이 정상 동작 (기능 회귀 없음)
- [x] 서버 재시작 후에도 로그인 유지 (세션이 SQLite에 저장)
