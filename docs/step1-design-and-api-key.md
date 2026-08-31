# Step 1: 설계 + API 키 발급

> **기간: 1일** · 이 단계의 목표: 워크넷 Open API 인증키를 발급받고, DB 스키마·API 명세·폴더 뼈대를 확정한다.

---

## 📌 이 단계의 목표

이 단계는 **코딩보다 문서·환경 준비**가 핵심이다. 특히 워크넷 API 인증키는 **승인까지 시간이 걸리므로 가장 먼저 신청**해야 한다. 인증키가 없으면 2단계 수집기를 아예 시작할 수 없다.

완료하면:
- ✅ 워크넷 API 인증키 보유
- ✅ DB 스키마(2테이블) CREATE 문 확정
- ✅ REST API 명세 확정
- ✅ 프로젝트 폴더 + 의존성 설치 + 뼈대 파일

---

## 📋 해야 할 일 (체크리스트)

> 진행 상황 (2026-07-07 업데이트 — 인증키·목록명세 확정)

- [x] 공공데이터포털 회원가입 + 채용정보 API 신청
- [x] 인증키(Encoding / Decoding) 발급 확인 ★
- [x] **인증키 실제값 → `.env` 의 `DHS_API_KEY` 설정 완료** ★
- [x] API 명세서(파라미터/응답필드) 메모 → [docs/api-field-mapping.md](./api-field-mapping.md)
      - 실제 발급 API = **국민취업지원제도 채용정보**(고용24 직접 호출)
      - 목록(L)·상세(D) 매핑 **모두 완료 + 실제 호출로 검증** (`total=231` 확인)
      - 호출 URL 정정: `…/call/wk/callOpenApiSvcInfo210L21.do`(목록) / `…D21.do`(상세)
