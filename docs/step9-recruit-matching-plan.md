# Step 9: 채용공고 요구사항 매칭 자소서 생성 (계획서)

> 작성일: 2026-08-31
> 관련 문서: [step9-recruit-matching-worklog.md](./step9-recruit-matching-worklog.md)
> 전체 인덱스: [README.md](./README.md)

---

## 1. 배경 · 문제 정의

현재(Step 7~8) 자소서 생성은 **회사명 텍스트만** 받아 AI의 사전 지식에 의존:

```
프로필 + 타겟직무 + 회사명(텍스트) → Gemini → 자소서 5항목
```

한계:
- AI가 **그 회사를 알더라도 공고별 요구사항을 모름** — 같은 회사라도 공고마다 요건이 다름
- 중소기업·최신 공고는 hallucination 위험 (지식컷 이후 채용)
- "이 공고가 원하는 역량"과 지원자 스택의 **근거 기반 매핑 불가**

→ **실제 채용공고의 요구사항(주요업무/지원자격/우대사항)을 소스로** 받아,
그 요건에 내 스택·경험을 명시적으로 매핑하는 자소서를 생성한다.

## 2. 요구사항 소스 4계층 폴백 (실측 기반 설계)

2026-08-31 실측(Gemini url_context + 서버 직접 fetch 테스트) 결과 반영:

| 계층 | 소스 | 정확도 | 상태 |
|---|---|---|---|
| **1차** | **DB 검색** — 워크넷 수집 공고(940건)에서 회사명 검색 → 공고 선택 | ★★★★★ | job_desc 100%·cert_etc 90% 충전 — **즉시 사용 가능** |
| **2차** | **Gemini url_context** — 공고 URL을 AI가 직접 읽음 | ★★☆ | 채용공고 대상 성공률 ~25% (실측 4건 중 3건 실패). **사람인·원티드 도메인은 robots.txt AI봇 차단 → 자동 skip** |
| **3차** | **공고 원문 붙여넣기** — 사용자가 브라우저에서 복사한 실제 공고 텍스트 | ★★★★★ | **최종 안전판.** 서버가 외부에 요청 안 함 → IP 차단 위험 0 |
| **4차** | 회사명만 (기존 방식) | ★☆ | 폴백 유지 |

### 사람인 IP 차단 회피 원칙 (실측: robots.txt)
- 사람인 robots.txt: `GPTBot`/`Bytespider` 등 **AI 봇 전면 차단** 명시
- 원티드: CloudFront가 비브라우저 요청 **403 차단** 확인
- **우리 서버가 채용 사이트를 직접 fetch 하지 않는다** (User-Agent 위장 금지)
- 2차(url_context)에서도 차단 사이트 도메인은 시도 자체를 skip
- 사용자는 자기 브라우저(정상 트래픽)에서 공고를 열어 복사 → 3차 경로 사용

### 실패 감지 → 자연스러운 강등 체인
```
URL 시도 응답에 "접근 실패/실패/unable to access" 또는 빈 텍스트
→ "URL을 가져오지 못했습니다. 공고 내용을 붙여넣어 주세요" 안내 + 붙여넣기 칸 포커스
```

## 3. AI 모델 2단 구조 (2026-08-31 확정)

실측: 두 모델 모두 JSON 모드·url_context 지원 확인.

| 단 | 모델 | 역할 | 근거 |
|---|---|---|---|
| **PIPE (파이핑)** | `gemini-3.5-flash-lite` | 기계적·반복 작업: 붙여넣은 원문 정제/분류, 회사명 정규화 | 응답 0.9초·저비용 — 빈도 높은 호출에 적합 |
| **QUALITY (품질)** | `gemini-3.5-flash` | 품질 민감 작업: **요구사항 분석(필수/우대/업무 구조화), URL 요약, 자소서 생성** | 응답 6.8초·고품질 — 최종 산출물 품질 좌우 |

환경변수 오버라이드: `GEMINI_MODEL_PIPE`, `GEMINI_MODEL_QUALITY` (기존 `GEMINI_MODEL`은 호환용으로 QUALITY에 적용).
모델 변경 절차·지원 목록·롤백은 **[ai-model-config.md](./ai-model-config.md)** (9-1) 참고.

## 4. 데이터 모델 변경

```sql
-- cover_letters 에 요구사항 번들 저장 (소스 불문 동일 형태)
ALTER TABLE cover_letters ADD COLUMN req_source TEXT;         -- 'db' | 'url' | 'paste' | 'company'
ALTER TABLE cover_letters ADD COLUMN req_posting_id TEXT;     -- db 소스: job_postings.emp_seqno
ALTER TABLE cover_letters ADD COLUMN req_url TEXT;            -- url 소스: 시도한 URL
ALTER TABLE cover_letters ADD COLUMN req_text TEXT;           -- 원문 (url/paste 소스)
ALTER TABLE cover_letters ADD COLUMN req_json TEXT;           -- 분석 완료된 요구사항 JSON
```

**요구사항 번들 형태 (모든 소스가 이 형태로 수렴):**
```json
{
  "company": "카카오뱅크",
  "position": "퇴직연금 도메인 개발자",
  "duties": ["주요 업무 1", "..."],        // 주요 업무
  "required": ["자격 요건 1", "..."],      // 지원자격/필수
  "preferred": ["우대 사항 1", "..."],     // 우대
  "notes": ["근무지역/고용형태 등 기타"]
}
```

## 5. API 설계

