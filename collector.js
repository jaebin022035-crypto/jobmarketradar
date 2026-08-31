// collector.js — 국민취업지원제도 채용정보 API 배치 수집 (Step 2 구현)
// 흐름: callTp=L(목록) → empSeqno 목록 → callTp=D(상세) → DB upsert + 로그
// 필드 매핑: docs/api-field-mapping.md
'use strict';

require('dotenv').config();

const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const db = require('./db');

// 고용24 직접 호출 엔드포인트 (2026-07-07 검증 완료)
const API_HOST = process.env.DHS_API_HOST || 'https://www.work24.go.kr/cm/openApi/call/wk';
const LIST_URL = `${API_HOST}/callOpenApiSvcInfo210L21.do`;   // callTp=L
const DETAIL_URL = `${API_HOST}/callOpenApiSvcInfo210D21.do`; // callTp=D
const AUTH_KEY = process.env.DHS_API_KEY; // .env 에서 로드 (절대 하드코딩 금지)

// 목록(L) 페이지네이션 상수 (API 명세 기준)
//   startPage: 검색 시작위치 (기본 1, 최대 1000)
//   display  : 출력건수   (기본 10, 최대 100)
const DISPLAY = 100;
const SLEEP_MS = 200;   // API 호출 제한 대비 — 호출 사이 대기

// empSeqno 등 큰 숫자값의 정밀도 손실을 막기 위해 태그 값을 Number로 자동 변환하지 않는다.
const parser = new XMLParser({ parseAttributeValue: false, parseTagValue: false });

if (!AUTH_KEY) {
  console.error('❌ DHS_API_KEY 가 .env 에 없습니다.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 단건/단일값 정규화: XML 반복 태그는 1건일 때 객체로 올 수 있으므로 항상 배열로
function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

// 값을 안전하게 문자열로 추출 (객체/배열 방어)
function text(v) {
  if (v == null) return null;
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.length ? text(v[0]) : null;
  if (typeof v === 'object') return null;
  return String(v);
}

/**
 * 목록(L) 호출 → { total, items }
 * callTp=L, returnType=XML
 * @param {object} opts { startPage, display, filters }
 * @returns {Promise<{total:number, items:Array<object>}>}
 */
async function fetchList({ startPage = 1, display = DISPLAY, filters = {} } = {}) {
  const params = {
    authKey: AUTH_KEY,
    callTp: 'L',
    returnType: 'XML',
    startPage,
    display,
    ...filters,
  };
  const { data } = await axios.get(LIST_URL, { params, responseType: 'text' });
  const obj = parser.parse(data);
  const root = obj.dhsOpenEmpInfoList || {};
  const total = Number(text(root.total) ?? 0);
  const items = asArray(root.dhsOpenEmpInfo);
  return { total, items };
}

/**
 * 상세(D) 호출 → 파싱된 루트 객체 (raw)
 * callTp=D, returnType=XML, empSeqno=...
 */
async function fetchDetailRaw(empSeqno) {
  const params = { authKey: AUTH_KEY, callTp: 'D', returnType: 'XML', empSeqno: String(empSeqno) };
  const { data } = await axios.get(DETAIL_URL, { params, responseType: 'text' });
  const obj = parser.parse(data);
  return obj.dhsOpenEmpInfoDetailRoot || obj;
}

/**
 * 상세(D) 응답 → DB 매핑 객체 (job_postings 헤더 + job_recruits[])
 * 구조: docs/api-field-mapping.md 3.1/3.2
 *   - empRecrList / empJobsList / empSelsList 는 반복 태그 → 배열 정규화
 *   - 요소가 바로 값이거나 {empRecrListInfo:...} 중첩일 수 있어 양쪽 모두 시도
 */
function mapDetail(root) {
  const g = (k) => text(root[k]);

  // 직종 (empJobsList → empJobsListInfo)
  const jobsRoot = root.empJobsList && (root.empJobsList.empJobsListInfo || root.empJobsList);
  const jobsList = asArray(jobsRoot).map((j) => {
    const info = j.empJobsListInfo || j;
    return {
      jobsCd: text(info.jobsCd),
      jobsCdKorNm: text(info.jobsCdKorNm),
    };
  });

  // 모집직무 (empRecrList → empRecrListInfo) — 집계의 주체 (1공고:N직무)
  const recrRoot = root.empRecrList && (root.empRecrList.empRecrListInfo || root.empRecrList);
  const recruits = asArray(recrRoot).map((r) => {
    const info = r.empRecrListInfo || r;
    return {
      recruit_name: text(info.empRecrNm),
      job_desc: text(info.jobCont),
      work_region: text(info.workRegionNm),
      career: text(info.empWantedCareerNm),
      education: text(info.empWantedEduNm),
      cert_etc: text(info.sptCertEtc),
      head_count: Number(text(info.recrPsncnt)) || null,
      selection: text(info.selsCont),
      memo: text(info.empRecrMemoCont),
    };
  });

  // 전형단계 (empSelsList → empSelsListInfo)
  const selsRoot = root.empSelsList && (root.empSelsList.empSelsListInfo || root.empSelsList);
  const selsList = asArray(selsRoot).map((s) => {
    const info = s.empSelsListInfo || s;
    return {
      step: text(info.selsNm),
      etc: text(info.selsCont) || text(info.selsMemoCont),
    };
  });

  // 첨부파일 (regFileList)
  const files = asArray(root.regFileList)
    .map((f) => {
      const info = f.regFileInfo || f;
      return text(info.regFileNm) || text(info);
    })
    .filter(Boolean);

  return {
    emp_seqno: g('empSeqno'),
    title: g('empWantedTitle'),
    company_name: g('empBusiNm'),
    company_type: g('coClcdNm'),
    employment_type: g('empWantedTypeNm'),
    start_dt: g('empWantedStdt'),
    end_dt: g('empWantedEndt'),
    job_category: jobsList[0]?.jobsCdKorNm || null,
    job_category_code: jobsList[0]?.jobsCd || null,
    jobs_json: jobsList.length ? JSON.stringify(jobsList) : null,
    source_url: g('empWantedHomepgDetail'),
    mobile_url: g('empWantedMobileUrl'),
    homepage: g('empWantedHomepg'),
    logo_url: g('regLogImgNm'),
    recruit_summary: g('empnRecrSummaryCont'),
    submit_doc: g('empSubmitDocCont'),
    receipt_method: g('empRcptMethdCont'),
    result_date: g('empAcptPsnAnncCont'),
    inquiry: g('inqryCont'),
    etc_cont: g('empnEtcCont'),
    common_cont: g('recrCommCont'),
    selfintro_json: null,
    selection_json: selsList.length ? JSON.stringify(selsList) : null,
    attach_files_json: files.length ? JSON.stringify(files) : null,
    collected_at: new Date().toISOString(),
    recruits,
  };
}

/** 상세 1건 → 매핑된 posting 객체 */
async function fetchDetail(empSeqno) {
  return mapDetail(await fetchDetailRaw(empSeqno));
}

/** 일시 오류 대비 재시도 */
async function withRetry(fn, retries = 2) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (e) { lastErr = e; await sleep(1000 * (i + 1)); }
  }
  throw lastErr;
}

