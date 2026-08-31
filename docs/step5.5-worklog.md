# Step 5.5 / 5.6 작업 과정 기록 (Worklog)

> JobMarketRadar · 필터 연동 전면화 + IT 직군 선별
> 작업일: 2026-07-08

---

## 0. 배경

Step 5(정합성/빈데이터/프록시 경로 대응) 완료 후, Step 6(인프라/배포)로 넘어가기 전에
두 가지 사용자 요청을 처리함.

1. **필터 연동 전면화** (Step 5.5) — 기간·기업구분·지역·직종 필터가 모든 차트/인사이트에 종속 반응
2. **사라진 필터/차트 복구 + IT 직군 선별** (Step 5.6) — Step 5.5 도입 중 발생한 회귀 버그 수정 + 개발자 맞춤 직군 필터

---

## 1. Step 5.5: 필터 연동 전면화

### 1.1 문제
필터를 바꾸면 **공고 목록만** 갱신되고, 차트 5개 영역(지역별/경력/학력/고용형태/트렌드 요약)은
필터에 반응하지 않았음. 특히 경력·학력·고용형태·요약은 `period`조차 미반영.

### 1.2 설계 결정
사용자 선택: **하위 단위 전환**
- 지역 선택 → "지역별 분포" 차트가 시·도 → 시·군·구 하위 분포로 전환
- 직종별 차트는 직종 하위 분류가 DB에 없어 category 필터 제외, 나머지 적용

### 1.3 구현
- **백엔드** (`server.js`): 공통 필터 빌더 `buildFilters(query, { base, exclude })` 도입
  - `base='postings'` / `'recruits'` 에 따라 직접 컬럼 vs EXISTS 서브쿼리 자동 처리
  - 모든 트렌드 API가 재사용 → SQL 인젝션 방지(파라미터 바인딩)
- **지역별 차트**: region 선택 시 시·도 → 시·군·구 드릴다운 (시/도 단독 행은 "상세 미기재"로 묶어 노이즈 제거)
- **프론트** (`app.js`): `filterQS()` 헬퍼로 state → 쿼리스트링 변환, `refreshAll()`로 요약+인사이트+차트 동시 갱신

### 1.4 검증
- 정합성: 같은 조건(서울+중견+최근7일)에서 summary와 insight total이 모두 35건으로 일치
- 커밋: `64a577d`

---

## 2. Step 5.6: 버그 수정 + IT 직군 선별

### 2.1 버그 리포트
사용자 피드백: "지역 하위 분포랑 직종 선택란이 사라졌고, 지역 선택란도 사라졌어"

### 2.2 원인 분석 (핵심)
`/api/trends/region` (region 미선택, period=all) 호출 시 **`{"error":"서버 오류가 발생했습니다"}`** 반환.

server.log 확인 → **`ReferenceError: drilldown is not defined`** 반복.

원인 코드 (`server.js` region API):
```js
} else {
  drilldown = false;   // ← 위쪽에선 let sql, params; 만 선언하고 drilldown는 뺐는데,
                       //   이 else 블록 안의 할당문을 못 지움
```
처음 `let sql, params, drilldown;` 로 선언했던 것을, 하위 전환 버그 수정 Edit에서
`let sql, params;` 로 바꾸면서 `else` 블록의 `drilldown = false;` 잔재를 남김.

→ Node strict mode에서 정의되지 않은 변수 할당 → ReferenceError → 런타임 에러
→ region API가 에러 반환 → app.js `fillFilterOptions`가 `region.slice()` 실패로 중단
→ **지역/직종 옵션 둘 다 안 채워짐 + 지역 차트 안 그려짐** (사용자가 본 "사라진" 현상 전부)

### 2.3 수정
- `drilldown = false;` 잔재 1줄 제거
- `// drilldown 여부는 별도로 알려주지 않음` 주석 제거
- 검증: `/api/trends/region?period=all` → ✓ 배열 26건 정상 반환

