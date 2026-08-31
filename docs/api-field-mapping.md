# API 필드 ↔ DB 컬럼 매핑

> 대상 API: **한국고용정보원_국민취업지원제도_채용정보** (응답 루트: `dhsOpenEmpInfoDetailRoot`)
> 호출 구분: `callTp=L`(목록) / `callTp=D`(상세)
> 작성일: 2026-07-07

> ⚠️ 아래 **상세(D)** 매핑은 사용자가 제공한 명세를 그대로 반영했다.
> **목록(L)** 매핑(4절)은 2026-07-07 명세 제공 + 실제 호출로 확정했다.

---

## 1. 수집 전략 한눈에 보기

```
callTp=L (목록)  ──►  empSeqno(공고순번) 목록 확보 + 기본 메타
                          │
                          ▼  (순번별로)
callTp=D (상세)  ──►  모집직무·전형단계·자소서 등 상세 전체 저장
```

- 목록(L) 은 "어떤 공고가 있는지" + 기본 정보(제목/회사/기간/고용형태).
- 상세(D) 는 "그 공고의 내용"(모집직무·근무지·경력·학력·인원·전형·자소서·첨부파일).
- **집계(직종/지역/경력/학력)는 상세(D) 의 `empRecrList`(모집직무) 를 기준**으로 한다.

> ✅ **2026-07-07 실제 호출 검증**
> - 목록(L): `…/call/wk/callOpenApiSvcInfo210L21.do` → 루트 `<dhsOpenEmpInfoList>`, `total=231`
> - 상세(D): `…/call/wk/callOpenApiSvcInfo210D21.do` → 루트 `<dhsOpenEmpInfoDetailRoot>`
> - 입력은 코드(`coClcd`/`empWantedTypeCd`…)·출력은 한글명(`coClcdNm`/`empWantedTypeNm`…)으로 오므로 **별도 공통코드 API 불필요**.
> - `empRecrList`/`empJobsList`/`empSelsList` + `workRegionNm`/`empWantedCareerNm`/`empWantedEduNm` 전부 확인 → 아래 매핑 정합.

---

## 2. 테이블 구조 (정규화 3-table)

왜 단일 테이블이 아닌가? → 포트폴리오의 핵심이 **SQL 집계(GROUP BY)** 이므로,
반복되는 모집직무(1공고 : N직무)를 별도 테이블로 빼야 지역/경력/학력 집계가 SQL 한 방에 된다.

| 테이블 | 역할 | 1:N |
|---|---|---|
| `job_postings` | 공고 헤더 1건 (회사·제목·기간·대표직종·URL) | 1 |
| `job_recruits` | 모집직무 단위 (근무지·경력·학력·인원) — **집계의 주체** | N |
| `collection_logs` | 수집 배치 실행 이력 | - |

> 직종(`empJobsList`)과 전형/자소서(`empSelsList`), 첨부파일(`regFileList`)은
> 개별 테이블까지 만들면 오버엔지니어링이므로 **JSON 텍스트 컬럼**에 담는다.
> (대표 직종 1개만 평면 컬럼으로 빼서 직종별 집계를 쉽게 만든다.)

---

## 3. 상세(D) 응답 필드 ↔ DB 컬럼 매핑표

### 3.1 `job_postings` (공고 헤더)

