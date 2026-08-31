# Step 7 · 이력서 관리 — 프로필별 자소서 분리 경합(Race Condition) 수정 계획

> **현상**: 이력서 관리 페이지에서 프로필을 바꿀 때 다른 프로필의 자기소개서가 섞여 보이고, 좌측 프로필의 자소서 개수도 꼬이는 현상
> **원인**: 프론트엔드 비동기 경합 조건(race condition)
> **범위**: `public/app.js`, `public/index.html` (백엔드·DB는 정상, 검증 완료)

---

## 1. 조사 결과 (사실 확인)

### 백엔드 + DB — 정상 분리됨
- `db.listCoverLetters(profileId)` → `WHERE profile_id = ?` 로 프로필별 필터링 정상 (`db.js:214`)
- `GET /api/profiles/:id` → 해당 프로필 자소서만 반환 (`server.js:512`)
- 실제 데이터 테스트: 프로필A에 2개, 프로필B에 1개 → 각각 정확히 분리 반환

### 프론트엔드 — 비동기 경합 버그 발견
jsdom(가상 브라우저)으로 클릭 시나리오 재현 결과, **순차 클릭**에서는 정상 동작하지만 **빠른 연속 클릭** 시 다른 프로필 자소서가 섞이는 경합 존재 확인.

---

## 2. 근본 원인

핵심 문제 코드 (`selectProfile`, `app.js:945`):
```js
async function selectProfile(id) {
  resumeState.currentProfileId = id;          // ① 즉시 변경
  await refreshProfilesState();                // ② await (fetch + renderProfileList)
  await showListView();                        // ③ await (fetch profile/:id → renderLetters)
}
```

`showListView` (`app.js:1025`)는 인자 없이 **await 도중 변할 수 있는 `currentProfileId`**를 참조:
```js
async function showListView() {
  ...
  if (resumeState.currentProfileId) {
    const data = await api(`/api/profiles/${resumeState.currentProfileId}`); // ← await 사이에 값이 바뀔 수 있음
    renderLetters(data.coverLetters || []);
  }
}
```

### 경합 시나리오 (사용자가 겪은 현상)
1. 프로필A 클릭 → `currentProfileId=A` → `GET /api/profiles/A` 진행 중
2. 프로필B 클릭 (A fetch 완료 전) → `currentProfileId=B` → `GET /api/profiles/B` 진행 중
3. **A의 응답이 B보다 늦게 도착** → `renderLetters(A 자소서)`가 B 화면을 덮어씀
   → B 프로필을 선택했는데 A의 자소서가 섞여 보임
4. `renderProfileList()`도 두 번 동시 실행되면서 좌측 카운트(자소서 개수) DOM이 꼬임
   → "프로필에 다른 프로필 자소서 개수가 합류됨"

동일한 경합 패턴이 `refreshLetterListActive` (`app.js:1071`)에도 존재.

> 백엔드·DB는 이미 프로필별로 완벽 분리됨(검증 완료). 버그는 프론트엔드 비동기 타이밍에만 있음.

---

## 3. 수정 전략: "요청 시점 프로필 ID" 캡처 + 응답 최신성 검증

fetch 응답을 렌더링하기 직전에 `currentProfileId === 요청시점id` 체크. 다르면(더 최신 선택이 들어왔으면) 응답을 버림.

검토한 대안:
- **방식 A (간단, 채택)**: 응답 검증 — `renderLetters` 호출 전 `currentProfileId === pid` 체크
- **방식 B (무거움, 미채택)**: `AbortController`로 이전 요청 취소 — 코드베이스 규모 대비 과함

---

## 4. 수정 상세

### 4.1 `selectProfile` (`app.js:945`)
```js
async function selectProfile(id) {
  resumeState.currentProfileId = id;          // 활성 하이라이트는 즉시
  renderProfileList();                         // 하이라이트 먼저 반영 (목록 데이터 갱신은 아래)
  await showListView(id);                      // ★ 인자로 id 명시 전달 (currentProfileId 의존 제거)
  refreshProfilesState();                      // 개수 갱신은 뒤로 (fire-and-forget, 렌더링 경합 무관)
}
```

### 4.2 `showListView(profileId)` (`app.js:1025`) — 인자 수신 + 응답 최신성 가드
```js
async function showListView(profileId) {
  hideAllResumeViews();
  document.getElementById('r-list-view').classList.remove('hidden');
  resumeState.currentLetterId = null;
  setStep('자소서를 선택하거나 새로 작성');
  const pid = profileId ?? resumeState.currentProfileId;
  if (pid) {
    const data = await api(`/api/profiles/${pid}`);
    if (resumeState.currentProfileId !== pid) return;   // ★ 경합 가드: 사이에 다른 프로필 선택됐으면 폐기
    renderLetters(data.coverLetters || []);
  }
}
```

### 4.3 `refreshLetterListActive` (`app.js:1071`) — 동일 가드
```js
async function refreshLetterListActive() {
  const pid = resumeState.currentProfileId;
  if (!pid) return;
  const data = await api(`/api/profiles/${pid}`);
  if (resumeState.currentProfileId !== pid) return;     // ★ 가드
  renderLetters(data.coverLetters || []);
}
```

### 4.4 캐시 버스팅 — index.html 버전 태그 갱신 (`index.html:8`, `index.html:379`)
현재 `app.js?v=20260807_1` / `style.css?v=20260807_1` 고정 → 사용자 브라우저가 구버전 캐시를 쓰고 있을 수 있음(이것만으로도 현상 재현 가능).
→ `?v=20260811_1` 로 변경.

---

## 5. 검증 계획
jsdom 시뮬레이션에서 fetch에 인위적 지연을 넣어 경합을 강제 발생시키고, 수정 전(다른 프로필 자소서 섞임) vs 수정 후(항상 마지막 선택 프로필 자소서만) 비교.

## 6. 영향 범위
- 파일: `public/app.js` (3개 함수), `public/index.html` (버전 태그 2곳)
- 백엔드/DB: 변경 없음
- 회귀: `showListView()` 무인자 기존 호출(저장/삭제/뒤로가기)도 `??` 폴백으로 정상 동작