### 2.4 교훈 (회귀 방지)
- 부분 Edit 시 **함수 전체를 다시 읽고 잔재가 없는지 확인**해야 함
- 런타임 에러(ReferenceError)는 `server.log`에서 바로 보이니, "화면이 이상하다"면
  **가장 먼저 server.log를 봐야 함** (문법 검사 node --check만으로는 안 잡힘)
- 에러 미들웨어가 `{"error":...}` 를 반환하면 프론트 `.slice()` 등에서 조용히 실패 →
  연쇄 장애. 백엔드 API 응답 형태(배열 vs object)는 항상 검증

---

## 3. IT·개발 직군 선별 기능

### 3.1 요청
"우리는 개발자이기 때문에 인프라·보안·IT·웹서버 관련 직종만 선별적으로 뽑아서 보이게"

### 3.2 데이터 분석
DB `job_category` (워크넷 직종명) 분포: 82종 / 246건.
개발자 맥락에서 핵심 IT 직종만 키워드 매칭으로 선별 → **12종 / 30건** (반도체·전기전자·기계·로봇은 제외)

### 3.3 설계
- 백엔드: `buildFilters`에 `itOnly` 옵션 추가 + `IT_KEYWORDS` 상수
  - `itOnly=1` → `job_category LIKE` OR 조건 추가 (exclude와 무관하게 항상 적용)
- 프론트: 필터바에 **"IT·개발 직군만" 체크박스** 추가
  - 토글 ON → 모든 집계/차트/목록이 IT 직종으로 한정 + 직종/지역 옵션도 IT 기준으로 재충전

### 3.4 IT 키워드 (서버 `IT_KEYWORDS`)
```
소프트웨어, 프로그래머, 웹기획, 웹개발, 웹마스터, 인터넷,
정보통신, 정보보안, 네트워크, 데이터, 데이터베이스, 클라우드,
컴퓨터, 서버, 데브옵스, 인공지능, IT, 정보처리, 정보시스템, 보안
```

### 3.5 검증
- `/api/trends/category?itOnly=1` → 12종/30건 (소프트웨어 17, 네트워크·정보보안 2, ...)
- `/api/summary?itOnly=1` → 공고 30 / 모집 37
- `/api/trends/region?itOnly=1` → IT 공고 지역 분포 (서울 20, 경기 6, ...)

### 3.6 한계 / 향후 개선점
- `job_category`는 워크넷 **첫 직종값**만 저장 → 한 공고가 다직종 모집 시 실제보다 적게 잡힐 수 있음
  (정확히 하려면 `jobs_json` 전체를 풀어 매칭 — 향후 과제)
- 키워드 매칭이라 약간의 노이즈 가능 (예: "설치·정비·생산-전기·전자·정보통신")
  → 사용자가 직종 드롭다운에서 세부 선택으로 보완 가능
- 노이즈/누락 조정이 필요하면 `IT_KEYWORDS` 배열만 수정하면 됨

---

## 4. 변경 파일 요약
| 파일 | 변경 |
|---|---|
| `server.js` | `buildFilters` (itOnly 포함), region API 버그 수정, `IT_KEYWORDS` |
| `public/app.js` | `filterQS`(itOnly), `fillSelect`(clear), IT 토글 이벤트 |
| `public/index.html` | IT 토글 체크박스, app.js?v 버전업, region-sub id |
| `public/style.css` | `.filter-toggle` 스타일 |
| `JobMarketRadar.md` | 13절(Step 5.5 계획) |
| `docs/step5.5-worklog.md` | 본 문서 (작업 과정 기록) |

---

## 5. 후속 수정: IT 토글 → 공고 목록도 IT 직종만

### 5.1 버그 리포트
"IT개발 직군 체크 시 차트(직종별/지역별/경력/학력)는 잘 뜨는데, 채용 공고 칸엔
모든 채용공고가 뜬다. IT 직군 채용공고만 뜨게 해달라."

