# Step 7 · 작업 이력 (Worklog)

> 2026-08-05 세션 작업 전체 기록 — 인사이트 페이지 개선 → 이력서 관리 페이지 신규 개발 → 배포 → UX 반복 튜닝
> 작업자: Claude Code · 대상 서비스: JobMarketRadar (https://kopo13-jobradar.std.kopoctc.kr)

---

## A. 인사이트 페이지 개선 (세션 전반부)

### A1. C파트 신입 지원 가능 건수 "참고용 표본" 문구 수정
**문제**: 인사이트 페이지 상단에 "IT 직군 약 31건 표본으로 참고용 통계" 고정 문구. 실제 카드는 동적 값인데 안내문만 고정이라 "초기 표본 데이터를 보여주나?" 하는 혼란.
**원인**: `index.html`에 "31건" 하드코딩. (C파트 카드 자체는 이미 `/api/trends/experience` 동적 값)
**해결**: 안내문을 현재 IT 모집직무 수로 실시간 반영 (`#ins-sample-count` → `itSum.totalRecruits`).

### A2. G파트 112건 단위 불일치 + 인사이트 페이지 "IT/개발 직군" 전환
**문제 1 — G파트 단위 불일치**: C파트는 모집직무(recruit) 단위, G파트는 공고(posting) 단위라 숫자가 안 맞음 (G=112건은 공고 단위).
**해결**:
- `collection_snapshots`에 `recruit_counts`(모집직무 단위) 컬럼 추가 + 자동 마이그레이션
- `collector.js` 수집 시 모집직무 단위 직종 카운트도 저장
- `/api/insight/trend`가 `recruit_counts` 우선 사용, 과거 스냅샷은 `category_counts`(공고)로 fallback
- 단위 섞임(전환기) 감지 시 diff 비교 skip 안전장치

**문제 2 — 직군 범위 확장**: `IT_KEYWORDS`에 개발 직군 키워드 15개 추가 (개발자, 프론트엔드, 백엔드, 임베디드, AI 등) → "웹 개발자"(띄어쓰기) 등 신규 편입.
**해결**: 라벨 "IT 직군" → **"IT/개발 직군"** 전면 변경 (index.html, app.js). G파트 "공고 흐름" → "모집직무 흐름".

**배포**: vcluster 이미지 빌드/push/rollout + 수동 수집 1회 → G파트 모집직무 단위 전환 확인 (공고 70→모집직무 91건 기준 일치).

### A3. 로컬 서버 재기동 & vcluster 재배포
- 로컬: `start_server.sh` (PORT 13980)
- vcluster: Docker 빌드 → Harbor push (`std-harbor.kopoctc.kr/kopo13/jobradar:latest`) → `kubectl rollout restart`
- 수동 수집: `POST /api/admin/collect` → recruit_counts 스냅샷 생성

---

## B. 이력서 관리 페이지 신규 개발 (세션 후반부)

### B1. 기획 & 결정사항
| 결정 | 내용 |
|---|---|
| AI 엔진 | Gemini API (교체 대비 `ai.js` 추상화) |
| 키 관리 | 서버 환경변수 `GEMINI_API_KEY` (Secret 주입) |
| 저장 | SQLite 3 테이블 (profiles, cover_letters, generation_logs) |
| 자소서 | 표준 5항목 (지원동기/성장/장단점/직무경험/포부) |
| 작성 | AI 초안 → 직접 수정 + 직무 변경 재생성 |
| 프로필 | 다중 프로필 (1:N) |
| 직무 타겟팅 | 워크넷 수집 데이터 연동 |

문서화 사용자 강조 → `docs/step7-resume-design.md`, `docs/step7-resume-ai.md` 작성.

### B2. 구현 (Step 0~4)
- **DB**: 3 테이블 + CRUD + CASCADE 검증
- **AI 모듈** (`ai.js`): Gemini REST (axios), JSON 모드, 실패 처리, 토큰 로깅, `buildPrompt()`
- **백엔드 API**: 프로필/자소서 CRUD, `/generate`, `/regenerate`, `/api/target-jobs`
- **프론트**: 4번째 탭, 프로필 폼, 자소서 에디터, 직무 드롭다운

### B3. Gemini API 키 검증 쟁점
- 사용자 발급 키가 `AIza`가 아닌 `AQ.A...` 형식 → **실제 API 호출로 검증** → 정상 작동 확인 (Google 신규 키 형식). "AIza만 정상" 가정은 오류였음.

### B4. 배포 중 해결한 이슈
1. **Dockerfile에 `ai.js` 누락** → CrashLoopBackOff → COPY 추가 해결
2. **Secret 병합 시 DHS_API_KEY 덮어쓰기** → 두 키 모두 재등록 복구
3. **매니페스트 apply가 env 반영 안 함** → `kubectl set env --from=secret`로 명시 주입

---

## C. UX 반복 튜닝 (사용자 피드백 기반)

### C1. "자소서 생성 버튼이 없다" → 흐름 단순화
초기 흐름이 3단계(프로필→새자소서버튼→에디터)라 헷갈림. 프로필 선택 시 자동 에디터 진입 + AI 버튼 강조.

### C2. "편집/삭제 버튼 안 된다" → 치명적 버그 수정
**근본 원인**: `openEditor`에서 `renderLetters(null)` → `null.length` **TypeError**. 이 에러가 프로필 선택 흐름 전체를 깨버려 선택/편집/삭제 모두 먹통.
**해결**: 이벤트 위임(`closest()`) → **개별 리스너 부착**으로 전면 재작성, `renderLetters(null)` 제거.

### C3. "저장 후 내용 비우고, 프로필 누르면 저장본 표시" → 동작 명확화
저장 = 에디터 비움 + 저장본은 프로필 하단 목록 표시. 단계 chip, 저장 가이드 추가.

### C4. "다른 프로필에도 자소서 개수 올라간다" → 정합성
**진단**: DB는 정상. 원인은 프론트 `resumeState.profiles` 캐시 갱신 누락.
**해결**: `refreshProfilesState()` 헬퍼 — 자소서 생성/저장/삭제 시마다 좌측 프로필 카운트 갱신.

### C5. 마스터-디테일 UI 개편 ★
우측 패널을 **리스트 모드 ↔ 에디터 모드**로 분리:
- 리스트 모드: 저장된 자소서 목록 + "🤖 AI로 초안 생성" 카드
- 에디터 모드: 상단 항상 "← 목록으로" 버튼 + 수정 화면
- 상태: `showEditorEmpty()` / `showListView()` / `openEditor()`

### C6. 회사 맞춤 자소서 ★ (사용자 요청: "회사가 바라는 이상향 반영")
- `cover_letters.company` 컬럼 추가 (자동 마이그레이션)
- `ai.js` 프롬프트에 회사 인재상·핵심가치 반영 지시
- 회사명 입력칸 + 실시간 힌트 갱신
- **검증**: 카카오 입력 → "연결이라는 핵심 가치" 등 실제 카카오 미션 반영 확인

### C7. 회사명 명시적 안내 메시지 (사용자 요청)
**요청**: 회사명 입력 시 "이 회사의 인재상·핵심가치를 미리 파악해 [지원동기]에 작성 → 이를 토대로 초안을 만들었습니다" 명시, 미입력 시 "회사명을 넣지 않았습니다" 명시.
**구현** (`app.js`):
- `updateHint()` — 회사명 입력칸 아래 힌트를 입력/미입력에 따라 분기
- `generationResultMessage()` — AI 생성 완료 후 결과 메시지를 회사명 유무에 따라 분기 (generate·regenerate 공용)
- 배포: v20260805_7

### C8. 회사 핵심 요소(핵심가치·비전·인재상·지향점) 반영 강화 ★ (사용자 요청)
**요청**: 회사 맞춤 작성 시 그 기업의 **핵심가치·비전·인재상·지향점**을 확인해 이에 맞게 작성하는 것을 명시적으로 포함.
**프롬프트 강화** (`ai.js buildPrompt`): company 입력 시 **4단계 작성 절차** 지시
1. 먼저 회사의 ① 핵심가치 ② 비전/미션 ③ 인재상 ④ 지향점(추구 방향성) 파악
2. 4가지를 자소서 전체에 자연스럽게 녹여냄 (단순 회사명 언급이 아닌 가치-경험 연결)
3. **항목별 반영 가이드**: 지원동기(비전·핵심가치 공감) / 성장과정(인재상 부합) / 장단점(중시 역량 연결) / 직무경험(지향점 기여) / 포부(비전 실현)
4. "잘 모를 때 대충 일반적 칭찬으로 때우지 말 것" 금지 조항

**프론트 메시지 동기화** (`app.js`): 힌트·결과 메시지에 "핵심가치·비전·인재상·지향점" 4요소 명시.
**검증** (현대모비스): "Mobility Beyond Mobility 비전", "자율주행·전동화·SDV 전환 지향점" 등 실제 기업 방향성 정확 반영 확인.
**배포**: v20260805_8 (이미지 `eb7418f9`).

---

## F. 항목별 강조 포인트 — AI 작성 요구사항 (2026-08-07) ★

### F1. 문제 (사용자 제안)
프로필에 **여러 기술 스택·포트폴리오**가 있을 때, 기존 `buildPrompt()`는 `[지원자 정보]`를 한 덩어리로 AI에게 넘긴다.
→ AI가 **가장 강렬한 경험 하나를 5개 항목에 반복해서 우겨넣는 경향** 발생.
각 자소서 항목(지원동기/성장/장단점/직무경험/포부)에 **어떤 기술·어떤 프로젝트 일화를 배정할지** 사용자가 지정하면
더 다양한 역량을 골고루 보여주는 초안이 나옴.

### F2. 설계 결정 (사용자 확정)
- **위치**: 프로필 편집 폼(좌측 패널) — 프로필에 저장 → 이 프로필의 자소서에 **공통 적용**
- **형태**: 5개 항목 **각각** 강조 포인트 입력칸 (선택 입력)
- 비운 항목은 AI가 프로필에서 자유롭게 선택

### F3. 구현
| 영역 | 변경 |
|---|---|
| **DB** | `profiles.emphasis TEXT` (JSON) 컬럼 추가 + 자동 마이그레이션 (`db.js init()`, company 패턴과 동일) |
| **db.js** | `createProfile`/`updateProfile` 에 `emphasis` 파라미터 추가 |
| **server.js** | `normalizeProfileBody()` 헬퍼 — emphasis 객체→JSON 문자열 정규화 (빈 값은 null). `generateLetter()` 에서 `profile.emphasis` → `buildPrompt` 전달 |
| **ai.js** ★ | `buildPrompt({ ..., emphasis })` 시그니처 확장. emphasis 있으면 `[항목별 강조 포인트]` 블록 + **경험 배정 원칙**("각 항목에 서로 다른 경험 배정, 한 기술/경험 반복 금지") 지시 추가 |
| **index.html** | 프로필 폼에 "🪄 AI 작성 요구사항" 섹션 + 5개 textarea 추가 |
| **app.js** | `showProfileForm` emphasis 파싱 채우기 / `rf-save` 5칸 수집. `EMPHASIS_KEYS` 상수 |
| **style.css** | `.resume-emphasis` 섹션 스타일 |

### F4. 호환성
- 기존 프로필: `emphasis = null` → `[항목별 강조 포인트]` 블록 생략 → **기존 동작 100% 유지**
- 마이그레이션 자동 (init 시 ALTER), 롤백 불필요

### F5. 검증 (로컬)
- 마이그레이션: `emphasis` 컬럼 자동 추가 확인 ✅
- POST: emphasis 객체 → JSON 문자열 저장 ✅ / 빈 값 → null 정규화 ✅
- PUT: emphasis 갱신 + 다른 필드 유지 ✅
- `buildPrompt` 단위 테스트: 강조 블록 + "반복 금지" 지시 + 사용자 입력값 포함 ✅ / emphasis 없으면 생략 ✅
- 실제 AI 생성: 5항목 모두 생성(길이 476/501자) ✅
- 테스트 데이터 정리 → DB 원상복구 (프로필 0/자소서 0)

### F6. 버전
- 정적 파일 버전 쿼리: `?v=20260807_1` (style.css, app.js) → F5 새로고침만으로 최신 반영

### F7. vcluster 배포 (2026-08-10)
- 이미지 빌드 → Harbor push (digest `sha256:fd02bb9...`) → `kubectl rollout restart`
- 전략 `Recreate` (SQLite RWO) → 기존 Pod 종료 후 신규 Pod 기동
- DB 마이그레이션: 서버 기동 시 `db.js init()` 이 `emphasis` 컬럼 자동 추가 (initContainer 시드는 기존 DB 존재로 skip → 영속 데이터 유지)
- **검증**:
  - 신규 Pod 기동 (`jobradar-7db6f4ffd5-xxx`, imageID `sha256:fd02bb9...`) ✅
  - 외부 서비스 `https://kopo13-jobradar.std.kopoctc.kr` 에 "AI 작성 요구사항" 섹션 + `app.js?v=20260807_1` 반영 ✅
  - `/api/summary` 정상, `/api/profiles` 응답에 `emphasis` 필드 포함 ✅
  - 기존 프로필 2개·공고 1042건 데이터 유지 (손실 없음) ✅

---

## D. 최종 상태 (v20260807_1)

### 기능
- ✅ 다중 프로필 (CRUD)
- ✅ 자소서 5항목 AI 생성 (Gemini)
- ✅ 직무 변경 재생성
- ✅ **회사 맞춤 작성** — 핵심가치·비전·인재상·지향점 4요소 파악·반영 (강화)
- ✅ 회사명 입력/미입력 명시적 안내 메시지
- ✅ **항목별 강조 포인트** — 프로필별 AI 작성 요구사항 (한 경험 반복 방지) ★NEW
- ✅ 마스터-디테일 UI (리스트/에디터 모드)
- ✅ 단계별 가이드 chip, 정합성 보장

### 배포
- 로컬: PORT 13980 (labport 자동공개)
- vcluster: `kopo13-jobradar.std.kopoctc.kr` (이미지 digest `sha256:fd02bb9...`, 2026-08-10 배포 — 항목별 강조 포인트 포함)
- Secret: DHS_API_KEY + GEMINI_API_KEY 주입

### 캐시 관리
app.js/style.css 버전 쿼리 (`?v=20260807_1`)로 일반 새로고침(F5)만으로 최신 반영.

---

## E. 교훈 / 메모

1. **이벤트 위임의 함정**: `closest()` 매칭은 미묘하게 꼬일 수 있음. 동적 렌더링 요소엔 개별 부착이 안전.
2. **null 체크**: 동적 렌더링 함수에 `null` 인자 전달은 치명적 — `null.length` TypeError가 전체 흐름을 조용히 깸 (콘솔만 찍혀 사용자는 "반응 없음"으로 인지).
3. **API 키 형식 검증은 동작으로**: 형식(`AIza`) 가정 말고 실제 호출로 검증.
4. **Secret 병합 주의**: `kubectl create secret --dry-run`은 기존 키를 덮어씀. 다중 키는 한 번에 재생성.
5. **캐시 무효화**: 정적 파일은 버전 쿼리로. 강력 새로고침 요구는 사용자 경험 저하.
6. **초보자 UX**: "뭘 해야 하는지" 단계 chip + 빈 화면 안내가 핵심. 자동 진입보다 명시적 선택이 더 명확할 때가 많음.
