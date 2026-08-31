# Step 3: 백엔드 집계 API

> **기간: 2일** · 이 단계의 목표: Express 서버에서 DB 데이터를 집계해 프론트에 JSON으로 내려주는 REST API를 만든다.

---

## 📌 이 단계의 목표

수집기가 DB에 데이터를 쌓았다면, 이제 그 데이터를 **집계**해 프론트에 줘야 한다. 이 단계의 핵심은 복잡한 로직이 아니라 **`GROUP BY` 집계 쿼리 설계**다 (계획서 7절). "직종별 공고 수" 같은 통계는 SQL 한 줄로 나온다.

완료하면:
- ✅ Express 서버 기동 + 정적 파일 서빙
- ✅ 모든 `/api/*` 엔드포인트 구현
- ✅ 직종/지역/경력/급여 집계 쿼리
- ✅ 파라미터 검증 + 일관된 JSON 응답
- ✅ labport에서 API 동작 확인

---

## 📋 해야 할 일 (체크리스트)

> ✅ **완료 (2026-07-07)** — `server.js` 전체 구현 + `start_server.sh`로 기동(포트 19180). 전 엔드포인트 curl 검증, `period=bad`→400 / 없는공고→404 확인. cron 자동수집 등록.

- [x] Express 서버 기동 (`server.js`) — `0.0.0.0` 바인딩, labport 고유포트
- [x] 정적 파일(`public/`) 서빙 설정
- [x] DB 연결 (better-sqlite3) — `db.init()` 공유
- [x] `/api/summary` (홈 요약)
- [x] `/api/trends/category` (직종별 추이)
- [x] `/api/trends/region` (지역별 분포) — 모집직무 기준, 시/도 축약
- [x] `/api/trends/experience` (경력/학력 분포) — 복합 경력 버킷 정규화
- [x] ~~`/api/trends/salary` (급여 구간)~~ → **`/api/trends/type`(고용형태·기업구분)로 대체** (이 API에 급여 정보 없음)
- [x] `/api/postings` (공고 목록, 필터+페이징)
- [x] `/api/postings/:id` (공고 상세) + `/goto`(원본 리다이렉트)
- [x] `/api/insight/weekly` (트렌드 요약 텍스트)
- [x] `/api/admin/collect` (수동 수집 트리거)
- [x] 파라미터 검증 + 에러 응답 표준화 — `requireValidPeriod`(400) + 전역 에러 핸들러(500)

---

## 🚶 진행 순서 (단계별)

### 1. Express 서버 + 정적 파일 서빙

```js
// server.js (핵심 구조)
const express = require('express');
const db = require('./db');              // SQLite 연결
const path = require('path');

const app = express();
app.use(express.json());

// 정적 파일 (프론트) — public/index.html이 루트로 열림
app.use(express.static(path.join(__dirname, 'public')));

// API 라우터 등록 (아래에서 구현)
app.get('/api/summary', ...);
// ...

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`서버 실행: ${PORT}`));
```

> 💡 Express 하나가 **정적 파일(프론트) + REST API** 둘 다 서빙한다 (계획서 3절). 별도 웹서버 불필요.

### 2. DB 연결 (공통 모듈)

`db.js`에서 SQLite 연결을 내보내, 모든 라우터가 같은 연결을 공유한다.

```js
const Database = require('better-sqlite3');
const db = new Database('app.db');
module.exports = db;
```

### 3. 집계 쿼리의 핵심 패턴: `GROUP BY`

모든 `/api/trends/*`는 **같은 패턴**이다. SQL 한 줄로 끝난다.

**직종별 공고 수:**
```sql
SELECT job_category, COUNT(*) as count
FROM job_postings
WHERE collected_at >= ?   -- 기간 필터
GROUP BY job_category
ORDER BY count DESC;
```

**지역별 분포:** `GROUP BY region`
**학력 분포:** `GROUP BY education`
**경력 분포:** 신입 vs 경력을 구분하는 CASE 로직

> 💡 "복잡한 로직"이 아니라 **"쿼리 설계"** 의 문제라 난이도가 낮다 (계획서 7절).

### 4. 각 엔드포인트 구현

#### `/api/summary` (홈 요약)
총 공고 수, 최근 수집일, 상위 직종 TOP5를 한 번에.
```js
app.get('/api/summary', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) c FROM job_postings').get().c;
  const lastRun = db.prepare('SELECT run_at FROM collection_logs ORDER BY run_at DESC LIMIT 1').get();
  const topCategories = db.prepare(`SELECT job_category, COUNT(*) c FROM job_postings
                                    GROUP BY job_category ORDER BY c DESC LIMIT 5`).all();
  res.json({ total, lastRun: lastRun?.run_at, topCategories });
});
```

