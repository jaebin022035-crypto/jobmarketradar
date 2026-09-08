# Step 9.5 — 사람인 공고 URL 직접 스크레이핑 (원문 그대로 가져오기)

날짜: 2026-09-08
관련: `docs/step9-recruit-matching-plan.md` (요구사항 4계층 소스), `scraper.js`, `ai.js`, `server.js`

## 배경 · 문제

Step 9의 URL 경로(2차 소스)는 Gemini `url_context` 로 공고를 읽었다. 두 문제가 있었다:

1. **사람인이 `BLOCKED_URL_DOMAINS` 에 등록되어 아예 시도조차 하지 않았다** — 사람인은
   robots.txt 에 GPTBot/Bytespider 등 "AI 봇"만 차단할 뿐, 일반 브라우저 요청은 허용한다 (2026-09-08 재실측).
2. **AI 재해석 개입** — 요구사항을 "정리"하도록 프롬프트가 되어 있어 원문 문장이
   요약·재작성될 여지가 있었다. 자소서의 근거가 되는 필수 자격요건·우대사항은 **글자 그대로** 보존되어야 한다.

## 해결 — 2중 경로

### ① 구조 파싱 (템플릿형 공고 — AI 미경유, 약 0.5초)

`scraper.js` 신규 모듈. 서버가 브라우저 User-Agent 로 HTML을 직접 받아 정규식으로 파싱:

| 정보 | 마크업 | 비고 |
|---|---|---|
| 회사명 | `a.company_name[title]` → `og:title` 폴백 | |
| 직무명 | `.job-title > b` | 다중 모집부문 전부 ` / ` 결합 |
| 본문 섹션 | `.info-block__title` + `.info-block__list` | **제목 위치 기준 슬라이싱** — 중첩 div·"</div >" 공백 닫힘에도 안전 |
| 등록형 자격/우대 | tooltip `details-required-*` / `details-preferred-*` | 경계 = `btnClose` 버튼 직전 (조회수·해시태그 노이즈 차단) |
| 기본 조건 | 요약 `<dt>경력/학력/근무형태/급여/근무지역</dt>` | notes 로 |
| 본문 끝 경계 | `</main>` | 기업정보·리뷰·푸터 유입 방지 |

섹션 분류는 제목 키워드(주요업무/자격요건/우대사항/근무조건/채용절차 + 영문 변형)로 하되,
**템플릿마다 라벨이 다르므로 하드코딩하지 않고 미지정 라벨도 제목을 붙여 notes 에 보존**한다.
자격요건 블록에 "[우대]" 마커가 섞여 있으면 그 이하 행을 preferred 로 이동.
`relay/view`(목록 래퍼)·모바일 URL 은 `rec_idx` 로 정식 `zf_user/jobs/view` URL 로 정규화.

### ② AI 분류 폴백 (자유양식 공고 — 원문 문장은 그대로)

이미지·table 형태의 자유양식 공고(사람인 "일반 양식")는 info-block 구조가 없다.
사용자 요구 "URL마다 다를 수 있음"에 대응:

1. 구조 파싱 실패(`SCRAPE_EMPTY`) 감지
2. `user_content` ~ `jv_footer` 슬라이스에서 **공고 원문 텍스트 전체**를 추출
3. 기존 붙여넣기 2단 파이프라인(PIPE 정제 → QUALITY 구조화)으로 분류만 AI 수행
   — 프롬프트에 "원문 문장을 글자 그대로, 요약·재작성 금지" 명시 (실측: 전 항목 원문과 글자 일치 확인)

실패 계통: HTTP 403/404 → 422 + 붙여넣기 안내, 원문조차 없음(이미지 전용) → 422 + 붙여넣기 안내.

## 변경 파일

- `scraper.js` **신규** — 사람인 직접 스크레이퍼 + AI 폴백
- `ai.js` — `BLOCKED_URL_DOMAINS` 에서 saramin 제거(wanted 만 유지). URL/붙여넣기 프롬프트에 원문 보존 규칙 강화
- `server.js` — `/api/ai/fetch-url`: 지원 사이트는 스크레이퍼 우선(`via: 'scraper'`), 그 외만 Gemini url_context. 스크레이핑 실패는 422+`fallback:'paste'`
- `public/index.html` — URL 탭 안내문 수정 (사람인 직접 읽기 지원)
- `public/app.js` — 로딩 메시지 수정
- `scripts/fixtures/saramin-*.html` — 실공고 3종 fixture (템플릿형/자유양식 2종)
- `scripts/test-scraper.js` **신규** — fixture 기반 단위 테스트 (네트워크·AI 없음) — `node scripts/test-scraper.js`
- `scripts/verify-step9-matching.js` — [2] 섹션 갱신: 사람인 200 직접 스크레이핑 검증

## 검증 결과 (2026-09-08)

- 라이브 테스트 URL: `https://www.saramin.co.kr/zf_user/jobs/relay/view?...&rec_idx=54211558` (토스뱅크 Server Developer)
  - 570ms 응답, 주요업무 6 / 자격요건 4 / 우대사항 2 / 기타(근무조건·채용절차) 15 — 모두 원문 그대로
- 자유양식 공고 2종(rec_idx 54831243, 54869932): AI 폴백으로 분류, 전 항목 원문과 글자 일치
- `node scripts/test-scraper.js` — 12/12 통과
- `node -r dotenv/config scripts/verify-step9-matching.js` — 32/32 통과 (기존 기능 회귀 없음)

## 향후 확장 포인트

- 다른 사이트(잡코리아 등) 추가: `SITES` 맵에 파서 등록만 하면 된다 (`scraper.js` 상단)
- 사람인이 서버 IP 를 차단하기 시작하면: ② 폴백이 자동으로 붙여넣기 안내(422)로 연결된다

## 부록 (2026-09-08 추가) — 과부하 폴백 체인 점검·보강

기존 작업(커밋 180cddb)의 flash-lite 폴백 체인을 전 경로 점검한 결과:

**코어 (ai.js) — 시뮬레이션 11/11 통과** (axios 목으로 503/429/타임아웃 강제):
- QUALITY 503/429/타임아웃 → flash-lite 1회 폴백 성공
- 둘 다 과부하 → `AI_BUSY`(503) + 안내 문구, 2회만 호출 (무한 재시도 없음)
- PIPE 모델 과부하 → 재시도 없이 `AI_BUSY` (PIPE가 폴백 대상이라 무의미)
- 400/500 등 비-과부하 → 폴백 없이 원 에러 전달

**발견된 누락 1곳 → 수정:**
자유양식 공고의 AI 분류 폴백(scraper.js)이 `AI_BUSY`를 재던지는데, server.js 스크레이퍼
catch 블록이 code 구분 없이 전부 422+`fallback:'paste'`로 변환하고 있었다. — 과부하인데
"붙여넣으세요" 안내가 뜨는 문제. 스크레이퍼 catch에 `AI_BUSY → 503 + code` 분기를 추가
(다른 3개 라우트와 동일한 처리). 엔드투엔드 검증: 과부하 → 503+AI_BUSY (fallback 없음),
파싱 실패 → 422+paste, 3/3 통과.

**경로별 최종 상태:**

| 경로 | AI_BUSY → 503+code | 프론트 "잠시 후 다시 시도" |
|---|---|---|
| fetch-url (일반 사이트) | ✅ 원래부터 | ✅ |
| fetch-url (사람인 스크레이핑) | ✅ 이번에 추가 | ✅ |
| analyze-requirements (붙여넣기) | ✅ 원래부터 | ✅ |
| cover-letters generate/regenerate | ✅ 원래부터 | ✅ |
