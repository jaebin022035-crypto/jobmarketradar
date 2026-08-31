# Step 4: 프론트 대시보드

> **기간: 2~3일** · 이 단계의 목표: 집계 API 데이터를 받아 다크테마·반응형 대시보드로 시각화한다. (가장 시간이 많이 가는 단계)

---

## 📌 이 단계의 목표

이 단계는 **포트폴리오의 얼굴**이다. 백엔드가 아무리 훌륭해도 대시보드가 투박하면 "데이터 분석 웹"이라는 인상이 안 선다. **정성 들여 세련되게 마감**한다 (계획서 4.1절, 전역 UI 규칙).

완료하면:
- ✅ 다크테마 메인 대시보드 (`index.html`)
- ✅ Chart.js 차트 4종 (직종/지역/경력/급여)
- ✅ 필터 UI (직종/지역/기간)
- ✅ 공고 목록 + 워크넷 원본 링크
- ✅ 모바일/데스크톱 반응형

---

## 📋 해야 할 일 (체크리스트)

- [ ] HTML 뼈대 (헤더 / 요약 카드 / 차트 / 필터 / 공고 목록)
- [ ] 다크테마 CSS (색 팔레트, 타이포 위계, 여백, 둥근 모서리, 그림자)
- [ ] 반응형 레이아웃 (Grid/Flex, 모바일 대응)
- [ ] Chart.js CDN 연결
- [ ] `/api/summary` → 요약 카드 렌더링
- [ ] `/api/trends/category` → 막대/라인 차트
- [ ] `/api/trends/region` → 차트 (도넛/막대)
- [ ] `/api/trends/experience` → 차트
- [ ] `/api/trends/salary` → 차트
- [ ] 필터 UI → API 재호출 → 차트 갱신
- [ ] `/api/postings` → 공고 목록 + 클릭 시 워크넷 이동
- [ ] 로딩/빈 데이터/에러 상태 처리
- [ ] 부드러운 transition/hover 인터랙션

---

## 🚶 진행 순서 (단계별)

### 1. HTML 뼈대 잡기 (`public/index.html`)

화면을 **블록으로 나누어** 배치한다:
```
┌─────────────────────────────────────┐
│ 헤더 (제목 + 최근 수집일)            │
├─────────────────────────────────────┤
│ 요약 카드 (총 공고 / 상위 직종 ...)  │
├──────────────┬──────────────────────┤
│ 필터 패널    │  차트 영역            │
│ (직종/지역/  │  - 직종별 추이        │
│  기간)       │  - 지역 분포          │
│              │  - 경력/학력          │
│              │  - 급여 분포          │
├──────────────┴──────────────────────┤
│ 공고 목록 (클릭 → 워크넷)            │
└─────────────────────────────────────┘
```

Chart.js는 CDN으로 불러온다:
```html
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
```

### 2. 다크테마 CSS (`public/style.css`)

**세련된 마감**이 핵심. 아래 요소를 갖춘다:
- **일관된 색 팔레트**: 배경/카드/강조색을 변수로 정의
- **타이포 위계**: 제목/본문/보조 텍스트 크기·굵기 차이
- **여백·정렬**: 빽빽하지 않게, 정렬 일치
- **둥근 모서리 + 그림자**: 카드에 `border-radius`, 부드러운 `box-shadow`
- **transition/hover**: 버튼·카드에 마우스 올리면 부드럽게 반응

예시 토큰:
```css
:root {
  --bg: #0f1115;
  --card: #1a1d24;
  --accent: #4f9cf9;
  --text: #e6e6e6;
  --muted: #9aa0a6;
  --radius: 12px;
}
.card { background: var(--card); border-radius: var(--radius);
        box-shadow: 0 4px 14px rgba(0,0,0,.3); transition: transform .2s; }
.card:hover { transform: translateY(-2px); }
```

### 3. 반응형 레이아웃

데스크톱은 차트를 여러 열로, 모바일은 한 열로:
```css
.grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }
@media (max-width: 768px) {
  .grid { grid-template-columns: 1fr; }
}
```
> ⚠️ 텍스트가 컨테이너를 벗어나지 않게 (긴 회사명/직종명은 `word-break`/말줄임 처리).

### 4. API 호출 헬퍼 (`public/app.js`)

