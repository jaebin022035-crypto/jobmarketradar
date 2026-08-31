# Step 9: 채용공고 요구사항 매칭 — 수행 순서 · 워크로그

> 작성일: 2026-08-31 · 설계: [step9-recruit-matching-plan.md](./step9-recruit-matching-plan.md)

---

## 1. 수행 순서

| 단계 | 작업 | 파일 | 선행 | 상태 |
|---|---|---|---|---|
| **9-1** | DB: 회사 검색·공고→요구사항 번들 함수 + cover_letters req_* 마이그레이션 | `db.js`, `db/schema.sql` | — | ✅ |
| **9-2** | ai.js: 2단 모델 구조(PIPE/QUALITY) + url_context fetch + 원문 분석 | `ai.js` | — | ✅ |
| **9-3** | ai.js: 근거 기반 자소서 프롬프트 (요구사항↔스택 매핑) | `ai.js` | 9-2 | ✅ |
| **9-4** | server.js: 신규 API 4개 (companies/search, postings/:id/requirements, ai/analyze-requirements, ai/fetch-url) — auth 보호 | `server.js` | 9-1, 9-2 | ✅ |
| **9-5** | 프론트: 에디터 내 요구사항 소스 선택 UI (① DB ② URL ③ 붙여넣기 + 미리보기 카드) | `index.html`, `app.js`, `style.css` | 9-4 | ✅ |
| **9-6** | 생성 흐름 연결: req_json 저장 → generate에서 근거 반영 / 회사명 폴백 유지 | `server.js`, `app.js` | 9-3, 9-5 | ✅ |
| **9-7** | 통합 검증: 4계층 소스 시나리오 + 회귀(기존 흐름·권한) 테스트 | 검증 스크립트 | 9-1~9-6 | ✅ |
| **9-8** | 문서 갱신 (README 인덱스) + 워크로그 완료 기록 | `docs/` | 9-7 | ✅ |

---

## 2. 진행 기록

### 2026-08-31 (사전 조사 · 설계)

- **DB 데이터 실측**: job_desc 100%(1253/1254), cert_etc 90%, career 90%, education 62% 충전 → DB 경로 즉시 가능 확인
- **source_url 실측**: 940건 전부 자사 채용시스템 URL(greetinghr·ninehire·careerlink 등) — 워크넷 URL 아님
- **Gemini url_context 실측**: 채용공고 4건 중 3건 실패 (네이버웹툰·악사손해보험 접근 실패, 신성통상 마감공고만 읽힘). 사람인 메인은 성공
- **서버 직접 fetch 실측**: 자사 공고 404 (JS 렌더링 필요) → 직접 fetch 방식 폐기 확정
- **robots.txt 실측**: 사람인 GPTBot/Bytespider 전면차단, 원티드 CloudFront 403 → 차단 도메인 skip 리스트 확정
- **모델 실측**: `gemini-3.5-flash-lite`(865ms)·`gemini-3.5-flash`(6.8s) 모두 JSON 모드+url_context 지원 확인 → 2단 구조 확정
- **설계 확정**: 4계층 폴백(DB→URL→붙여넣기→회사명), 붙여넣기 칸은 **에디터 안 통합**, 모델 **2단 구조** (PIPE=3.5-flash-lite / QUALITY=3.5-flash)
- 계획서 작성: `step9-recruit-matching-plan.md`

<!-- 단계별 진행은 아래에 기록 -->

---

## 3. 단계별 체크리스트

### 9-1. DB
- [ ] `searchPostingsByCompany(q)` — 회사명 LIKE → 공고 목록
- [ ] `getPostingRequirements(empSeqno)` — 공고+모집직무 → 요구사항 번들 (HTML엔티티 정리)
- [ ] cover_letters 마이그레이션: req_source/req_posting_id/req_url/req_text/req_json
- [ ] updateCoverLetter allowed 필드에 req_* 추가

### 9-2. ai.js 모델 구조
- [ ] MODEL_PIPE/MODEL_QUALITY 상수 (환경변수 오버라이드)
- [ ] `fetchUrlRequirements(url)` — url_context 호출 + 차단 도메인 skip + 실패 감지
- [ ] `analyzeRequirementsText(text)` — PIPE 정제 → QUALITY 구조화 분석
- [ ] 요구사항 JSON 파싱 방어 (실패 시 원문 그대로)

### 9-3. 프롬프트
- [ ] `buildPrompt`에 req 번들 있으면 근거 블록+매핑 규칙 추가
- [ ] 없으면 기존 회사명 프롬프트 (하위 호환)

### 9-4. API
- [ ] GET /api/companies/search?q= (LIKE 이스케이프)
- [ ] GET /api/postings/:id/requirements
- [ ] POST /api/ai/analyze-requirements (8,000자 가드)
- [ ] POST /api/ai/fetch-url (차단 도메인 400 안내)
- [ ] 전 라우트 requireAuth

