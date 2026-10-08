# Step 5 / 5.5 / 5.6: 연동·필터 전면화·IT 직군 선별

> **작업일: 2026-07-07 ~ 07-08** · 목표: 프로토타입을 실데이터로 end-to-end 점검하고, 필터 연동 전면화 + 회귀 버그 복구 + IT 직군 선별까지 — "데모 가능한 완성본(로컬)" 상태 도달.

---

## 1. Step 5: 실데이터 end-to-end 연동

- 전체 흐름 검증: 수집(`node collector.js`) → DB → API → 차트까지 한 번에 돌려 통합 버그 확인
- **정합성 검증 방식**: API 카운트를 맹신하지 않고 DB 직접 카운트(`GROUP BY`)와 비교
- **트렌드 요약 텍스트**(`/api/insight/weekly`): 복잡한 LLM 없이 집계 수치로 문장을 조립하는 규칙 기반 구현 (`buildWeeklyInsight`)
- 엣지케이스 처리: 수집 전/필터 0건 안내 메시지, 급여 0→"급여 협의", 경력 null→"경력무관", XSS 방지(`textContent`만 사용)
- 출처/한계 명시: *"본 통계는 워크넷 등록 공고 기준이며, 전체 채용시장을 대변하지 않습니다."*

---

## 2. Step 5.5: 필터 연동 전면화

**문제**: 필터를 바꾸면 공고 목록만 갱신되고, 차트 5개 영역(지역/경력/학력/고용형태/요약)은 반응하지 않음.

**설계 결정 (사용자 선택: 하위 단위 전환)**
- 지역 선택 → "지역별 분포" 차트가 시·도 → 시·군·구 하위 분포로 전환
- 직종별 차트는 직종 하위 분류가 DB에 없어 category 필터 제외, 나머지 적용

**구현**
- 백엔드: 공통 필터 빌더 `buildFilters(query, { base, exclude })` — `base='postings'/'recruits'`에 따라 직접 컬럼 vs EXISTS 서브쿼리 자동 처리, 모든 트렌드 API가 재사용 (파라미터 바인딩으로 SQL 인젝션 방지)
- 프론트: `filterQS()` 헬퍼로 state → 쿼리스트링 변환, `refreshAll()`로 요약+인사이트+차트 동시 갱신

**검증**: 같은 조건(서울+중견+최근7일)에서 summary와 insight total이 **35건으로 일치** · 커밋 `64a577d`

---

## 3. Step 5.6-1: 회귀 버그 — "필터/차트가 사라졌다" (STAR 사례)

**증상**: "지역 하위 분포랑 직종 선택란이 사라졌고, 지역 선택란도 사라졌어"

**원인 추적**: 브라우저가 아니라 `server.log`부터 확인 → `ReferenceError: drilldown is not defined` 반복. 이전 수정에서 `let sql, params, drilldown;`을 `let sql, params;`로 바꾸면서 `else` 블록의 `drilldown = false;` **잔재 1줄**을 남겼고, strict mode 런타임 에러 → region API 500 → 프론트 `fillFilterOptions`의 `region.slice()` 조용히 실패 → 드롭다운·차트 전부 공백의 **연쇄 장애**로 번짐.

**수정**: 잔재 1줄 제거 → `/api/trends/region?period=all` 배열 26건 정상 반환.

**교훈 (회귀 방지 규칙화)**
- 부분 Edit 시 **함수 전체를 다시 읽어 잔재 확인** — `node --check`로는 안 잡힘
- "화면이 이상하다"면 **가장 먼저 server.log**
- 에러 미들웨어가 `{"error":...}`를 반환하면 프론트에서 조용히 실패 → API 응답 형태(배열 vs object) 항상 검증

---

## 4. Step 5.6-2: IT·개발 직군 선별 토글

**요청**: "개발자로서 인프라·보안·IT·웹 관련 직종만 선별적으로 보여달라"

**데이터 분석**: `job_category` 분포 82종/246건 → 키워드 매칭으로 **12종/30건** 선별 (반도체·전기전자·기계·로봇은 개발자 맥락과 달라 **의도적 제외**)

**설계**: 백엔드 `buildFilters`에 `itOnly` 옵션 + `IT_KEYWORDS` 20개 상수 / 프론트 필터바에 체크박스 — ON 시 모든 집계·차트·목록과 드롭다운 옵션이 IT 기준으로 재충전

**검증**: `?itOnly=1` → 직종 12종/30건(소프트웨어 17), summary 공고 30/모집 37, 지역 서울 20·경기 6

**후속 버그 — 공고 목록만 전체 노출**: 백엔드 `/api/postings`는 이미 itOnly 처리됐으나 프론트 `renderPostings`만 `filterQS()`를 안 쓰고 `URLSearchParams`를 직접 조립해 itOnly 누락 → 한 줄 추가(`params.set('itOnly','1')`)로 해결. **교훈: 필터→쿼리 변환은 한 곳에서 통일.**

**한계 (솔직 표기)**: `job_category`는 워크넷 첫 직종값만 저장 → 다직종 모집 시 실제보다 적게 잡힘(`jobs_json` 전체 매칭은 향후 과제). 키워드 매칭 노이즈는 직종 드롭다운 세부 선택으로 보완.

---

## 5. 변경 파일 요약

| 파일 | 변경 |
|---|---|
| `server.js` | `buildFilters`(itOnly 포함), region API 버그 수정, `IT_KEYWORDS` |
| `public/app.js` | `filterQS`(itOnly), `fillSelect`(clear), IT 토글 이벤트 |
| `public/index.html` | IT 토글 체크박스, region-sub id |
| `public/style.css` | `.filter-toggle` 스타일 |

> 3뷰 구조(대시보드/인사이트/맞춤공고)는 [step6-views-plan.md](./step6-views-plan.md) 참조 (서울+신입+정규직+IT 복합 필터 → 10건 정확 매칭으로 검증).