| 메서드·경로 | 모델 | 설명 |
|---|---|---|
| `GET /api/companies/search?q=` | — (SQL) | DB에서 회사명 LIKE 검색 → 공고 목록(제목·직종·마감일) |
| `GET /api/postings/:id/requirements` | — (SQL) | DB 공고 → 요구사항 번들 (HTML엔티티 `&#xd;` 정리) |
| `POST /api/ai/analyze-requirements` | **PIPE→QUALITY** | body: `{text}` 붙여넣은 원문 → 정제(PIPE) 후 구조화 분석(QUALITY) |
| `POST /api/ai/fetch-url` | **QUALITY** | body: `{url}` → url_context로 공고 내용 분석. 차단 도메인 skip |
| 기존 `POST /api/cover-letters/:id/generate` | **QUALITY** | req_json 있으면 근거 기반 매핑 프롬프트로 생성 |

모든 신규 라우트는 `auth.requireAuth` 보호 (이력서 도메인).

## 6. 프롬프트 재설계 (ai.js)

생성 프롬프트에 **요구사항 근거 블록** 추가:

```
[채용공고 분석 결과 — 실제 데이터, 반드시 근거로 삼을 것]
- 주요 업무: (번들 duties)
- 지원자격: (번들 required)
- 우대사항: (번들 preferred)

★ 매핑 규칙:
1. 위 요건 각각에 [지원자 정보]의 스택·경험을 명시적으로 대응
2. 요구하지 않은 역량 과장 금지
3. 부족한 요건은 회피 대신 인접 경험으로 녹여 설득
```

(요구사항 없으면 기존 회사명 기반 프롬프트로 폴백 — 하위 호환)

## 7. UI 설계 — 에디터 안 통합 (2026-08-31 확정)

자소서 에디터(`#r-editor`) 내에 **요구사입 소스 선택 영역** 추가:

```
┌ 자소서 에디터 ──────────────────────────────┐
│ 제목 / 타겟직무 / 회사명 (기존)              │
│                                              │
│ 📋 채용공고 요구사항 (신규 아코디언)         │
│  ┌────────────────────────────────────┐     │
│  │ [① DB에서 찾기] [② URL] [③ 붙여넣기] │     │
│  │                                     │     │
│  │ (① 활성: 회사명 검색 드롭다운 →      │     │
│  │   공고 목록 → 선택)                  │     │
│  │ (② 활성: URL 입력칸 + 가져오기 버튼)  │     │
│  │ (③ 활성: 원문 붙여넣기 textarea)     │     │
│  │                                     │     │
│  │ ┌ 요구사항 미리보기 카드 ──────────┐ │     │
│  │ │ 주요업무 / 자격 / 우대 (수정 가능) │ │     │
│  │ └────────────────────────────────┘ │     │
│  └────────────────────────────────────┘     │
│                                              │
│ [🤖 AI로 초안 생성] (요구사항 근거 반영)      │
```

- 3개 탭은 라디오처럼 전환, 선택한 소스가 미리보기 카드에 즉시 반영
- **미리보기 카드에서 사용자가 검증·수정 가능** → 생성 전 신뢰 확보
- URL 실패 시 자동으로 ③ 붙여넣기 탭 전환 + 안내 메시지

## 8. 보안 · 운영 정책

| 항목 | 정책 |
|---|---|
| 서버→외부 fetch | **채용 사이트 직접 fetch 금지** (IP 차단 방지). 외부 접근은 Gemini url_context만 |
| 차단 도메인 | saramin.co.kr, wanted.co.kr (robots.txt/CloudFront 실측 근거) — url_context 시도 skip |
| 붙여넣기 길이 | 최대 8,000자 (가드) — 초과 시 잘라내고 안내 |
| AI 호출 비용 | PIPE(lite)를 기본으로, QUALITY(flash)는 분석·생성에만 — 토큰 로그 기존 generation_logs 재사용 |
| 권한 | 신규 라우트 전부 requireAuth + 소유자 스코핑 |

## 9. 변경 파일 (예상)

| 파일 | 내용 |
|---|---|
| `ai.js` | 2단 모델 구조, url_context fetch, 원문 분석, 근거 기반 프롬프트 |
| `db.js` | 회사 검색, 공고→요구사항 번들, cover_letters req_* 컬럼 마이그레이션 |
| `server.js` | 신규 API 4개 (auth 보호) |
| `public/index.html` `app.js` `style.css` | 에디터 내 요구사항 소스 선택 UI |
| `docs/README.md` | Step 9 인덱스 |

## 10. 완료 기준

> ✅ 2026-08-31 구현 완료 — `scripts/verify-step9-matching.js` 자동 검증 27/27 통과 (실제 Gemini 호출 포함)

- [x] DB 경로: 회사명 검색 → 공고 선택 → 요구사항 표시 → 생성에 근거 반영
- [x] URL 경로: 공고 URL → 분석 성공 시 번들 표시 / 실패 시 붙여넣기 안내
- [x] 사람인·원티드 URL은 시도 없이 붙여넣기로 안내
- [x] 붙여넣기 경로: 원문 → 정제·분석 → 번들 표시 (8,000자 가드)
- [x] 요구사항 없는 기존 흐름(회사명만) 회귀 무손상
- [x] 미리보기 카드 수정 내용이 생성에 반영됨
- [x] 미로그인 신규 API 401
- [x] 모델 2단 동작 확인 (generation_logs.model 에 실제 모델명 기록)