### 9-5. 프론트 UI
- [ ] 에디터 내 요구사항 아코디언 (기본 접힘)
- [ ] 소스 3탭 (DB/URL/붙여넣기) 전환
- [ ] DB 탭: 회사명 입력 → 공고 목록 → 선택 → 미리보기
- [ ] URL 탭: URL 입력 → 가져오기 → 실패 시 붙여넣기 탭 자동 전환
- [ ] 붙여넣기 탭: textarea → 분석 → 미리보기
- [ ] 미리보기 카드: duties/required/preferred/notes 표시 + 수정 가능 + 소스 배지

### 9-6. 생성 연결
- [ ] 생성 전 req_json 저장 (PUT)
- [ ] generateLetter에서 req_json 읽어 프롬프트에 주입
- [ ] generation_logs.model에 실제 사용 모델 기록

### 9-7. 검증
- [ ] DB 경로 E2E: 회사검색→공고선택→요구사항→생성
- [ ] 붙여넣기 경로 E2E: 원문→분석→생성
- [ ] 차단 도메인(saramin) URL → 안내 응답 확인
- [ ] 회귀: 회사명만 생성·기존 CRUD·권한 401
- [ ] 스크립트: scripts/verify-step9-matching.js

### 9-8. 문서
- [x] docs/README.md Step 9 행 추가
- [x] 본 워크로그 완료 처리 + 결과 요약

---

## 4. 구현 결과 요약 (2026-08-31 완료)

### 검증 결과 — `node -r dotenv/config scripts/verify-step9-matching.js`
**27 통과 / 0 실패** (실제 Gemini 호출 포함 E2E)

- **DB 경로**: 카카오 검색 8건 → 공고 선택 → 요구사항 번들(주요업무/자격/우대) 즉시 반환 ✅
- **차단 도메인**: 사람인·원티드 URL → 400 + 붙여넣기 안내(fallback:paste) ✅
- **붙여넣기 경로**: 원문 → PIPE 정제(잡음 제거) → QUALITY 구조화 → 번들 ✅ (2단 모델 기록 확인)
- **생성 연결**: req_json 저장/복원 → 근거 기반 5항목 생성 ✅
- **권한**: 신규 API 4개 미로그인 401 ✅, generation_logs에 `gemini-3.5-flash` 기록 ✅

### 변경 파일
| 파일 | 내용 |
|---|---|
| `db.js` | `searchPostingsByCompany`(LIKE 이스케이프), `getPostingRequirements`(HTML엔티티 `&#xd;` 정리·우대 키워드 분리), `cleanRecruitText`/`toLines`, cover_letters req_* 5컬럼 마이그레이션, updateCoverLetter allowed에 req_* 추가 |
| `ai.js` | 전면 재작성 — `callGemini` 공통 호출기(temperature 전달 버그 수정), `MODEL_PIPE`(3.5-flash-lite)/`MODEL_QUALITY`(3.5-flash), `fetchUrlRequirements`(url_context+차단감지+실패감지), `analyzeRequirementsText`(PIPE→QUALITY 2단), `formatRequirementsBlock`(매핑 규칙 4조항), buildPrompt에 근거 블록 주입 |
| `server.js` | API 4개 추가(companies/search·postings/:id/requirements·ai/fetch-url·ai/analyze-requirements, 전부 requireAuth), generateLetter에서 req_json 파싱→프롬프트 주입 |
| `public/index.html` | 에디터 내 📋 채용공고 요구사항 아코디언(소스 3탭+미리보기 카드) |
| `public/app.js` | resumeState.req/reqMeta, 3탭 로직(searchDbPostings·fetchUrlRequirements·analyzePaste), 미리보기 편집→저장(collectReqFromPreview), openEditor 복원, URL 실패 시 붙여넣기 탭 자동 전환, 힌트 갱신 |
| `public/style.css` | req-* 스타일 일체 |
| `scripts/verify-step9-matching.js` | 통합 검증 스크립트 (27 체크) |

### 구현 중 발견·해결한 이슈
1. **`work_region` 컬럼 오류**: job_postings가 아닌 job_recruits 컬럼 — 쿼리에서 제거
2. **temperature 미전달**: generate()가 `generationConfigTemperature`를 넘겼으나 callGemini가 무시 — 파라미터 추가
3. **검증 스크립트 한글 URL**: 미인코딩 한글 쿼리로 ERR_UNESCAPED_CHARACTERS — encodeURIComponent 적용
4. **2단 실측**: 붙여넣기 분석 소요 ~17초 (PIPE+QUALITY 합산) — UI에 "약 15~20초" 안내 반영

### 사용 방법 (브라우저)
1. 이력서 관리 → 프로필 선택 → 자소서 열기
2. **📋 채용공고 요구사항** 펼치기 → 소스 3탭 중 선택
   - **① DB에서 찾기**: 회사명 입력(2자+) → 공고 목록 → 클릭 (즉시)
   - **② URL 가져오기**: 공고 URL 입력 (사람인·원티드는 자동 안내)
   - **③ 붙여넣기**: 공고 원문 붙여넣고 분석 (~17초)
3. 미리보기 카드에서 요구사항 확인·수정 (수정한 그대로 반영됨)
4. 🤖 AI로 초안 생성 → 그 공고의 요건에 스택을 매핑한 자소서
