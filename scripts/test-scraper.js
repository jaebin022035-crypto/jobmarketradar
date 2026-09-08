// scripts/test-scraper.js — 사람인 스크레이퍼 단위 테스트 (fixture 기반, 네트워크·AI 없음)
// ------------------------------------------------------------
// 사용법: node scripts/test-scraper.js
// fixture 가 없으면 안내 후 종료 (라이브 테스트는 verify-step9-matching.js [2] 참고).
'use strict';

const fs = require('fs');
const path = require('path');
const { parseSaramin, extractSaraminFreeformText, extractSaraminImages, normalizeSaraminUrl } = require('../scraper');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const fx = (f) => path.join(__dirname, 'fixtures', f);

console.log('\n[1] URL 정규화');
check('relay/view URL → 정식 view URL',
  normalizeSaraminUrl('https://www.saramin.co.kr/zf_user/jobs/relay/view?view_type=list&rec_idx=54211558&t_ref=x#seq=0')
  === 'https://www.saramin.co.kr/zf_user/jobs/view?rec_idx=54211558');
check('모바일 URL도 rec_idx 추출',
  normalizeSaraminUrl('https://m.saramin.co.kr/job-search/view?rec_idx=12345&x=1')
  === 'https://www.saramin.co.kr/zf_user/jobs/view?rec_idx=12345');

console.log('\n[2] 템플릿형 공고 파싱 (fixture: 54211558 토스뱅크 — info-block 구조)');
if (fs.existsSync(fx('saramin-54211558.html'))) {
  const html = fs.readFileSync(fx('saramin-54211558.html'), 'utf8');
  const b = parseSaramin(html, 'https://www.saramin.co.kr/zf_user/jobs/view?rec_idx=54211558');
  check('회사명', b.company === '토스뱅크(주)', b.company);
  check('직무명', /Server Developer/.test(b.position), b.position);
  check('주요업무 6항목 (원문 그대로)', b.duties.length === 6 && b.duties.some((x) => x.includes('신청·심사·금리 산출·실행·상환·사후관리')), JSON.stringify(b.duties).slice(0, 90));
  check('자격요건 4항목', b.required.length === 4 && b.required.some((x) => x.includes('빠르게 학습하고 흡수')), JSON.stringify(b.required).slice(0, 90));
  check('우대사항 (등록형 tooltip)', b.preferred.some((x) => x.includes('보훈대상자')), JSON.stringify(b.preferred));
  check('전형절차 (notes)', b.notes.some((x) => x.includes('서류접수 → 사전 과제')));
  check('페이지 노이즈 미포함 (조회수/태그/푸터)', !JSON.stringify(b).includes('조회수') && !JSON.stringify(b).includes('#백엔드'));
  check('meta', b.meta.source === 'url' && b.meta.scraper === 'saramin');
  // 중복 제거 (2026-09-08): info-block 원문과 tooltip 병합분이 불릿/공백 차이로 두 벌 들어오는 것 방지
  const norm = (arr) => arr.map((x) => x.replace(/^[-•·▪○●*]\s*/, '').replace(/\s+/g, ''));
  check('required 불릿/공백 정규화 중복 없음', new Set(norm(b.required)).size === b.required.length);
  check('preferred 불릿/공백 정규화 중복 없음', new Set(norm(b.preferred)).size === b.preferred.length);
} else {
  console.log('  ⏭ fixture 없음 — 생략');
}

console.log('\n[3] 자유양식 공고 (fixture: 54831243 — table/이미지형, 구조 파싱 실패 → SCRAPE_EMPTY)');
if (fs.existsSync(fx('saramin-54831243-freeform.html'))) {
  const html = fs.readFileSync(fx('saramin-54831243-freeform.html'), 'utf8');
  let threw = false;
  try { parseSaramin(html, 'x'); } catch (e) { threw = e.code === 'SCRAPE_EMPTY'; }
  check('구조 파싱 실패 감지 (SCRAPE_EMPTY)', threw);
  const raw = extractSaraminFreeformText(html);
  check('원문 텍스트 추출 (AI 폴백 입력용)', raw.includes('자격요건') && raw.includes('InnoProduct'), raw.slice(0, 60));
} else {
  console.log('  ⏭ fixture 없음 — 생략');
}

console.log('\n[4] 공고 이미지 추출 (OCR 폴백 입력용)');
{
  const f1 = fx('saramin-54831243-freeform.html');
  if (fs.existsSync(f1)) {
    const imgs = extractSaraminImages(fs.readFileSync(f1, 'utf8'));
    check('본문 이미지 URL 추출 (data-src 포함)', imgs.length >= 3 && imgs.some((u) => u.includes('saraminimage.co.kr/recruit/')), JSON.stringify(imgs.slice(0, 2)));
    check('배너·아이콘 제외 (saraminbanner/template_icon)', !imgs.some((u) => /saraminbanner|template_icon/.test(u)));
    check('프로토콜 상대 URL 절대화 (// → https://)', !imgs.some((u) => u.startsWith('//')));
  }
  const f2 = fx('saramin-54211558.html');
  if (fs.existsSync(f2)) {
    const imgs2 = extractSaraminImages(fs.readFileSync(f2, 'utf8'));
    check('템플릿형 공고도 이미지 후보 수집 가능', Array.isArray(imgs2));
  }
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