- [x] **페이지네이션 확정**: `display` 최대 100, `startPage` 최대 1000 → collector.js 설계에 반영
- [x] **공통코드 API 불필요 확인**: 입력 코드 / 출력 한글명(`coClcdNm` 등) → 별도 코드표 API 없이 표시 가능
- [x] DB 스키마 CREATE 문 작성 → [db/schema.sql](../db/schema.sql) (3테이블 정규화)
- [x] REST API 명세 확정 (JobMarketRadar.md 7절 그대로 차용)
- [x] 프로젝트 폴더 + `package.json` + 의존성 설치 (npm install 완료)
- [x] `.env` + `.env.example` + `.gitignore` 추가 (`.env` 키 입력 완료)
- [x] 뼈대 파일(db.js / collector.js / server.js / public/*) 생성
- [x] collector.js 엔드포인트 URL 정정 + 목록(L) 파라미터/페이지네이션 주석 반영

### ✅ Step 2 로 넘어가기 직전 빈칸 — 모두 완료
- [x] **인증키(Encoding) 실제값** → `.env` 의 `DHS_API_KEY`
- [x] **목록(L) 출력 필드** → api-field-mapping.md 4절 채우기
- [x] **1회 최대 건수 / 페이지네이션 파라미터** → collector.js 설계에 반영
- [x] 직종/지역 **공통코드 API** 존재 여부 → 불필요(출력이 한글명)

---

## 🚶 진행 순서 (단계별)

### 1. 공공데이터포털 회원가입 및 API 신청 (최우선)

1. https://www.data.go.kr 접속 → 회원가입/로그인 (공공데이터포털 계정)
2. 검색창에 **"한국고용정보원_워크넷_채용정보"** 검색
3. 해당 API 상세 페이지 진입 → **"활용신청"** 클릭
4. 활용 목적 등 간단 양식 작성 후 제출
5. 마이페이지 → **신청한 API 확인** → 인증키 발급
   - **일반 인증키(Encoding)** : URL에 그대로 쓰는 용도 — 주로 이걸 사용
   - **일반 인증키(Decoding)** : URL 인코딩이 필요한 경우

> 💡 승인이 즉시 되는 경우도 있고, 시간이 걸리는 경우도 있다. **신청 직후 바로 다음 작업으로 넘어가고, 키가 나오면 그때 메모**한다.

### 2. API 명세서 정독 + 메모

발급받은 페이지에서 **"상세설명 → API 명세 / 파라미터 / 응답필드"** 문서를 정독한다. 반드시 아래 항목을 메모해 둔다:

| 확인 항목 | 왜 필요한가 | 메모할 내용 예시 |
|---|---|---|
| **응답 형식** | 파싱 라이브러리 선택 | XML인지 JSON인지 |
| **1회 최대 건수** | 페이지네이션 설계 | 한 페이지당 100건? |
| **파라미터** | 수집 쿼리 구성 | 직종코드, 지역코드, 페이지 |
| **응답 필드명** | DB 컬럼과 매핑 | 구인인증번호, 직종, 급여 필드명 |
| **공통코드 API** | 코드→한글명 변환 | 직종/지역 코드표 별도 API |

> 📝 이 메모는 2단계(수집기) 구현의 **설계도**가 된다. 대충 보지 말 것.

### 3. DB 스키마 CREATE 문 작성

계획서 6절 초안을 바탕으로 **실제 SQL**로 확정한다. 이때 2번에서 확인한 **실제 API 응답 필드명**과 컬럼을 맞춘다.

**job_postings (채용공고 원본)**
- `id` : 구인인증번호 (PK)
- `company_name`, `title`
- `job_category`, `job_category_code`
- `region`, `employment_type`
- `education`, `career_min`, `career_max`
- `salary_type`, `salary_min`, `salary_max`
- `posted_at`, `closing_at`
- `source_url` ★ 상세 이동용
- `collected_at`

**collection_logs (수집 이력)**
- `id`, `run_at`, `fetched_count`, `status`, `message`

### 4. REST API 명세 확정

계획서 7절의 표를 그대로 가져가되, 각 엔드포인트의 **요청 파라미터와 응답 JSON 구조**를 구체화한다.

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/summary` | 홈 요약 |
| GET | `/api/trends/category?period=week` | 직종별 추이 |
| GET | `/api/trends/region` | 지역별 분포 |
| GET | `/api/trends/experience` | 경력/학력 분포 |
| GET | `/api/trends/salary?category=` | 급여 구간 분포 |
| GET | `/api/postings?category=&region=&period=` | 공고 목록 |
| GET | `/api/postings/:id` | 공고 상세 |
| GET | `/api/insight/weekly` | 주간 트렌드 요약 |
| POST | `/api/admin/collect` | 수동 수집 트리거 |

### 5. 프로젝트 폴더 + 의존성 설치

```bash
mkdir -p jobmarketradar/public
cd jobmarketradar
npm init -y
npm install express better-sqlite3 axios node-cron
# 워크넷이 XML로 응답하면:
npm install fast-xml-parser
# 환경변수 관리:
npm install dotenv
```

**의존성 요약:**
- `express` : 백엔드 API 서버
- `better-sqlite3` : SQLite (동기 API라 코드가 단순)
- `axios` : 워크넷 API 호출
- `node-cron` : 주기 수집 스케줄
- `fast-xml-parser` : XML 응답 파싱 (JSON이면 불필요)
- `dotenv` : `.env` 환경변수

### 6. `.env` + `.gitignore`

`.env` (절대 커밋 금지):
```
WORKNET_API_KEY=여기에_발급받은_키
PORT=3000
```

`.gitignore`:
```
node_modules/
.env
*.db
*.db-journal
server.log
server.pid
server.port
```

### 7. 뼈대 파일 생성

계획서 5절 구조대로 **빈 파일 + 주석만**으로 뼈대를 잡는다 (구현은 다음 단계):

- `db.js` : CREATE TABLE만 작성
- `collector.js` : 함수 시그니처 + cron 등록 자리만
- `server.js` : Express 기동 + 라우터 자리만
- `public/index.html` : 빈 HTML 골격

---

## ⚠️ 주의사항

1. **🔑 인증키는 최우선 신청** — 승인 지연이 가장 큰 병목. 나머지 작업과 병행하되 신청 자체는 1분 안에 끝내야.
2. **🚫 키 하드코딩 금지** — 코드에 키를 직접 쓰면 깃허브에 올렸을 때 즉시 유출. 무조건 `.env`.
3. **📄 XML vs JSON 확인** — 워크넷은 보통 XML로 응답. 이걸 2단계에서 뒤늦게 알면 파싱 코드를 다시 짜야 함.
4. **🗂️ 공통코드 API를 놓치지 말 것** — 직종·지역이 코드(숫자)로 오면 한글명 표시가 안 됨. 코드표 API도 같이 신청/확인.
5. **📐 스키마는 API 실제 필드에 맞추기** — 계획서 초안과 실제 API 필드명이 다를 수 있으니, 반드시 응답 예시를 보고 확정.
6. **📦 `package-lock.json`은 커밋한다** — 의존성 버전 고정. `node_modules/`만 제외.

---

## ✅ 완료 기준 (산출물)

- [ ] 워크넷 API **인증키 발급 완료** (가장 중요)
- [ ] API 응답 구조 메모 (형식/필드명/페이지네이션/공통코드)
- [ ] DB 스키마 SQL 확정 (2테이블 CREATE 문)
- [ ] REST API 명세 확정
- [ ] 폴더 구조 + 의존성 설치 + 뼈대 파일 생성
- [ ] `.env` + `.gitignore` 세팅

---

## ➡️ 다음 단계

**[Step 2: 수집기(collector) 구현 →](./step2-collector.md)**

인증키가 준비되면 `collector.js`를 구현한다. 핵심은 **node-cron 스케줄 + 워크넷 API 호출 + XML 파싱 + upsert 저장 + 백필(초기 대량 수집)** 이다.