```js
async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`API 에러: ${res.status}`);
  return res.json();
}
```

### 5. 요약 카드 렌더링

```js
const summary = await api('/api/summary');
document.querySelector('#total-count').textContent = summary.total.toLocaleString();
document.querySelector('#last-run').textContent = summary.lastRun ?? '수집 전';
```

### 6. Chart.js 차트 4종

각 차트는 **데이터 fetch → Chart 인스턴스 생성/갱신** 패턴.

```js
async function drawCategoryChart() {
  const data = await api('/api/trends/category?period=week');
  new Chart(document.getElementById('chart-category'), {
    type: 'bar',
    data: {
      labels: data.map(d => d.job_category),
      datasets: [{ label: '공고 수', data: data.map(d => d.c),
                   backgroundColor: '#4f9cf9' }]
    },
    options: { /* 다크테마 폰트/그리드 색 설정 */ }
  });
}
```

> 💡 Chart.js는 다크테마용으로 **축/그리드 색**을 직접 밝게 설정해야 안 보이지 않는다.

### 7. 필터 UI → 차트 갱신

직종/지역/기간 선택 시 **API를 다시 호출**해 차트를 다시 그린다:
```js
filterForm.addEventListener('change', () => {
  const params = new URLSearchParams(new FormData(filterForm));
  drawCategoryChart(`/api/trends/category?${params}`);
  // 다른 차트도 갱신...
});
```

### 8. 공고 목록 + 워크넷 이동

```js
const postings = await api('/api/postings?category=...');
// 목록 렌더 → 각 항목 클릭 시 window.open(posting.source_url)
```
> 💡 상세 페이지를 직접 만들지 말고 **`source_url`로 워크넷 원본으로 보낸다** (계획서 2절).

### 9. 상태 처리 (로딩/빈 데이터/에러)

- **로딩**: 차트 자리에 스피너/"불러오는 중..."
- **빈 데이터**: "해당 조건의 공고가 없습니다" 안내 (에러 아님)
- **에러**: "데이터를 불러오지 못했습니다" + 재시도 버튼

---

## ⚠️ 주의사항

1. **🎨 "동작만 되는 수준" 금지** — 여백·정렬·타이포 위계·transition에 정성. 포트폴리오 얼굴.
2. **📱 반응형 필수** — 모바일에서 차트/표가 깨지지 않게. 좁은 화면 테스트.
3. **🌑 Chart.js 다크테마** — 축·그리드·라벨 색을 안 바꾸면 검은 바탕에 안 보임.
4. **🔤 텍스트 오버플로우** — 긴 회사명/직종명이 박스를 뚫지 않게 (`text-overflow: ellipsis`).
5. **♻️ 차트 재생성 주의** — 필터 변경 시 기존 Chart 인스턴스를 `destroy()` 후 재생성, 안 그러면 겹침/메모리 누수.
6. **⏳ 로딩/빈 상태 필수** — 수집 직후나 조건에 맞는 데이터가 없을 때 빈 화면만 보이면 "고장난 사이트"로 보임.
7. **🔗 링크는 새 창** — 공고 클릭 시 워크넷으로 이동하면 내 사이트를 떠나므로 `target="_blank"`.
8. **🚫 외부 API 키 노출 금지** — 프론트 코드에 워크넷 키를 넣지 말 것 (백엔드에서만).
9. **🔄 코드 수정 후 캐시** — `style.css`/`app.js`를 바꿨는데 반영 안 되면 `?v=날짜` 쿼리로 갱신 (전역 규칙).

---

## ✅ 완료 기준 (산출물)

- [ ] 데스크톱/모바일 모두 레이아웃 안 깨짐
- [ ] 차트 4종이 실제 API 데이터로 정상 표시
- [ ] 필터 변경 시 차트가 갱신됨
- [ ] 공고 목록 클릭 → 워크넷 원본 새 창으로 이동
- [ ] 로딩/빈 데이터/에러 상태가 모두 있음
- [ ] 다크테마 + hover/transition으로 세련된 인상

---

## ➡️ 다음 단계

**[Step 5: 연동·디테일 →](./step5-integration.md)**

프로토타입이 완성되면 실데이터로 전체 흐름을 점검하고, "이번 주 트렌드 요약" 텍스트 로직과 빈 데이터 케이스를 다듬는다.