#### `/api/trends/category?period=week`
직종별 추이. `period`로 기간 필터 (week/month).
```js
app.get('/api/trends/category', (req, res) => {
  const since = computeSinceDate(req.query.period);  // week→7일 전
  const rows = db.prepare(`SELECT job_category, COUNT(*) c FROM job_postings
                           WHERE collected_at >= ? GROUP BY job_category ORDER BY c DESC`).all(since);
  res.json(rows);
});
```

#### `/api/trends/region` · `/api/trends/experience` · `/api/trends/salary`
동일한 `GROUP BY` 패턴. 급여는 `salary_min`을 구간(예: 0~2000/2000~3000/...)으로 버킷팅하는 CASE문 추가.

#### `/api/postings?category=&region=&period=&page=`
필터 + 페이지네이션. WHERE 조건을 동적으로 조립.

#### `/api/postings/:id`
단건 조회. 상세 페이지 대신 **`source_url`로 리다이렉트** (워크넷 원본으로 이동).

#### `/api/insight/weekly` (5단계에서 정교화)
집계 데이터 기반 "이번 주 트렌드 요약" 텍스트. (3단계에선 뼈대만, 텍스트 로직은 Step 5에서 다듬는다.)

#### `/api/admin/collect` (내부용)
수동 수집 트리거. 배포 후 "수집이 잘 되나?" 확인용. 단순히 collector 함수를 호출.

### 5. 파라미터 검증 + 에러 응답 표준화

잘못된 `period` 값 등을 걸러낸다. 응답 형식을 **전부 동일**하게:

```js
// 성공: { data: ... }  또는 그냥 배열/객체
// 실패: { error: "메시지" } + 적절한 HTTP 상태코드
app.get('/api/trends/category', (req, res) => {
  const period = req.query.period || 'week';
  if (!['week', 'month'].includes(period)) {
    return res.status(400).json({ error: 'period는 week 또는 month만 가능' });
  }
  // ...
});
```

### 6. labport에서 동작 확인

`start_server.sh`로 서버 띄운 뒤, 브라우저나 curl로 각 API가 JSON을 잘 주는지 확인:
```bash
curl "http://localhost:포트/api/summary"
```

---

## ⚠️ 주의사항

1. **💉 SQL 인젝션 방지** — `better-sqlite3`는 **파라미터 바인딩**(`?`)을 쓰면 안전. 절대 문자열 결합으로 쿼리 조립 금지.
   ```js
   // ✅ 안전
   db.prepare('SELECT * FROM job_postings WHERE job_category = ?').get(cat);
   // ❌ 위험
   db.prepare(`SELECT * FROM job_postings WHERE job_category = '${cat}'`);
   ```
2. **⚡ 집계 성능 (인덱스)** — `job_category`, `region`, `collected_at` 등 자주 GROUP BY/WHERE에 쓰는 컬럼은 **인덱스** 생성. 데이터가 많아지면 차이가 큼.
3. **🌐 CORS** — 프론트와 API가 같은 Express 서버(같은 origin)면 CORS 불필요. 분리할 때만 `cors` 패키지.
4. **🔢 페이지네이션 필수** — `/api/postings`는 전체를 주면 안 됨. `LIMIT offset, count`로 잘라서.
5. **📅 기간 계산 주의** — `period=week`는 "최근 7일"인지 "이번 주(월~일)"인지 명확히. 일관되게.
6. **🚫 빈 결과도 정상 응답** — 데이터 없을 때 `[]` 로 주기 (에러 아님). 프론트가 빈 차트 처리 가능.
7. **🔍 에러는 콘솔 + 응답 둘 다** — `console.error(e)` 로 서버 로그 남기고, 클라이언트엔 500 + 메시지.
8. **📦 커밋 단위** — "엔드포인트 1~2개 완성"마다 커밋. 한 번에 다 만들고 커밋하면 히스토리가 뭉개짐.

---

## ✅ 완료 기준 (산출물)

> ✅ **2026-07-07 전수 통과**

- [x] `start_server.sh` 실행 후 서버 정상 기동 — 포트 19180
- [x] 루트(`/`) 접속 시 `public/index.html` 표시 — HTTP 200
- [x] 모든 `/api/*` 엔드포인트가 JSON 반환 — curl 전수 검증
- [x] 집계 결과가 실제 DB 데이터와 일치 — category 합 = 246 (공고수 일치)
- [x] 잘못된 파라미터에 400 응답 — `period=bad` → 400
- [x] 서버 에러 시 500 + 메시지 (서버 안 죽음) — 전역 에러 핸들러

---

## ➡️ 다음 단계

**[Step 4: 프론트 대시보드 →](./step4-frontend-dashboard.md)**

API가 준비되면 프론트 대시보드를 만든다. Chart.js로 집계 결과를 시각화하고, 필터/공고 목록/다크테마/반응형 UI를 갖춘다.
