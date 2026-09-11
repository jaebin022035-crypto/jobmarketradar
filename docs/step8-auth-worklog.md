# Step 8: 로그인 시스템 수행 순서 · 워크로그

> 작성일: 2026-08-31 · 설계: [step8-auth-plan.md](./step8-auth-plan.md)
> 이 문서는 **수행 순서(체크리스트)** 와 **진행 기록** 을 함께 관리한다.

---

## 1. 수행 순서 (이 순서대로 진행)

| 단계 | 작업 | 파일 | 선행 | 상태 |
|---|---|---|---|---|
| **8-1** | DB 스키마: `users`·`sessions` 테이블 추가, `profiles.user_id` 마이그레이션 | `db/schema.sql`, `db.js` | — | ✅ |
| **8-2** | `auth.js` 신규: scrypt 해싱·세션 발급/검증·requireAuth 미들웨어 | `auth.js` | 8-1 | ✅ |
| **8-3** | 서버: 인증 API (register/login/logout/me) + 이력서 API 보호·소유권 검증 | `server.js` | 8-2 | ✅ |
| **8-4** | 프론트 HTML: header-meta 하단 둥근 로그인 버튼 + 로그인/회원가입 오버레이 | `public/index.html` | — | ✅ |
| **8-5** | 프론트 로직: 인증 상태 관리, 로그인→대시보드 이동, 이력서 탭 가드 | `public/app.js` | 8-3, 8-4 | ✅ |
| **8-6** | 프론트 스타일: 둥근 버튼·오버레이·폼 | `public/style.css` | 8-4 | ✅ |
| **8-7** | 통합 검증: 계정 2개로 개인정보 격리·차단 시나리오 테스트 | 검증 스크립트 | 8-1~8-6 | ✅ |
| **8-8** | 문서 인덱스 갱신 (docs/README.md) + 워크로그 완료 기록 | `docs/README.md` | 8-7 | ✅ |