/**
 * 목록 전체 페이지 순회 → empSeqno 등 메타 배열
 * total 을 display 로 나눈 페이지 수만큼 startPage 1→N
 */
async function fetchAllListItems(filters = {}) {
  let page = 1;
  const all = [];
  while (true) {
    const { total, items } = await withRetry(() => fetchList({ startPage: page, display: DISPLAY, filters }));
    if (page === 1) console.log(`  목록 total=${total}`);
    if (!items.length) break;
    all.push(...items);
    if (all.length >= total || items.length < DISPLAY) break;
    page++;
    await sleep(SLEEP_MS);
    if (page > 1000) break; // API startPage 상한
  }
  return all;
}

/**
 * 1회 수집 실행 (목록 → 상세 → upsert + 로그)
 * @param {object} opts { backfill?: boolean, limit?: number }
 */
async function run(opts = {}) {
  const { backfill = false, limit } = opts;
  db.init();
  const mode = backfill ? 'backfill' : 'list';
  console.log(`[${mode}] 수집 시작`);

  const items = await fetchAllListItems();
  console.log(`  목록 공고 ${items.length}건`);
  const targets = limit ? items.slice(0, limit) : items;

  let ok = 0, fail = 0;
  for (let i = 0; i < targets.length; i++) {
    const seq = text(targets[i].empSeqno);
    try {
      const posting = await withRetry(() => fetchDetail(seq));
      db.upsertPosting(posting);
      ok++;
      if ((i + 1) % 20 === 0 || i === targets.length - 1) {
        console.log(`  진행 ${i + 1}/${targets.length} (성공 ${ok})`);
      }
      await sleep(SLEEP_MS);
    } catch (e) {
      fail++;
      console.error(`  ✗ ${seq} 실패: ${e.message}`);
    }
  }

  db.logCollection({
    mode,
    fetchedCount: ok,
    status: fail === 0 ? 'success' : 'partial',
    message: `ok=${ok} fail=${fail}`,
  });

  // 집계 스냅샷 저장 — 인사이트 "과거 vs 현재" 흐름 비교용
  // (현재 job_postings 의 직종별 카운트를 한 행으로 보존)
  try {
    const cats = db.getDb()
      .prepare(`SELECT job_category name, COUNT(*) c FROM job_postings
                WHERE job_category IS NOT NULL GROUP BY job_category`).all();
    // 모집직무 단위 직종 카운트 (G파트를 C파트와 같은 모집직무 단위로 맞추기 위함)
    // recruit 테이블엔 job_category가 없으므로 공고 헤더(emp_seqno)로 JOIN
    const recruitCats = db.getDb()
      .prepare(`SELECT p.job_category name, COUNT(*) c
                FROM job_recruits r JOIN job_postings p ON r.emp_seqno = p.emp_seqno
                WHERE p.job_category IS NOT NULL GROUP BY p.job_category`).all();
    db.saveSnapshot({ total: db.countPostings(), categoryCounts: cats, recruitCounts: recruitCats });
    console.log(`  스냅샷 저장: 공고 단위 ${cats.length}개 직종 / 모집직무 단위 ${recruitCats.length}개 직종, 공고 ${db.countPostings()}건`);
  } catch (e) {
    console.error(`  스냅샷 저장 실패(무시 가능): ${e.message}`);
  }

  console.log(`[${mode}] 완료: ok=${ok} fail=${fail}`);
  console.log(`  DB: 공고 ${db.countPostings()}건, 모집직무 ${db.countRecruits()}건`);
}

// 즉시 실행 (CLI: node collector.js / npm run collect)
if (require.main === module) {
  const args = process.argv.slice(2);
  const backfill = args.includes('--backfill');
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : undefined;

  run({ backfill, limit })
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      try {
        db.logCollection({ mode: backfill ? 'backfill' : 'list', status: 'fail', message: e.message });
      } catch (_) { /* DB 미초기화 등 */ }
      process.exit(1);
    });
}

// TODO(Step 3): server.js 기동 시 cron.schedule('0 9,21 * * *', () => run()) 등록

module.exports = { fetchList, fetchDetail, fetchDetailRaw, fetchAllListItems, mapDetail, run };
