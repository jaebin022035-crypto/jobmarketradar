# Step 7 · 이력서 관리 페이지 — 수정 내역 (2026-08-11)

> 이력서 관리(뷰4)의 프로필↔자기소개서 분리 경합 버그 수정 + 자소서 항목별 삭제 기능 추가
> 대상 파일: `public/app.js`, `public/index.html`, `public/style.css`

---

## 1. 해결한 문제

### 1.1 프로필 전환 시 다른 프로필 자소서가 섞여 보이는 현상 (경합 조건)
- **현상**: 프로필을 빠르게 바꿀 때 이전 프로필의 자소서가 잘못 표시되고, 좌측 프로필의 자소서 개수도 꼬임
- **원인**: 비동기 fetch의 `await` 사이에 프로필 선택이 바뀌면, 늦게 도착한 이전 프로필 응답이 현재 화면을 덮어쓰는 **경합 조건(race condition)**
- **영향**: `selectProfile`, `showListView`, `refreshLetterListActive` 3개 함수

### 1.2 자소서 항목별 삭제 기능 부재
- **현상**: 자소서를 삭제하려면 에디터로 들어가서 삭제 버튼을 눌러야 했음
- **요청**: 리스트의 각 자소서 항목에 바로 삭제 버튼 추가

---

## 2. 변경 상세

### 2.1 `public/app.js` — 경합 가드 (3개 함수)

**(a) `selectProfile`** — 프로필 ID를 `showListView(id)`로 명시 전달
```js
async function selectProfile(id) {
  resumeState.currentProfileId = id;
  renderProfileList();           // 활성 하이라이트 먼저 반영
  await showListView(id);        // 리스트 모드로 진입 (id 명시 전달 → 경합 안전)
  refreshProfilesState();        // 개수 갱신은 뒤로 (fire-and-forget)
}
```

**(b) `showListView(profileId)`** — 인자 수신 + 응답 최신성 검증
```js
async function showListView(profileId) {
  ...
  const pid = profileId ?? resumeState.currentProfileId;
  if (pid) {
    const data = await api(`/api/profiles/${pid}`);
    if (resumeState.currentProfileId !== pid) return;   // ★ 경합 가드
    renderLetters(data.coverLetters || []);
  }
}
```

**(c) `refreshLetterListActive`** — 동일한 경합 가드
```js
async function refreshLetterListActive() {
  const pid = resumeState.currentProfileId;
  if (!pid) return;
  const data = await api(`/api/profiles/${pid}`);
  if (resumeState.currentProfileId !== pid) return;     // ★ 가드
  renderLetters(data.coverLetters || []);
}
```

### 2.2 `public/app.js` — 자소서 항목별 삭제 기능

**(a) `renderLetters`** — 각 항목을 `본문(rl-main) + 삭제 버튼(rl-del)` 구조로 변경
```js
<div class="resume-letter-item ..." data-id="${c.id}">
  <div class="rl-main" data-id="${c.id}">
    <span class="rl-title">...</span>
    <span class="rl-job">...</span>
  </div>
  <button class="rl-del" data-act="del-letter" data-id="${c.id}" title="삭제">✕</button>
</div>
```

**(b) 자소서 목록 클릭 이벤트** — 삭제 버튼과 본문 선택을 이벤트 위임으로 분리
- ✕ 버튼 클릭 → `deleteLetter(id)` (`stopPropagation`으로 에디터 진입 차단)
- 본문(`.rl-main`) 클릭 → 에디터 진입 (기존 동작 유지)

**(c) `deleteLetter(id)` 함수 신규 추가** — confirm → DELETE API → 리스트·프로필 개수 갱신
**(d) `showListViewToast` 헬퍼 추가** — 삭제 완료 안내 메시지를 3.5초간 표시

### 2.3 `public/style.css` — 삭제 버튼 스타일
- `.rl-main`: 본문 영역 flex + 커서 포인터
- `.rl-del`: 26px ✕ 버튼, 호버 시 붉은색 (`#fde8e8` 배경, `#c0392b` 글자)

### 2.4 `public/index.html` — 캐시 버전 갱신
- `v=20260807_1` → `v=20260811_2` (app.js, style.css 각각)
- 구버전 캐시로 인해 수정본이 안 불러와지는 문제 예방

---

## 3. 검증 결과 (jsdom 시뮬레이션)

### 경합 수정 검증
- ✅ fetch에 800ms 인위 지연 → 경합 강제 발생시켜도 항상 마지막 선택 프로필의 자소서만 표시
- ✅ 백엔드·DB는 프로필별 정상 분리 확인 (API/DB 직접 검증)

### 삭제 기능 검증
- ✅ 삭제 버튼 클릭 → 항목 삭제 + DB 반영 + 리스트 모드 유지
- ✅ 본문 클릭 → 에디터 진입 (기존 동작 유지)
- ✅ 삭제 버튼 클릭 시 에디터로 잘못 빠지지 않음 (이벤트 분리 정상)

---

## 4. 테스트용 페르소나
두 가상 페르소나로 기능 검증 가능 (프로필 폼에 복사-붙여넣기):
- **김도현** — 백엔드(결제/이커머스), 3년차 → 타겟직무 `소프트웨어`, 회사 `토스`
- **이서연** — 프론트엔드(웹 서비스), 1년차 → 타겟직무 `웹 개발자`, 회사 `당근마켓`

---

## 5. 배포
- 이미지: `std-harbor.kopoctc.kr/kopo13/jobradar:latest` (docker build → push)
- ArgoCD Application `jobradar`가 auto-sync/self-heal로 관리
- `:latest` + `imagePullPolicy: Always` → 파드 재시작 시 새 이미지 자동 적용