### 순서를 바꾸면 안 되는 이유
- **DB(8-1)가 먼저**: auth.js의 세션 저장이 테이블을 필요로 함
- **auth.js(8-2)가 server.js(8-3)보다 먼저**: 라우트가 해싱/세션 함수를 호출
- **서버(8-3)가 프론트 로직(8-5)보다 먼저**: 프론트가 /api/auth/* 를 호출
- **검증(8-7)은 전부 끝난 뒤**: 부분 구현 상태로 테스트하면 오탐 생김

---

## 2. 진행 기록

### 2026-08-31

- **사전 조사**
  - 기존 이력서 API 무방비 확인: `GET /api/profiles` 가 전체 프로필 반환 (server.js:508)
  - DB 현황: profiles 0건, cover_letters 0건 → 마이그레이션 안전 (기존 데이터 소실 없음)
  - 인증 의존성 없음 (bcrypt/express-session/jwt 모두 미설치) → Node 내장 crypto(scrypt)로 구현하기로 결정 (의존성 추가 0)
  - 프론트 구조 확인: SPA 4뷰 + 라우터(switchView), 헤더는 `.app-header > .header-meta` 구조
- **설계 문서 작성**: `step8-auth-plan.md` (요구사항 9개 → 설계·보안정책·완료기준)

<!-- 진행 상황은 아래에 단계별로 추가 -->

---

## 3. 단계별 상세 작업 내용

### 8-1. DB 스키마 (db/schema.sql · db.js)
- [ ] users 테이블 (id, name, user_id UNIQUE, password_hash, created_at)
- [ ] sessions 테이블 (token_hash PK, user_id FK, created_at, expires_at)
- [ ] init() 마이그레이션: profiles.user_id 컬럼 + 인덱스 (기존 DB 호환)
- [ ] db.js: createUser/getUserByUserId, 세션 CRUD, 프로필·자소서 함수에 userId 스코핑

### 8-2. auth.js (신규)
- [ ] hashPassword / verifyPassword (scrypt + timingSafeEqual)
- [ ] createSession / getUserFromRequest (쿠키 파싱 → 세션 조회 → 만료 검사)
- [ ] deleteSession / deleteExpiredSessions
- [ ] SESSION_COOKIE 상수, 쿠키 옵션 빌더

### 8-3. server.js
- [ ] POST /api/auth/register — 3필드 검증 + 중복 409
- [ ] POST /api/auth/login — 세션 발급 + Set-Cookie
- [ ] POST /api/auth/logout — 세션 삭제 + 쿠키 만료
- [ ] GET /api/auth/me — 로그인 사용자 반환
- [ ] requireAuth 미들웨어를 profiles/cover-letters/target-jobs 라우트에 적용
- [ ] 모든 이력서 핸들러에서 소유권 검증 (user_id 일치 확인 → 아니면 404)

### 8-4. public/index.html
- [ ] `.header-meta` 아래 `.header-auth` + 둥근 로그인 버튼 (`#btn-login`)
- [ ] `#auth-overlay` 로그인/회원가입 전체 화면 오버레이 (폼 2개 토글)

### 8-5. public/app.js
- [ ] authState (user, overlay mode) 관리
- [ ] 페이지 로드 시 GET /api/auth/me 상태 복원
- [ ] 로그인 성공 → 오버레이 닫음 + 헤더 갱신 + switchView('dashboard')
- [ ] 회원가입 토글·제출 (성공 시 자동 로그인)
- [ ] 이력서 탭 가드: 미로그인 클릭 → 로그인 필요 안내 + 오버레이
- [ ] 로그아웃 → 상태 초기화 + 대시보드 복귀

### 8-6. public/style.css
- [ ] .auth-btn 둥근(pill) 버튼 — 기존 디자인 톤(accent gradient)과 통일
- [ ] .auth-overlay 전체 화면 오버레이 + 중앙 카드
- [ ] 로그인/회원가입 폼 스타일 (기존 .input/.btn 재활용)

### 8-7. 통합 검증
- [ ] 시나리오 스크립트로 계정 2개 생성 → 격리/차단 자동 확인 (계획서 6절 체크리스트 전항)

### 8-8. 문서 갱신
- [x] docs/README.md 진행 테이블에 Step 8 행 추가
- [x] 본 워크로그 상태 테이블 전부 ✅ 처리 + 결과 요약 기록

---

## 4. 구현 결과 요약 (2026-08-31 완료)

### 변경 파일
| 파일 | 내용 |
|---|---|
| `db/schema.sql` | `users`·`sessions` 테이블 + `idx_sessions_user`·`idx_profiles_user` 인덱스, `profiles.user_id` 컬럼 |
| `db.js` | 마이그레이션 순서 조정(ALTER를 schema.sql 실행 **전**으로 — 신규 인덱스가 user_id 컬럼을 참조하기 때문), users/sessions CRUD, profiles·cover_letters 전 함수에 ownerId 스코핑, 만료 세션 자동 정리 |
| `auth.js` **신규** | scrypt 해싱(`scrypt$N$r$p$salt$hash` 형식)·timingSafeEqual 검증, 세션 토큰 발급(쿠키값)·SHA-256 저장, 쿠키 헬퍼, `requireAuth` 미들웨어 |
| `server.js` | `POST /api/auth/{register,login,logout}` · `GET /api/auth/me`, 이력서 API 12개 라우트에 requireAuth + 소유권 스코핑 |
| `public/index.html` | `.header-auth`(header-meta 아래) 둥근 로그인 버튼 + 로그인/회원가입 오버레이(폼 2개 토글) |
| `public/app.js` | authState 관리, 세션 복원(restoreAuth), 로그인→대시보드 이동, 이력서 탭 가드, 로그아웃 시 이력서 뷰 잔존 방지 |
| `public/style.css` | pill형 로그인 버튼(기존 accent 그라디언트 톤), 오버레이 카드, 모바일 대응 |
| `scripts/verify-step8-auth.js` **신규** | 통합 검증 스크립트 (33 체크) |
| `docs/README.md` | Step 8 인덱스 행 추가 |

### 구현 중 발견·해결한 이슈
1. **마이그레이션 순서 버그**: schema.sql의 `idx_profiles_user`가 기존 DB에 없는 `profiles.user_id`를 참조 → `no such column` 에러. 기존 DB 호환 ALTER들을 schema.sql 실행 **전**으로 옮겨 해결. (`PRAGMA table_info` 결과 `cols.length` 가드로 최초 빈 DB도 안전 처리)
2. **검증 스크립트 JSON 파싱**: 정적 HTML 응답을 JSON.parse 하다 실패 → 원문 그대로 반환하도록 수정.

### 검증 결과 — `node scripts/verify-step8-auth.js`
**33 통과 / 0 실패** (계획서 6절 체크리스트 전항목)

- 회원가입: 3필드 가입 ✅ / 중복 ID 409 ✅ / 6자 미만 400 ✅ / 가입 시 자동 로그인 ✅
- 로그인: 성공 ✅ / 틀린 PW·없는 ID 401 (메시지 동일 — 열거 방지) ✅ / me 복원 ✅
- 미로그인 차단: profiles·cover-letters·target-jobs 전부 401 ✅
- **개인정보 격리**: B가 A의 프로필/자소서를 ID 직접 지정해 조회·수정·삭제·생성 → 전부 404 ✅, B 목록에 A 데이터 미노출 ✅
- 로그아웃: 세션 무효 + 쿠키 만료 ✅
- 공개 API 회귀: 대시보드(summary/postings/index) 로그인 없이 정상 ✅

### 동작 확인 방법 (브라우저)
1. `npm start` 후 페이지 열기 → 헤더 우측 하단 **🔑 로그인** (둥근 버튼)
2. "회원가입" → 이름/ID/PW(6자+) 입력 → 가입 즉시 로그인되며 **대시보드(첫 메인)로 이동**
3. 헤더가 "이름(ID)님 · 로그아웃" 으로 변경
4. 미로그인 상태에서 **📝 이력서 관리** 탭 클릭 → 로그인 화면 자동 표시 (콘텐츠 미노출)
5. 로그인 후 이력서 탭 → 내 프로필만 표시 (다른 회원 데이터 없음)
6. 새로고침·서버 재시작 후에도 로그인 유지 (세션이 SQLite에 저장)

### 실서버 기동 검증 (2026-08-31 추가)
`npm start` 모드(공고 940건 로드)로 실제 기동해 curl 종단 간 확인 — 전 항목 통과:

- 미로그인 `GET /api/profiles` → 401 / 대시보드 `/api/summary` → 200 (공개 유지)
- 회원가입 → 201 + 세션 쿠키 발급, `GET /me` 사용자 복원
- 로그인 상태 프로필 생성 → 201 (user_id 자동 지정)
- 로그아웃 → 재차단 401 → 재로그인 → 내 프로필 목록만 표시
- **사용자 B 격리**: B의 목록 `[]` (A 데이터 미노출), A 프로필 직접 조회/수정 → 404
- 프론트 UI 요소(btn-login, auth-overlay, 회원가입 3필드 등) 실제 서빙 확인
- **서버 재시작 후 세션 유지 확인** (SQLite 세션 저장 검증)
- 테스트 계정·프로필·세션 및 프로세스 정리 완료 (DB: users 0 / profiles 0 / sessions 0)

---

## 5. 세션 수명 단축 + 하트비트 (2026-09-10 ~ 09-11 추가)

### 배경
기존 7일 고정 세션을 다음 요구사항으로 교체:
1. **브라우저 종료 시 자동 로그아웃** — 세션 쿠키(Expires 미지정)는 브라우저 종료와 함께 소멸
2. **페이지를 떠나지 않는 한 로그인 유지** — 활동 중에는 세션을 계속 연장

### 설계 — 5분 슬라이딩 세션 + 3분 하트비트
```
세션 수명(TTL)      = 5분 (SESSION_TTL_MS, auth.js)
하트비트 주기        = 3분 (HEARTBEAT_MS, public/app.js)
쿠키 형태           = 세션 쿠키 (Expires 없음 → 브라우저 종료 시 소멸)
```
- **슬라이딩 만료**: 로그인 시 5분 짜리 세션 발급 → 클라이언트가 3분마다 `POST /api/auth/heartbeat` → 서버가 유효한 세션의 `expires_at`을 "지금+5분"으로 연장. 페이지를 계속 쓰면 만료 시점이 계속 밀려나 로그인이 유지된다.
- **이중 안전망**: 브라우저 종료(쿠키 소멸)가 1차, 서버측 5분 TTL이 2차(=브라우저를 안 닫은 채 방치한 탭 대응).
- **3분 주기인 이유**: TTL 5분의 절반 이상 안쪽. 비활성 탭의 타이머가 브라우저에 의해 늦춰져도 한 번은 반드시 TTL 안에 도달한다.

### 구현

| 파일 | 변경 |
|---|---|
| `auth.js` | `SESSION_TTL_MS` 7일→5분. `extendSession(req)` 신규 — 쿠키 파싱 후 유효한 세션만 연장. `sessionCookie()`에서 Expires 제거(세션 쿠키화) |
| `db.js` | `updateSessionExpiration(tokenHash, newExpiresAt)` 신규. **WHERE 절에 `expires_at >= 현재` 조건** — 만료된 세션의 부활을 원자적으로 차단 |
| `server.js` | `POST /api/auth/heartbeat` 라우트 신규 (총 33 라우트). 연장 성공 `{ok:true}` / 실패 401 |
| `public/app.js` | `sendHeartbeat()` + `startHeartbeat()` (3분 `setInterval`). `visibilitychange` 시 즉시 하트비트 — 비활성 탭의 늦춰진 타이머 보정. 401이면 `authState.user=null` + UI 갱신 |
| `db/schema.sql` | sessions 주석 갱신 (7일 → 5분+하트비트) |

### 리뷰에서 발견·수정된 이슈 (2026-09-11 코드 리뷰)
1. **만료 세션 부활 버그(치명)**: 초판 `updateSessionExpiration`의 UPDATE에 만료 조건이 없어, 5분 이상 방치 후 탭 복귀 시 `visibilitychange` 하트비트가 **만료된 세션을 되살렸다** — 브라우저를 안 닫는 한 사실상 영구 세션. → UPDATE에 `AND expires_at >= 현재시각` 조건을 추가해 원자적으로 차단하고, 연장 실패 시 해당 세션을 즉시 DELETE.
2. **배포 정책 위반**: `deploy/00-namespace.yaml`·`deploy/40-externalsecret.yaml` 이 develop에 다시 들어와 있었다 (과거 fef9194에서 의도 제거 → 6afb53c 복구 사고와 같은 패턴). ArgoCD가 namespaced 모드라 Namespace 객체 apply 불가 + Vault에 `secret/jobradar` 경로가 없어 ExternalSecret이 수동 Secret(jobradar-secret)을 장악할 위험 → **두 파일 삭제 + deploy.sh 정리**.
3. **visibilitychange 오탈자**: 상대경로 `api/auth/heartbeat`(선행 `/` 누락) 및 응답 무시 → `sendHeartbeat()`로 통합해 절대경로 사용 + 401 시 UI 갱신.
4. 사소: `db.js` 미사용 `require('http')` 제거, 하트비트 리터럴 → `SESSION_TTL_MS` 상수 통일, app.js/index.html 캐시버전 갱신.

### 검증 (2026-09-11)
`node scripts/verify-step8-auth.js` — **39 통과 / 0 실패** (기존 33 + 하트비트 6 신규)

신규 검증 항목:
- 유효한 세션 하트비트 → 200 + 연장 확인
- 로그인 쿠키에 `Expires` 없음 확인 (세션 쿠키)
- **세션 강제 만료 후 하트비트 → 401 (부활 금지)**
- 만료 후 `/me` → 401 (무효 유지)
- 쿠키 없는 하트비트 → 401

### 동작 확인 방법 (브라우저)
1. 로그인 후 5분 이상 활동 없이 대기 → 헤더가 로그인 버튼으로 돌아옴 (서버측 만료)
2. 로그인 후 계속 사용 → 로그인 유지 (3분 하트비트 연장)
3. 브라우저 완전 종료 후 재접속 → 로그아웃 상태 (세션 쿠키 소멸)
4. 다른 탭으로 갔다가 돌아오면 visibilitychange 하트비트 즉시 발사