| API 필드 | 한글명 | DB 컬럼 | 타입 | 집계/용도 |
|---|---|---|---|---|
| `empSeqno` | 채용기업번호(공고순번) | `emp_seqno` | TEXT PK | 고유키 ★ |
| `empWantedTitle` | 채용제목 | `title` | TEXT | 표시 |
| `empBusiNm` | 채용업체명 | `company_name` | TEXT | 표시/필터 |
| `coClcdNm` | 기업구분명 | `company_type` | TEXT | 대기업/중소/공공 필터 |
| `empWantedStdt` | 채용시작일자 | `start_dt` | TEXT | posted_at 대체 |
| `empWantedEndt` | 채용종료일자 | `end_dt` | TEXT | 마감일 ★ |
| `empWantedTypeNm` | 고용형태 | `employment_type` | TEXT | 필터 |
| `empJobsList[].jobsCdKorNm` (첫 값) | 대표 직종명 | `job_category` | TEXT | 직종 집계 ★ |
| `empJobsList[].jobsCd` (첫 값) | 대표 직종코드 | `job_category_code` | TEXT | 직종 집계 ★ |
| `empJobsList[]` | 직종 전체 | `jobs_json` | TEXT(JSON) | [{jobsCd,jobsCdKorNm}] |
| `empWantedHomepgDetail` | 채용사이트 URL | `source_url` | TEXT | 상세이동 ★ |
| `empWantedMobileUrl` | 모바일 채용 URL | `mobile_url` | TEXT | 상세이동(모바일) |
| `empWantedHomepg` | 기업 홈페이지 | `homepage` | TEXT | 표시 |
| `regLogImgNm` | 기업 로고 | `logo_url` | TEXT | 표시 |
| `empnRecrSummaryCont` | 모집부분 전체요약 | `recruit_summary` | TEXT | 표시 |
| `empSubmitDocCont` | 제출서류 | `submit_doc` | TEXT | 상세 |
| `empRcptMthdCont` | 접수방법 | `receipt_method` | TEXT | 상세 |
| `empAcptPsnAnncCont` | 합격자발표일 | `result_date` | TEXT | 상세 |
| `inqryCont` | 문의사항 | `inquiry` | TEXT | 상세 |
| `empnEtcCont` | 기타사항 | `etc_cont` | TEXT | 상세 |
| `recrCommCont` | 공통사항 | `common_cont` | TEXT | 상세 |
| `empSelsList[]` (자기소개서) | 자소서 질문 | `selfintro_json` | TEXT(JSON) | 배열 |
| `empSelsList[]` (전형단계) | 전형단계 | `selection_json` | TEXT(JSON) | 배열 |
| `regFileList[].regFileNm` | 첨부파일 | `attach_files_json` | TEXT(JSON) | 배열 |
| — (수집 시각) | — | `collected_at` | TEXT | 운영 |

### 3.2 `job_recruits` (모집직무 — 집계 주체)

> `empRecrList[].empRecrListInfo` 의 각 항목 → 1행. (1공고 : N직무)

| API 필드 (empRecrList) | 한글명 | DB 컬럼 | 타입 | 집계/용도 |
|---|---|---|---|---|
| — (FK) | 공고순번 | `emp_seqno` | TEXT FK | job_postings 조인 |
| — (행 ID) | — | `id` | INTEGER PK | 자동증가 |
| `empRecrNm` | 채용모집명 | `recruit_name` | TEXT | 표시 |
| `jobCont` | 직무설명 | `job_desc` | TEXT | 표시 |
| `workRegionNm` | 근무지 | `work_region` | TEXT | **지역 집계 ★** |
| `empWantedCareerNm` | 지원자격(경력) | `career` | TEXT | **경력 집계 ★** |
| `empWantedEduNm` | 지원자격(학력) | `education` | TEXT | **학력 집계 ★** |
| `sptCertEtc` | 지원자격(기타) | `cert_etc` | TEXT | 표시 |
| `recrPsncnt` | 모집인원수 | `head_count` | INTEGER | 인원 합산 |
| `empRecrMemoCont` | 비고 | `memo` | TEXT | 표시 |
| `selsCont` | 전형단계내용 | `selection` | TEXT | 표시 |

### 3.3 `collection_logs` (수집 이력)

| 용도 | DB 컬럼 | 타입 |
|---|---|---|
| 실행ID | `id` | INTEGER PK |
| 실행시각 | `run_at` | TEXT |
| 모드 | `mode` | TEXT (list/detail/backfill) |
| 수집건수 | `fetched_count` | INTEGER |
| 상태 | `status` | TEXT (success/fail) |
| 메시지 | `message` | TEXT |

---

## 4. 목록(L) 필드 매핑 (2026-07-07 검증 완료)

> 호출 URL: `https://www.work24.go.kr/cm/openApi/call/wk/callOpenApiSvcInfo210L21.do`
> 응답 루트: `<dhsOpenEmpInfoList>` — 실제 호출로 확인(`total=231`).
> 목록(L)은 상세(D)의 부분집합이므로, 헤더(`job_postings`) 컬럼에 그대로 upsert 한다.

