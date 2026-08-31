# Step 2: 수집기(collector) 구현

> **기간: 1일** · 이 단계의 목표: 워크넷 API에서 채용정보를 주기적으로 수집해 SQLite에 저장하는 배치 수집기를 만든다.

---

## 📌 이 단계의 목표

이 단계는 프로젝트의 **핵심 차별점**이자 가장 중요한 축이다. 사용자가 직접 데이터를 올리지 않고 **서버가 알아서 워크넷에서 긁어와 DB에 쌓는** 파이프라인을 만든다.

완료하면:
- ✅ `node-cron`으로 주기 실행되는 수집기
- ✅ 워크넷 API 호출 → XML 파싱 → DB 저장(upsert) 흐름
- ✅ 최초 1회 백필(과거 공고 대량 수집)
- ✅ `collection_logs`에 실행 이력 기록
- ✅ 실패 시 재시도 로직

---

## 📋 해야 할 일 (체크리스트)

> ✅ **완료 (2026-07-07)** — `collector.js` + `db.js` 구현. 백필로 공고 246건 / 모집직무 339건 수집(fail=0). upsert 재수집 중복 0건 검증 통과. (cron 등록은 Step 3의 `server.js`에서 처리)

- [x] 워크넷 API 1회 호출 → 응답 확인 (형식/필드) — `total=246`, 응답 루트 `dhsOpenEmpInfoList` / `dhsOpenEmpInfoDetailRoot` 확인
- [x] XML 파싱 함수 구현 — `fast-xml-parser` + `empXxxListInfo` 중첩 구조 보강
- [x] 페이지네이션(전체 페이지 순회) 구현 — `display=100`, `startPage` 1→N
- [x] 공통코드(직종/지역) 매핑 — 출력이 한글명이라 별도 코드표 API 불필요
- [x] SQLite upsert 저장 함수 — `ON CONFLICT(emp_seqno) DO UPDATE` (헤더+모집직무 트랜잭션)
- [x] `collection_logs` 기록 함수 — `db.logCollection()`
- [x] 백필(초기 대량 수집) 함수 — `run({ backfill: true })`
- [x] `node-cron` 스케줄 등록 — Step 3 `server.js`에서 `0 9,21 * * *` 등록
- [x] 에러 처리 + 재시도 로직 — `withRetry()` 2회
- [x] 수동 실행(`node collector.js`)으로 데이터 적재 확인

---

## 🚶 진행 순서 (단계별)

### 1. 먼저 API 1회 호출해 응답 구조 확인

구현 전에 **브라우저나 curl로 API를 한 번 직접 때려본다**. 이게 가장 중요하다. 문서만 보다 구현하면 필드명이 달라 처음부터 다시 짜게 된다.

```bash
curl "https://www.work24.go.kr/cm/...?authKey=내키&pageNo=1..."
```

응답을 보고 메모:
- 최상위 구조 (XML 루트 태그명)
- 공고 1건의 필드명 (구인인증번호, 회사명, 직종, 급여...)
- 전체 건수가 어디 필드에 있는지 (페이지네이션용)

### 2. XML 파싱 함수 구현

```js
// collector.js (설명용 핵심 구조)
const { XMLParser } = require('fast-xml-parser');

async function parseWorknetResponse(xmlText) {
  const parser = new XMLParser();
  const obj = parser.parse(xmlText);
  // obj에서 공고 배열 추출
  return obj.ROOT.item;  // 실제 구조는 1번에서 확인한 대로 조정
}
```

> ⚠️ XML 구조는 API마다 다르다. 반드시 1번에서 확인한 실제 응답에 맞춰 경로를 조정할 것.

### 3. 페이지네이션 구현

워크넷은 한 번에 최대 약 100건만 준다. 전체를 받으려면 **1페이지, 2페이지... 를 순회**해야 한다.

```js
async function fetchAllPostings() {
  let page = 1;
  const all = [];
  while (true) {
    const xml = await callWorknet(page);      // 페이지별 호출
    const items = parseWorknetResponse(xml);
    if (!items || items.length === 0) break;   // 더 없으면 종료
    all.push(...items);
    page++;
    // ⏱️ API 호출 제한 대비 — 페이지 사이에 잠깐 대기
    await sleep(200);
  }
  return all;
}
```

### 4. 공통코드(직종/지역) 매핑

워크넷은 직종·지역을 **코드(숫자)** 로 준다. 대시보드에 "024"로 뜨면 아무도 모르므로 **한글명으로 변환**해야 한다.

방법:
1. 1단계에서 확인한 **공통코드 API**로 직종·지역 코드표를 받아온다
2. 코드→한글명 매핑 객체(or 별도 테이블)로 저장
3. 수집 시 코드와 한글명 **둘 다** DB에 저장 (`job_category` + `job_category_code`)

### 5. SQLite upsert 저장 함수

**이게 "중복 방지"의 핵심**이다. `구인인증번호`가 PK이므로:
- 이미 있으면 → 값 갱신(마감일 변경 등)
- 없으면 → 새로 삽입

`better-sqlite3`는 `INSERT ... ON CONFLICT(id) DO UPDATE` 구문을 지원한다:

