// step5 정합성 검증: API 응답 카운트 vs DB 실제 카운트 교차 검증
'use strict';
const path = require('path');
const fs = require('fs');
process.chdir(path.join(__dirname, '..'));
const db = require('../db');
db.init();

const PORT = Number(fs.readFileSync('./server.port', 'utf8').trim());
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
function check(label, apiVal, dbVal) {
  const ok = apiVal === dbVal;
  if (ok) { pass++; console.log(`  ✅ ${label}: API=${apiVal} == DB=${dbVal}`); }
  else { fail++; console.log(`  ❌ ${label}: API=${apiVal} != DB=${dbVal}  [불일치!]`); }
}

async function jget(p) {
  const res = await fetch(BASE + p);
  if (!res.ok) throw new Error(`${p} -> ${res.status}`);
  return res.json();
}

function dbCount(sql, ...params) {
  return db.getDb().prepare(sql).get(...params).c;
}

(async () => {
  console.log('=== [1] 요약 카운트 ===');
  const summary = await jget('/api/summary');
  check('총 공고수', summary.totalPostings, dbCount('SELECT COUNT(*) c FROM job_postings'));
  check('총 모집직무', summary.totalRecruits, dbCount('SELECT COUNT(*) c FROM job_recruits'));
  check('신입 공고', summary.newCount, dbCount("SELECT COUNT(*) c FROM job_recruits WHERE career LIKE '%신입%'"));
  check('경력 공고', summary.expCount, dbCount("SELECT COUNT(*) c FROM job_recruits WHERE career LIKE '%경력%'"));

  console.log('=== [2] 직종별 합계 (전체기간) ===');
  const cat = await jget('/api/trends/category?period=all');
  const catSumApi = cat.reduce((a, b) => a + b.c, 0);
  const catSumDb = dbCount('SELECT COUNT(*) c FROM job_postings WHERE job_category IS NOT NULL');
  check('직종 카운트 합계', catSumApi, catSumDb);
  const topCatDb = db.getDb().prepare('SELECT job_category name, COUNT(*) c FROM job_postings WHERE job_category IS NOT NULL GROUP BY job_category ORDER BY c DESC LIMIT 1').get();
  check('최다 직종 카운트', cat[0]?.c, topCatDb?.c);

  console.log('=== [3] 지역별 합계 ===');
  const reg = await jget('/api/trends/region?period=all');
  const regSumApi = reg.reduce((a, b) => a + b.c, 0);
  const regSumDb = dbCount('SELECT COUNT(*) c FROM job_recruits WHERE work_region IS NOT NULL');
  check('지역 카운트 합계', regSumApi, regSumDb);

  console.log('=== [4] 경력/학력 분포 합계 ===');
  const exp = await jget('/api/trends/experience');
  const careerSumApi = (exp.career || []).reduce((a, b) => a + b.c, 0);
  const eduSumApi = (exp.education || []).reduce((a, b) => a + b.c, 0);
  check('경력 버킷 합계', careerSumApi, dbCount('SELECT COUNT(*) c FROM job_recruits'));
  check('학력 버킷 합계', eduSumApi, dbCount('SELECT COUNT(*) c FROM job_recruits'));

  console.log('=== [5] 고용형태/기업구분 합계 ===');
  const type = await jget('/api/trends/type');
  const empSumApi = (type.employmentType || []).reduce((a, b) => a + b.c, 0);
  const coSumApi = (type.companyType || []).reduce((a, b) => a + b.c, 0);
  check('고용형태 버킷 합계', empSumApi, dbCount("SELECT COUNT(*) c FROM job_postings WHERE employment_type IS NOT NULL AND employment_type != ''"));
  check('기업구분 합계', coSumApi, dbCount('SELECT COUNT(*) c FROM job_postings'));

  console.log('=== [6] 인사이트 ===');
  const insight = await jget('/api/insight/weekly');
  check('인사이트 총 공고', insight.stats.total, dbCount('SELECT COUNT(*) c FROM job_postings'));
  check('인사이트 정규직 비중(%)', insight.stats.regularPct, Math.round((dbCount("SELECT COUNT(*) c FROM job_postings WHERE employment_type LIKE '%정규직%' OR employment_type LIKE '%전환형%'") / insight.stats.total) * 100));

  console.log('\n=========================================');
  console.log(`결과: ✅ ${pass} 통과 / ❌ ${fail} 실패`);
  console.log('=========================================');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('검증 스크립트 오류:', e.message); process.exit(2); });