### 5.2 원인
- 백엔드 `/api/postings`는 `buildFilters`를 써서 `itOnly` 쿼리를 **이미 정상 처리**함
  (검증: `?itOnly=1` → 30건, IT 직종만)
- 그런데 프론트 `renderPostings()`는 다른 차트들과 달리 `filterQS()` 헬퍼를 안 쓰고
  **직접 `URLSearchParams`를 조립**했고, 거기엔 `itOnly`가 빠져 있었음
  → 백엔드에 `itOnly`가 안 넘어가서 전체 246건이 반환됨

```js
// 수정 전 (renderPostings)
const params = new URLSearchParams({ page, size });
if (state.company) params.set('companyType', state.company);
if (state.region) params.set('region', state.region);
if (state.category) params.set('category', state.category);
// ← itOnly 누락!
```

### 5.3 수정
`renderPostings()`에 한 줄 추가:
```js
if (state.itOnly) params.set('itOnly', '1');
```

### 5.4 검증
- `?itOnly=1` → total 30건, 직종이 소프트웨어/데이터시스템/컴퓨터하드웨어/정보보안 등으로만 구성 ✅
- 토글 OFF → 전체 246건으로 복귀

### 5.5 교훈
필터 상태 → API 쿼리 변환은 **한 곳(`filterQS`)에서 통일**하는 게 좋다.
`renderPostings`만 직접 조립해서 itOnly가 누락된 것.
→ 향후 새 필터 추가 시 `filterQS()` 한 곳만 고치면 전 영역에 반영되도록 설계.
   (단, `renderPostings`는 period를 전체 고정으로 쓰는 특수성이 있어 분리 유지)

---

## 6. Step 6: 3뷰 구조 (내비게이션 + 인사이트 + 맞춤공고)

### 6.1 구조
- 상단 내비게이션 탭: 📊 대시보드 / 💡 인사이트 / 🎯 맞춤 공고
- SPA 방식 (단일 index.html, 탭 클릭 시 뷰 show/hide, lazy 데이터 로드)
- 상세 설계: `docs/step6-views-plan.md`

### 6.2 뷰2 인사이트 (C·D·F)
- C(경력·학력): 신입 가능 IT 모집직무 강조 카드 + 경력 도넛 + 학력 막대
- D(지역): 서울 집중도/수도권-비수도권 카드 + 지역 막대
- F(전체 vs IT): 학력(석박사)/정규직/공고수/신입 4종 비교표
- 전체·IT 데이터 병렬 수집 → 변수명 = 실제 API 의미 일치(`allExp`/`itExp`)

### 6.3 뷰3 맞춤공고 (G)
- 조건: 지역/직종/신입/학력무관/정규직/IT + 빠른 선택 프리셋(서울신입정규직, 학력무관인턴, IT전체)
- 카드 클릭 → 워크넷 원본(source_url) 이동
- 조건 localStorage 저장 → 재방문 유지
- **필터는 백엔드 위임**: `eduNone`(학력무관 모집직무 있는 공고), `regular`(정규직 전환형 포함)
  → postings API에 조건 추가. 클라이언트 2차 필터는 education 컬럼이 items에 없어 불가능하므로.

### 6.4 백엔드 변경
- `/api/postings`에 `eduNone`, `regular` 쿼리 추가 (맞춤공고 전용)

### 6.5 검증
- 서울+신입+정규직+IT 복합 필터 → 10건 정확 매칭
- 전체 263 vs IT 31 비교 데이터 정상
- 대시보드 회귀 없음 (기존 차트/필터 유지)

---

## 5. 다음 단계 제안 (Step 6 이전 점검)
1. 브라우저에서 IT 토글 ON/OFF, 지역 하위 분포, 필터 조합 직접 확인
2. `/api/admin/collect` 보호 (토큰) — 외부 공개 시 남용 방지
3. IT 키워드 노이즈 다듬기 (실제 결과 보고 화이트리스트 전환 고려)
4. 이상 없으면 Step 6(인프라/배포: Docker + Jenkins) 진행