### 4.1 요청 파라미터 (callTp=L)

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|:-:|---|
| `authKey` | String | Y | 인증키 |
| `callTp` | String | Y | `L` 고정 (목록) |
| `returnType` | String | Y | `XML` 고정 |
| `startPage` | Number | Y | 검색 시작위치 (기본 1, **최대 1000**) |
| `display` | Number | Y | 출력건수 (기본 10, **최대 100**) |
| `empCoNo` | String | | 채용기업번호 |
| `coClcd` | String | | 기업구분코드 (다중). 10대기업 20공기업 30공공 40중견 50외국계 |
| `empWantedTypeCd` | String | | 고용형태 (다중). 10정규직 20정규직전환 30비정규직 40기간제 50시간선택제 60기타 |
| `empWantedCareerCd` | String | | 경력 (다중). 10무관 20경력 30신입 40인턴 |
| `jobsCd` | String | | 직종코드 |
| `empWantedTitle` | String | | 채용제목 |
| `empWantedEduCd` | String | | 학력 (다중). 10고졸 20대졸(2~3) 30대졸 40석사 50박사 99무관 |
| `sortField` | String | | 정렬필드: `regDt`(등록일) / `coNm`(회사명) |
| `sortOrderBy` | String | | 정렬방식: `desc`(기본) / `asc` |
| `busino` | String | | 사업자번호 |

> **페이지네이션 설계 (Step 2 collector):** `display=100`(최대)으로 고정하고
> `total` 을 100으로 나눈 페이지 수만큼 `startPage` 1→N 순회. (startPage 상한 1000 → 최대 10만 건)

### 4.2 출력 필드 (dhsOpenEmpInfoList)

| API 필드 | 한글명 | 매핑 대상 | 비고 |
|---|---|---|---|
| `total` | 총건수 | (런타임) | 페이지네이션 계산용 |
| `startPage` | 검색 시작위치 | (런타임) | |
| `display` | 출력건수 | (런타임) | |
| `dhsOpenEmpInfo[].empSeqno` | 공개채용공고순번 | `job_postings.emp_seqno` | **고유키 ★ → 상세(D) 호출 키** |
| `dhsOpenEmpInfo[].empWantedTitle` | 채용제목 | `job_postings.title` | |
| `dhsOpenEmpInfo[].empBusiNm` | 채용업체명 | `job_postings.company_name` | |
| `dhsOpenEmpInfo[].coClcdNm` | 기업구분명 | `job_postings.company_type` | 한글명(대기업/중견…) |
| `dhsOpenEmpInfo[].empWantedStdt` | 채용시작일자 | `job_postings.start_dt` | YYYYMMDD |
| `dhsOpenEmpInfo[].empWantedEndt` | 채용종료일자 | `job_postings.end_dt` | YYYYMMDD |
| `dhsOpenEmpInfo[].empWantedTypeNm` | 고용형태 | `job_postings.employment_type` | 한글명(정규직…) |
| `dhsOpenEmpInfo[].regLogImgNm` | 채용기업로고 | `job_postings.logo_url` | |
| `dhsOpenEmpInfo[].empWantedHomepgDetail` | 채용사이트 URL | `job_postings.source_url` | ★ 상세이동 |
| `dhsOpenEmpInfo[].empWantedMobileUrl` | 모바일채용URL | `job_postings.mobile_url` | 빈값 가능 |

> 목록(L)만으로 채울 수 있는 헤더 필드는 위 10개(+URL 2개). 직종/근무지/경력/학력은
> 상세(D)의 `empJobsList`·`empRecrList` 에서 보충해야 하므로 목록 → 상세 2단계 수집이 필수.

---

## 5. 참고: 집계 쿼리가 이 매핑에서 어떻게 떨어지는가

```sql
-- 지역별 채용 분포
SELECT work_region, COUNT(*) cnt, SUM(head_count) persons
FROM job_recruits GROUP BY work_region ORDER BY cnt DESC;

-- 경력 분포 (신입 vs 경력)
SELECT career, COUNT(*) FROM job_recruits GROUP BY career;

-- 학력 분포
SELECT education, COUNT(*) FROM job_recruits GROUP BY education;

-- 직종별 추이 (헤더의 대표 직종 기준)
SELECT job_category, DATE(collected_at) d, COUNT(*)
FROM job_postings GROUP BY job_category, d;
```

→ 즉, **매핑이 잘 되면 집계는 GROUP BY 한 줄**이다. 이것이 정규화의 이유.