```js
const insert = db.prepare(`
  INSERT INTO job_postings (id, company_name, title, ...)
  VALUES (@id, @company_name, @title, ...)
  ON CONFLICT(id) DO UPDATE SET
    title=excluded.title,
    closing_at=excluded.closing_at,
    collected_at=excluded.collected_at
`);
```

> 💡 upsert가 있어서 매일 수집해도 중복이 쌓이지 않는다.

### 6. `collection_logs` 기록

배치가 정상 동작했는지 확인하려면 **실행 이력**을 남긴다 (계획서 6절, 11절).

```js
// 수집 시작/끝에 기록
db.prepare(`INSERT INTO collection_logs (run_at, fetched_count, status, message)
            VALUES (?, ?, ?, ?)`).run(now, count, 'success', '정상 수집');
```

실패하면 `status='failed'` + 에러 메시지를 저장한다.

### 7. 백필(초기 대량 수집) 함수

서버 처음 켤 때 DB가 비어있으면 대시보드가 텅 빈다. **최초 1회만** 페이지네이션을 끝까지 돌려 과거 공고를 한 번에 긁는다.

```js
async function backfill() {
  const all = await fetchAllPostings();   // 전체 페이지 순회
  saveAll(all);
  log('backfill', all.length, 'success');
}
```

> ⚠️ 백필은 API 호출이 많아진다. 페이지 사이 대기(`sleep`)를 넣어 **호출 제한을 위반하지 않도록** 한다.

### 8. `node-cron` 스케줄 등록

```js
const cron = require('node-cron');

// 매일 새벽 3시 30분 → 증분 수집
cron.schedule('30 3 * * *', async () => {
  console.log('[cron] 수집 시작', new Date().toISOString());
  await collectIncremental();
});
```

`'30 3 * * *'` 의미: **분(30) 시(3) 일(*) 월(*) 요일(*)** → "매일 새벽 3시 30분".

| cron 표현식 | 의미 |
|---|---|
| `30 3 * * *` | 매일 03:30 |
| `0 */6 * * *` | 6시간마다 |
| `0 9 * * 1` | 매주 월요일 09:00 |

### 9. 에러 처리 + 재시도

API가 무응답이거나 일시 오류가 날 수 있다. 단순히 **retry 1회** 정도면 충분하다 (계획서 11절):

```js
async function withRetry(fn, retries = 2) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (e) { if (i === retries - 1) throw e; await sleep(1000); }
  }
}
```

### 10. 수동 실행으로 확인

```bash
node collector.js
```

SQLite 파일(`.db`)을 열어 데이터가 들어갔는지 확인. (예: `sqlite3 app.db "SELECT COUNT(*) FROM job_postings;"`)

---

## ⚠️ 주의사항

1. **⏱️ API 호출 제한 준수** — 너무 빨리(루프 없이 연속) 호출하면 차단되거나 에러. 페이지 사이에 `sleep(100~300ms)` 필수.
2. **🔑 인증키는 `.env`에서 읽기** — 절대 코드에 직접. `process.env.WORKNET_API_KEY`.
3. **📄 XML 파싱 함정** — 공고가 1건일 때 배열이 아니 객체로 오는 경우가 흔함. `Array.isArray()`로 정규화 필요.
4. **🔁 upsert 필수** — 일반 `INSERT`를 쓰면 매일 수집마다 중복 에러. `ON CONFLICT` 사용.
5. **📊 전체 건수 필드 확인** — 페이지네이션 종료 조건을 "빈 배열"로 잡으면 마지막 페이지까지 안전하게 순회 가능.
6. **🧹 빈 값 처리** — 급여/경력 필드가 비어있는 공고가 많음. `null` 허용 컬럼 + 파싱 시 `?? null`.
7. **💾 `collection_logs`로 디버깅** — 수집이 안 되면 로그 테이블부터 확인. `status`가 `failed`인 행을 보면 원인 파악.
8. **🌙 새벽 시간대 추천** — 수집은 트래픽 적은 새벽에. 사용자 접속과 겹치면 SQLite 동시성 문제 가능.

---

## ✅ 완료 기준 (산출물)

> ✅ **2026-07-07 전수 통과** (단, 전체 공고 수 = 현재 API 가용 246건 기준)

- [x] `node collector.js` 실행 시 워크넷 데이터가 SQLite에 쌓임
- [x] 백필로 초기 데이터 적재 확인 — 공고 246건 / 모집직무 339건 ("수천 건"은 API 전체 가용량에 따라 변동)
- [x] 같은 공고를 재수집해도 중복 생성되지 않음(upsert 확인) — 재수집 후 3건→3건 유지 검증
- [x] `collection_logs`에 실행 이력 남음 — `success ok=246 fail=0`
- [x] cron 등록 — Step 3 server.js에서 `0 9,21 * * *` 등록 완료 (실제 발화 대기)
- [x] 실패 시 `collection_logs`에 `failed`로 남고 재시도 동작 — `withRetry` + `status=fail/partial` 기록

---

## ➡️ 다음 단계

**[Step 3: 백엔드 집계 API →](./step3-backend-api.md)**

DB에 데이터가 쌓였으면, Express로 집계 API(직종/지역/경력/급여 `GROUP BY`)를 만든다. 프론트 대시보드가 이 API를 호출해 차트를 그린다.
