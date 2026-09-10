// server.js — Express API 서버 (Step 3 구현 + Step 5.5 필터 연동 전면화 + Step 8 인증)
// REST 명세: JobMarketRadar.md 7절 / docs/step3-backend-api.md / 13절(Step 5.5) / step8-auth-plan.md 3.3절
// 정적 파일(public/) + /api/* 집계 API + cron 자동수집을 한 서버가 담당
'use strict';

const express = require('express');
const path = require('path');
const cron = require('node-cron');
const db = require('./db');
const collector = require('./collector');
const ai = require('./ai');
const auth = require('./auth');
const scraper = require('./scraper');

const PORT = process.env.PORT || 3000;
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 9,21 * * *'; // 1일 2회

// ---------- helpers ----------
// 허용 period 값
const VALID_PERIODS = ['week', 'month', 'all'];

// period → ISO 기준시각. week=7일, month=30일, all=전체(null)
function sinceFromPeriod(period) {
  if (period === 'all' || !period) return null;
  const days = period === 'month' ? 30 : 7; // week 기본
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

// period 검증 미들웨어 — 잘못된 값은 400
function requireValidPeriod(req, res, next) {
  const p = req.query.period;
  if (p && !VALID_PERIODS.includes(p)) {
    return res.status(400).json({ error: `period는 ${VALID_PERIODS.join(', ')} 중 하나여야 합니다` });
  }
  next();
}

// 모집직무의 복합 경력("경력|신입")을 신입/경력/무관으로 정규화 (전형 분포 단순화)
function careerBucket(raw) {
  if (!raw) return '미입력';
  const t = String(raw);
  if (t.includes('무관')) return '경력무관';
  const hasExp = t.includes('경력');
  const hasNew = t.includes('신입');
  if (hasExp && hasNew) return '경력+신입';
  if (hasExp) return '경력';
  if (hasNew) return '신입';
  if (t.includes('인턴')) return '인턴';
  return '기타';
}

// 고용형태 복합값("정규직|기간제|기타")을 주요 버킷으로 정규화
// 정규직 포함 → '정규직', 아니면 기간제/계약 포함 → '계약·기간제', 그 외 → '기타'
function employmentBucket(raw) {
  if (!raw) return '기타';
  const t = String(raw);
  if (t.includes('정규직') || t.includes('전환형')) return '정규직';
  if (t.includes('기간제') || t.includes('계약')) return '계약·기간제';
  return '기타';
}

// SQL INJECT 안전 — 문자열 결합 대신 파라미터 바인딩만 사용
function paginate(page, size) {
  const p = Math.max(1, Number(page) || 1);
  const s = Math.min(100, Math.max(1, Number(size) || 20));
  return { limit: s, offset: (p - 1) * s };
}

// ★ Step 5.6: IT/개발/인프라/보안 직군 키워드 — "IT/개발 직군만 보기" 토글용
// job_category(워크넷 직종명) 에 대해 LIKE 매칭. 인사이트 페이지는 IT/개발 직군 중심.
// (개발 직군 키워드를 포함해 범위를 확장 — '웹 개발자' 같은 띄어쓰기 직종명까지 커버)
const IT_KEYWORDS = [
  '소프트웨어', '프로그래머', '웹기획', '웹개발', '웹마스터', '인터넷',
  '정보통신', '정보보안', '네트워크', '데이터', '데이터베이스', '클라우드',
  '컴퓨터', '서버', '데브옵스', '인공지능', 'IT', '정보처리', '정보시스템', '보안',
  // 개발 직군 확장
  '개발자', '개발', '프론트엔드', '백엔드', '풀스택', '코딩', '게임',
  '임베디드', '펌웨어', '리눅스', '빅데이터', '머신러닝', '딥러닝', '알고리즘', 'AI',
];

// ★ Step 5.5: 트렌드 API 공통 필터 → WHERE 절 부품 생성
// 쿼리스트링의 period/companyType/region/category 를 받아 조건 배열로 반환.
//   base='postings'  → job_postings 직접 컬럼(collected_at/company_type/job_category),
//                      region은 job_recruits 쪽이므로 EXISTS 서브쿼리.
//   base='recruits'  → job_recruits 직접 컬럼(work_region),
//                      나머지는 job_postings 쪽이므로 EXISTS 서브쿼리.
//   exclude          → 해당 필터는 조건에서 제외 (자기 차트가 자기 필터로 한 점으로
//                      수렴하는 것 방지: region API에선 'region', category API에선 'category').
// 반환: { parts:[...], params:[...] }  — 호출자가 WHERE 조립.
function buildFilters(query, { base = 'postings', exclude = [] } = {}) {
  const { category, region, companyType, period, itOnly } = query || {};
  const parts = [];
  const params = [];
  const since = sinceFromPeriod(period || 'all');
  const use = (k) => !exclude.includes(k);

  if (base === 'recruits') {
    // 모집직무 기준 테이블 → collected/company/category 는 공고 헤더 쪽이라 EXISTS로 조인
    if (since) { parts.push('emp_seqno IN (SELECT emp_seqno FROM job_postings WHERE collected_at >= ?)'); params.push(since); }
    if (companyType) { parts.push('emp_seqno IN (SELECT emp_seqno FROM job_postings WHERE company_type = ?)'); params.push(companyType); }
    if (use('category') && category) { parts.push('emp_seqno IN (SELECT emp_seqno FROM job_postings WHERE job_category = ?)'); params.push(category); }
    // region은 모집직무 직접 컬럼 → "서울%" 로 시/도 접두 매칭
    if (use('region') && region) { parts.push('work_region LIKE ?'); params.push(region + '%'); }
  } else {
    // 공고 헤더 기준 테이블 → 직접 컬럼
    if (since) { parts.push('collected_at >= ?'); params.push(since); }
    if (companyType) { parts.push('company_type = ?'); params.push(companyType); }
    if (use('category') && category) { parts.push('job_category = ?'); params.push(category); }
    // region은 모집직무 쪽이므로 EXISTS 서브쿼리
    if (use('region') && region) { parts.push('emp_seqno IN (SELECT emp_seqno FROM job_recruits WHERE work_region LIKE ?)'); params.push(region + '%'); }
  }
  // ★ Step 5.6: IT 직군만 보기 — job_category LIKE 키워드 매칭 조건 추가
  // exclude 와 무관하게 항상 적용 (직종 차트/옵션에서도 IT 직종만 남김)
  if (itOnly) {
    const conds = IT_KEYWORDS.map(() => 'job_category LIKE ?').join(' OR ');
    if (base === 'postings') {
      parts.push(`(${conds})`);
    } else {
      parts.push(`emp_seqno IN (SELECT emp_seqno FROM job_postings WHERE ${conds})`);
    }
    IT_KEYWORDS.forEach((kw) => params.push('%' + kw + '%'));
  }
  return { parts, params };
}

// parts → 'WHERE a AND b' (빈 경우 '')
function joinWhere(parts) {
  return parts.length ? 'WHERE ' + parts.join(' AND ') : '';
}

// ---------- app ----------
function createApp() {
  db.init();
  const app = express();
  app.use(express.json());

  // 정적 파일 (프론트) — public/index.html 이 루트로 열림
  app.use(express.static(path.join(__dirname, 'public')));

  // ----- /api/summary : 홈 요약 (Step 5.5: 4개 필터 반영) -----
  app.get('/api/summary', requireValidPeriod, (req, res) => {
    const fp = buildFilters(req.query, { base: 'postings' });
    const fr = buildFilters(req.query, { base: 'recruits' });

    const totalPostings = db.getDb()
      .prepare(`SELECT COUNT(*) c FROM job_postings ${joinWhere(fp.parts)}`).get(...fp.params).c;
    const totalRecruits = db.getDb()
      .prepare(`SELECT COUNT(*) c FROM job_recruits ${joinWhere(fr.parts)}`).get(...fr.params).c;

    // lastRun 은 수집 이력 → 필터와 무관 (항상 최근 수집 1건)
    const lastRun = db.getDb()
      .prepare(`SELECT run_at, fetched_count, status FROM collection_logs ORDER BY id DESC LIMIT 1`).get();

    // 신입/경력 가능 모집직무 수 (필터 반영)
    const newCount = db.getDb()
      .prepare(`SELECT COUNT(*) c FROM job_recruits WHERE career LIKE '%신입%' ${fr.parts.length ? 'AND ' + fr.parts.join(' AND ') : ''}`)
      .get(...fr.params).c;
    const expCount = db.getDb()
      .prepare(`SELECT COUNT(*) c FROM job_recruits WHERE career LIKE '%경력%' ${fr.parts.length ? 'AND ' + fr.parts.join(' AND ') : ''}`)
      .get(...fr.params).c;

    res.json({
      totalPostings, totalRecruits, lastRun, newCount, expCount,
      filtered: fp.parts.length > 0,
    });
  });

  // ----- /api/trends/category : 직종별 (category는 자기 자신 → 제외) -----
  app.get('/api/trends/category', requireValidPeriod, (req, res) => {
    const f = buildFilters(req.query, { base: 'postings', exclude: ['category'] });
    const rows = db.getDb()
      .prepare(`SELECT job_category name, COUNT(*) c FROM job_postings
                WHERE job_category IS NOT NULL ${f.parts.length ? 'AND ' + f.parts.join(' AND ') : ''}
                GROUP BY job_category ORDER BY c DESC`)
      .all(...f.params);
    res.json(rows);
  });

  // ----- /api/trends/region : 지역별 (모집직무 기준) -----
  // region 미선택 → 시·도 분포 / region 선택 → 해당 시·도 내 시·군·구 하위 분포(드릴다운)
  app.get('/api/trends/region', requireValidPeriod, (req, res) => {
    const { region } = req.query;
    // region 자체는 여기서 직접 처리 → 빌더에서는 제외
    const f = buildFilters(req.query, { base: 'recruits', exclude: ['region'] });

    let sql, params;
    if (region) {
      // 하위 분포: "서울 강남구" → 두번째 토큰(강남구) 추출.
      // 시/도 단독 행("서울" 처럼 공백 없음)은 구·군 정보가 없으므로 '상세 미기재'로 묶어
      // 시/도 라벨이 하위 분포에 노이즈로 섞이지 않게 함.
      sql = `SELECT
              CASE WHEN instr(work_region,' ')>0
                THEN substr(work_region, instr(work_region,' ')+1)
                ELSE '상세 미기재' END name,
              COUNT(*) c, SUM(head_count) persons
            FROM job_recruits
            WHERE work_region IS NOT NULL AND work_region LIKE ?
            ${f.parts.length ? 'AND ' + f.parts.join(' AND ') : ''}
            GROUP BY name ORDER BY c DESC`;
      params = [region + '%', ...f.params];
    } else {
      // 시·도 분포: "서울 강남구" → 첫 토큰(서울) 추출
      sql = `SELECT
              CASE WHEN instr(work_region,' ')>0 THEN substr(work_region,1,instr(work_region,' ')-1)
                ELSE work_region END name,
              COUNT(*) c, SUM(head_count) persons
            FROM job_recruits
            WHERE work_region IS NOT NULL ${f.parts.length ? 'AND ' + f.parts.join(' AND ') : ''}
            GROUP BY name ORDER BY c DESC`;
      params = f.params;
    }
    const rows = db.getDb().prepare(sql).all(...params);
    res.json(rows);
  });

  // ----- /api/trends/experience : 경력/학력 분포 (Step 5.5: 4개 필터 전부) -----
  app.get('/api/trends/experience', requireValidPeriod, (req, res) => {
    const f = buildFilters(req.query, { base: 'recruits' });
    const whereMore = f.parts.length ? 'AND ' + f.parts.join(' AND ') : '';

    // career 빈값(NULL/'')도 '미입력' 버킷으로 포함해 전체 합이 맞도록
    const rows = db.getDb()
      .prepare(`SELECT career raw, COUNT(*) c FROM job_recruits
                WHERE 1=1 ${whereMore} GROUP BY career`).all(...f.params);
    const buckets = {};
    for (const r of rows) {
      const b = careerBucket(r.raw);
      buckets[b] = (buckets[b] || 0) + r.c;
    }
    const career = Object.entries(buckets).map(([name, c]) => ({ name, c })).sort((a, b) => b.c - a.c);

    // education 빈값은 '학력무관' 으로 표시. 상위 7개 + '기타' 묶음 = 총 8카테고리로
    // 합계가 필터 후 모집직무 수와 정확히 일치하도록 함 (정합성 검증 통과)
    const edu = db.getDb()
      .prepare(`WITH ranked AS (
                  SELECT COALESCE(NULLIF(TRIM(education), ''), '학력무관') raw, COUNT(*) c
                  FROM job_recruits WHERE 1=1 ${whereMore} GROUP BY raw
                ),
                top AS (
                  SELECT raw, c FROM ranked ORDER BY c DESC LIMIT 7
                )
                SELECT raw, c FROM top
                UNION ALL
                SELECT '기타' raw, COALESCE((SELECT SUM(c) FROM ranked
                  WHERE raw NOT IN (SELECT raw FROM top)), 0) c
                ORDER BY c DESC`).all(...f.params);
    res.json({ career, education: edu });
  });

  // ----- /api/trends/type : 고용형태/기업구분 -----
  // 고용형태(employmentType)는 4개 필터 모두 반영. 기업구분(companyType)은
  // 필터 옵션(드롭다운) 원본용이라 항상 전체 기준으로 반환 (연쇄갱신 범위 밖).
  app.get('/api/trends/type', requireValidPeriod, (req, res) => {
    const f = buildFilters(req.query, { base: 'postings' });
    const whereMore = f.parts.length ? 'AND ' + f.parts.join(' AND ') : '';

    // employment_type 은 복합 파이프값("정규직|기간제|기타") → 정규화 버킷으로 합산
    const empRows = db.getDb()
      .prepare(`SELECT employment_type raw, COUNT(*) c FROM job_postings
                WHERE employment_type IS NOT NULL AND employment_type != ''
                ${whereMore}
                GROUP BY employment_type`).all(...f.params);
    const empBuckets = {};
    for (const r of empRows) {
      const b = employmentBucket(r.raw);
      empBuckets[b] = (empBuckets[b] || 0) + r.c;
    }
    const employmentType = Object.entries(empBuckets)
      .map(([name, c]) => ({ name, c })).sort((a, b) => b.c - a.c);

    // company_type 빈값은 '기업구분 미입력' (옵션 채우기용 — 전체 기준)
    const companyType = db.getDb()
      .prepare(`SELECT COALESCE(NULLIF(TRIM(company_type), ''), '기업구분 미입력') name, COUNT(*) c
                FROM job_postings GROUP BY name ORDER BY c DESC`).all();
    res.json({ employmentType, companyType });
  });

  // ----- /api/postings : 공고 목록 (필터 + 페이징) -----
  app.get('/api/postings', requireValidPeriod, (req, res) => {
    const { career, eduNone, regular } = req.query;
    const { limit, offset } = paginate(req.query.page, req.query.size);

    // buildFilters(period/company/region/category/itOnly) + 맞춤공고 전용(career/eduNone/regular)
    const f = buildFilters(req.query, { base: 'postings' });
    const parts = [...f.parts];
    const params = [...f.params];
    if (career) { parts.push('emp_seqno IN (SELECT emp_seqno FROM job_recruits WHERE career LIKE ?)'); params.push('%' + career + '%'); }
    // 학력무관(미기재) 모집직무가 있는 공고 (Step 6 맞춤공고)
    if (eduNone) { parts.push('emp_seqno IN (SELECT emp_seqno FROM job_recruits WHERE education IS NULL OR TRIM(education) = ?)'); params.push(''); }
    // 정규직(전환형 포함) 공고 (Step 6 맞춤공고)
    if (regular) { parts.push('(employment_type LIKE ? OR employment_type LIKE ?)'); params.push('%정규직%', '%전환형%'); }

    const whereSql = joinWhere(parts);
    const rows = db.getDb()
      .prepare(`SELECT emp_seqno, title, company_name, company_type, employment_type,
                       job_category, start_dt, end_dt, source_url, logo_url
                FROM job_postings ${whereSql}
                ORDER BY start_dt DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);
    const total = db.getDb()
      .prepare(`SELECT COUNT(*) c FROM job_postings ${whereSql}`).get(...params).c;
    res.json({ total, page: Math.floor(offset / limit) + 1, size: limit, items: rows });
  });

  // ----- /api/postings/:id : 공고 상세 -----
  app.get('/api/postings/:id', (req, res) => {
    const posting = db.getDb()
      .prepare(`SELECT * FROM job_postings WHERE emp_seqno = ?`).get(req.params.id);
    if (!posting) return res.status(404).json({ error: '공고를 찾을 수 없습니다' });
    const recruits = db.getDb()
      .prepare(`SELECT recruit_name, job_desc, work_region, career, education, cert_etc, head_count, selection, memo
                FROM job_recruits WHERE emp_seqno = ?`).all(req.params.id);
    // 배열 JSON 필드 파싱
    for (const k of ['jobs_json', 'selection_json', 'attach_files_json']) {
      try { posting[k] = posting[k] ? JSON.parse(posting[k]) : null; } catch (_) {}
    }
    res.json({ posting, recruits });
  });

  // ----- /api/postings/:id/goto : 워크넷 원본으로 리다이렉트 -----
  app.get('/api/postings/:id/goto', (req, res) => {
    const row = db.getDb().prepare(`SELECT source_url FROM job_postings WHERE emp_seqno = ?`).get(req.params.id);
    if (!row || !row.source_url) return res.status(404).json({ error: '이동할 URL이 없습니다' });
    res.redirect(row.source_url);
  });

  // ----- /api/insight/weekly : 트렌드 요약 텍스트 (Step 5.5: 4개 필터 반영) -----
  app.get('/api/insight/weekly', requireValidPeriod, (req, res) => {
    const f = buildFilters(req.query, { base: 'postings' });
    const fr = buildFilters(req.query, { base: 'recruits' });
    const whereMore = f.parts.length ? 'AND ' + f.parts.join(' AND ') : '';
    const whereMoreR = fr.parts.length ? 'AND ' + fr.parts.join(' AND ') : '';

    const total = db.getDb()
      .prepare(`SELECT COUNT(*) c FROM job_postings WHERE 1=1 ${whereMore}`).get(...f.params).c;
    const totalRecruits = db.getDb()
      .prepare(`SELECT COUNT(*) c FROM job_recruits WHERE 1=1 ${whereMoreR}`).get(...fr.params).c;

    // topCat: category 제외 (자기 자신 수렴 방지)
    const fc = buildFilters(req.query, { base: 'postings', exclude: ['category'] });
    const whereMoreC = fc.parts.length ? 'AND ' + fc.parts.join(' AND ') : '';
    const topCat = db.getDb()
      .prepare(`SELECT job_category name, COUNT(*) c FROM job_postings
                WHERE job_category IS NOT NULL ${whereMoreC}
                GROUP BY job_category ORDER BY c DESC LIMIT 1`).get(...fc.params);

    // topReg: region 제외
    const freg = buildFilters(req.query, { base: 'recruits', exclude: ['region'] });
    const whereMoreReg = freg.parts.length ? 'AND ' + freg.parts.join(' AND ') : '';
    const topReg = db.getDb()
      .prepare(`SELECT work_region name, COUNT(*) c FROM job_recruits
                WHERE work_region IS NOT NULL ${whereMoreReg}
                GROUP BY work_region ORDER BY c DESC LIMIT 1`).get(...freg.params);

    const newCount = db.getDb()
      .prepare(`SELECT COUNT(*) c FROM job_recruits WHERE career LIKE '%신입%' ${whereMoreR}`).get(...fr.params).c;
    const expCount = db.getDb()
      .prepare(`SELECT COUNT(*) c FROM job_recruits WHERE career LIKE '%경력%' ${whereMoreR}`).get(...fr.params).c;
    // 정규직(전환형 포함) 비중 — 공고 단위
    const regularCount = db.getDb()
      .prepare(`SELECT COUNT(*) c FROM job_postings
                WHERE (employment_type LIKE '%정규직%' OR employment_type LIKE '%전환형%') ${whereMore}`)
      .get(...f.params).c;

    const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
    const scope = `${f.parts.length ? '선택 조건' : '전체'}`;
    const lines = [
      `${scope} 기준 채용공고는 총 ${total}건(모집직무 ${totalRecruits}개)입니다.`,
      topCat ? `가장 수요가 많은 직종은 "${topCat.name}"로, 약 ${pct(topCat.c, total)}%(${topCat.c}건)를 차지합니다.` : null,
      topReg ? `근무지역은 "${topReg.name}" 인근의 채용이 가장 많습니다.` : null,
      `채용 형태는 정규직(전환형 포함)이 약 ${pct(regularCount, total)}%(${regularCount}건)로 주를 이룹니다.`,
      `신입 지원 가능은 ${newCount}건, 경력 대상은 ${expCount}건으로, ` +
        (newCount >= expCount
          ? '현재 신입 채용 비중이 더 높은 편입니다.'
          : '경력직 수요가 더 많은 편입니다.'),
    ].filter(Boolean);
    // 데이터 출처/한계 — 과대 해석 방지 (계획서 11절)
    lines.push('※ 본 요약은 워크넷 등록 공고 기준이며, 전체 채용시장을 대변하지 않습니다.');

    res.json({
      insight: lines.join(' '),
      stats: { total, totalRecruits, topCategory: topCat, topRegion: topReg,
               newCount, expCount, regularCount, regularPct: pct(regularCount, total) },
    });
  });

  // ----- /api/insight/trend : 과거 vs 현재 직종 증감 (집계 스냅샷 기반) -----
  // 매 수집 시점의 직종 집계 스냅샷을 비교해 흐름을 반환.
  //   ?itOnly=1 : IT 직군(job_category 가 IT_KEYWORDS 매칭)만 추려서 집계.
  //               인사이트 페이지가 IT 중심이므로 G섹션은 기본 itOnly 로 호출.
  //   timeline : 시계열 (공고 수 추이 — itOnly 시 IT 공고 합계)
  //   diff     : 최신 2개 스냅샷의 직종별 증감 (▲증가/▼감소). pct(%) 포함.
  //   current/previous : 비교 기준 스냅샷 메타 (itOnly 시 IT 합계)
  app.get('/api/insight/trend', (req, res) => {
    const snaps = db.recentSnapshots(30);
    if (!snaps.length) {
      return res.json({ timeline: [], diff: [], current: null, previous: null, unit: '모집직무', scope: req.query.itOnly ? 'it' : 'all' });
    }

    // itOnly=true 면 IT 키워드 매칭 직종만, 아니면 전체 직종 집합
    const itOnly = !!req.query.itOnly;
    const isIT = (name) => IT_KEYWORDS.some((kw) => String(name).includes(kw));
    const filterCats = (m) => itOnly
      ? Object.fromEntries(Object.entries(m).filter(([k]) => isIT(k)))
      : m;

    // 직종 카운트 맵 → 합계
    const sumCats = (m) => Object.values(m).reduce((a, b) => a + (Number(b) || 0), 0);

    // 스냅샷 raw(전체) → IT 필터링 맵 + IT 합계(total) 로 가공
    // 단위 통일: recruit_counts(모집직무 단위) 우선, 과거 스냅샷은 category_counts(공고 단위)로 fallback.
    //   → C파트(경력·학력, 모집직무 단위)와 같은 단위로 맞춰 숫자가 일치함.
    const projected = snaps.map((s) => {
      const recruitRaw = JSON.parse(s.recruit_counts || '{}');
      const hasRecruit = Object.keys(recruitRaw).length > 0;
      const raw = hasRecruit ? recruitRaw : JSON.parse(s.category_counts || '{}');
      const cats = filterCats(raw); // itOnly 면 IT/개발 만, 아니면 전체 그대로
      const unit = hasRecruit ? '모집직무' : '공고'; // fallback 스냅샷은 공고 단위 (혼선 방지 표기용)
      return { run_at: s.run_at, total: itOnly ? sumCats(cats) : s.total, cats, unit };
    });

    const timeline = projected.map((s) => ({ run_at: s.run_at, total: s.total }));

    // 최신 2개로 직종별 diff 계산 (필터링된 맵 기준)
    const prev = projected[projected.length - 2] || null;
    const curr = projected[projected.length - 1];
    // 단위가 섞인 전환기(공고 단위 fallback ↔ 모집직무 단위)엔 diff가 무의미 → 비교 skip
    const unitMismatch = !!(prev && prev.unit !== curr.unit);
    let diff = [];
    if (prev && !unitMismatch) {
      const names = new Set([...Object.keys(prev.cats), ...Object.keys(curr.cats)]);
      diff = [...names].map((name) => {
        const p = prev.cats[name] || 0;
        const c = curr.cats[name] || 0;
        const delta = c - p;
        const pct = p > 0 ? Math.round((delta / p) * 100) : (c > 0 ? 100 : 0); // 전회 0 → 신규 100%
        return { name, prev: p, curr: c, delta, pct };
      }).filter((r) => r.delta !== 0)               // 변화 있는 직종만
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)); // 변화 큰 순
    }

    const deltas = diff.map((d) => d.delta);
    const up = deltas.filter((d) => d > 0).reduce((a, b) => a + b, 0);
    const down = deltas.filter((d) => d < 0).reduce((a, b) => a + b, 0);
    const unit = curr ? curr.unit : '모집직무'; // 현재 기준 단위 (프론트 표기용)

    res.json({
      timeline,
      diff,
      current: { run_at: curr.run_at, total: curr.total },
      previous: prev ? { run_at: prev.run_at, total: prev.total } : null,
      hasCompare: !!prev && !unitMismatch,
      unit,                                        // '모집직무' | '공고' (fallback 시)
      scope: itOnly ? 'it' : 'all',
      summary: { upCount: deltas.filter((d) => d > 0).length,
                 downCount: deltas.filter((d) => d < 0).length,
                 netDelta: up + down, hasCompare: !!prev && !unitMismatch },
    });
  });

  // ----- /api/admin/collect : 수동 수집 트리거 -----
  app.post('/api/admin/collect', async (req, res) => {
    try {
      const limit = Number(req.query.limit) || undefined;
      // 비동기로 돌리고 즉시 응답 (수집은 수십 초~분 단위)
      res.json({ message: '수집을 시작했습니다', limit });
      collector.run({ limit }).catch((e) => console.error('[admin/collect]', e.message));
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: '수집 시작 실패' });
    }
  });

  /* ============================================================
     Step 8: 회원 인증 API — 회원가입 / 로그인 / 로그아웃 / 내 정보
     ============================================================ */

  // 로그인 ID 규칙: 3~30자, 영문/숫자/._- 만 허용 (docs/step8-auth-plan.md 4절)
  const LOGIN_ID_RE = /^[A-Za-z0-9._-]{3,30}$/;

  // ----- 회원가입 (이름 / ID / 비밀번호 3필드) -----
  app.post('/api/auth/register', (req, res) => {
    const { name, user_id: rawId, password } = req.body || {};
    const userId = String(rawId || '').trim();

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: '이름을 입력하세요' });
    }
    if (!LOGIN_ID_RE.test(userId)) {
      return res.status(400).json({ error: '아이디는 영문/숫자/._- 조합 3~30자여야 합니다' });
    }
    if (!password || String(password).length < 6) {
      return res.status(400).json({ error: '비밀번호는 6자 이상이어야 합니다' });
    }
    if (db.getUserByLoginId(userId)) {
      return res.status(409).json({ error: '이미 사용 중인 아이디입니다' });
    }

    const user = db.createUser({
      name: String(name).trim(),
      userId,
      passwordHash: auth.hashPassword(password),
    });

    // 가입 성공 → 자동 로그인 (세션 발급)
    const session = auth.issueSession(user.id);
    res.setHeader('Set-Cookie', auth.sessionCookie(session.token, session.expiresAt));
    res.status(201).json({ id: user.id, name: user.name, user_id: user.user_id });
  });

  // ----- 로그인 (아이디 + 비밀번호) -----
  app.post('/api/auth/login', (req, res) => {
    const { user_id: rawId, password } = req.body || {};
    const userId = String(rawId || '').trim();
    const user = userId ? db.getUserByLoginId(userId) : null;

    // 사용자 열거 방지: ID 불일치와 PW 불일치를 구분하지 않는다
    if (!user || !auth.verifyPassword(password || '', user.password_hash)) {
      return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다' });
    }

    const session = auth.issueSession(user.id);
    res.setHeader('Set-Cookie', auth.sessionCookie(session.token, session.expiresAt));
    res.json({ id: user.id, name: user.name, user_id: user.user_id });
  });

  // ----- 로그아웃 -----
  app.post('/api/auth/logout', (req, res) => {
    auth.revokeSession(req);
    res.setHeader('Set-Cookie', auth.clearCookie());
    res.json({ ok: true });
  });

  // ----- 내 정보 (페이지 새로고침 시 로그인 상태 복원용) -----
  app.get('/api/auth/me', (req, res) => {
    const user = auth.getUserFromRequest(req);
    if (!user) return res.status(401).json({ error: '로그인이 필요합니다' });
    res.json({ id: user.id, name: user.name, user_id: user.user_id });
  });

  // ----- 세션 수명 연장 (Heartbeat) ------
  app.post('/api/auth/heartbeat', (req, res) => {
    const success = auth.extendSession(req);
    if (success) {
      res.json({ ok: true, message: '세션이 연장되었습니다.' });
    } else {
      res.status(401).json({ error: '토큰이 없거나 만료되었습니다.' });
    }
  });

  /* ============================================================
     Step 7: 이력서 관리 API — 다중 프로필 + AI 자기소개서
     Step 8: 전 라우트 requireAuth + 소유자(req.user.id) 스코핑
     → 미로그인 401, 타인 리소스 404 (개인정보 격리)
     ============================================================ */

  // ----- 타겟 직무 목록 (워크넷 수집 데이터 연동 — 이력서 페이지 전용) -----
  // job_postings.job_category 를 빈도순으로 반환 (자소서 직무 선택 드롭다운용)
  app.get('/api/target-jobs', auth.requireAuth, (_req, res) => {
    const rows = db.getDb()
      .prepare(`SELECT job_category name, COUNT(*) c
                FROM job_postings WHERE job_category IS NOT NULL
                GROUP BY job_category ORDER BY c DESC LIMIT 100`)
      .all();
    res.json(rows);
  });

  // ----- 프로필 CRUD -----
  // 프로필 body 정규화: emphasis(항목별 강조 포인트)는 객체·문자열 모두 JSON 문자열로 통일.
  // (DB엔 JSON 텍스트로 저장, ai.js buildPrompt 에서 파싱해 사용)
  function normalizeProfileBody(body) {
    const b = { ...(body || {}) };
    let em = b.emphasis;
    if (em === undefined || em === null || em === '') {
      b.emphasis = null;
    } else if (typeof em === 'object') {
      // 빈 값만 있는 객체면 null 로 저장 (깨끗한 데이터)
      const cleaned = {};
      for (const [k, v] of Object.entries(em)) {
        if (typeof v === 'string' && v.trim()) cleaned[k] = v.trim();
      }
      b.emphasis = Object.keys(cleaned).length ? JSON.stringify(cleaned) : null;
    }
    // 이미 문자열이면 그대로 (프론트에서 JSON.stringify 한 값)
    return b;
  }
  app.get('/api/profiles', auth.requireAuth, (req, res) => {
    res.json(db.listProfiles(req.user.id));
  });

  app.get('/api/profiles/:id', auth.requireAuth, (req, res) => {
    const p = db.getProfile(Number(req.params.id), req.user.id);
    if (!p) return res.status(404).json({ error: '프로필이 없습니다' });
    const letters = db.listCoverLetters(p.id, req.user.id);
    res.json({ ...p, coverLetters: letters });
  });

  app.post('/api/profiles', auth.requireAuth, (req, res) => {
    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: '프로필명(name)은 필수입니다' });
    res.status(201).json(db.createProfile(req.user.id, normalizeProfileBody(req.body)));
  });

  app.put('/api/profiles/:id', auth.requireAuth, (req, res) => {
    const p = db.updateProfile(Number(req.params.id), req.user.id, normalizeProfileBody(req.body));
    if (!p) return res.status(404).json({ error: '프로필이 없습니다' });
    res.json(p);
  });

  app.delete('/api/profiles/:id', auth.requireAuth, (req, res) => {
    const n = db.deleteProfile(Number(req.params.id), req.user.id);
    if (!n) return res.status(404).json({ error: '프로필이 없습니다' });
    res.json({ deleted: n });
  });

  // ----- 자소서 CRUD -----
  app.get('/api/cover-letters', auth.requireAuth, (req, res) => {
    const pid = req.query.profile_id ? Number(req.query.profile_id) : null;
    res.json(db.listCoverLetters(pid, req.user.id));
  });

  app.get('/api/cover-letters/:id', auth.requireAuth, (req, res) => {
    const c = db.getCoverLetter(Number(req.params.id), req.user.id);
    if (!c) return res.status(404).json({ error: '자소서가 없습니다' });
    res.json(c);
  });

  app.post('/api/cover-letters', auth.requireAuth, (req, res) => {
    const { profile_id } = req.body || {};
    if (!profile_id) return res.status(400).json({ error: 'profile_id는 필수입니다' });
    const c = db.createCoverLetter(req.user.id, req.body);
    if (!c) return res.status(404).json({ error: '해당 프로필이 없습니다' });
    res.status(201).json(c);
  });

  app.put('/api/cover-letters/:id', auth.requireAuth, (req, res) => {
    const c = db.updateCoverLetter(Number(req.params.id), req.user.id, req.body || {});
    if (!c) return res.status(404).json({ error: '자소서가 없습니다' });
    res.json(c);
  });

  app.delete('/api/cover-letters/:id', auth.requireAuth, (req, res) => {
    const n = db.deleteCoverLetter(Number(req.params.id), req.user.id);
    if (!n) return res.status(404).json({ error: '자소서가 없습니다' });
    res.json({ deleted: n });
  });

  /* ============================================================
     Step 9: 채용공고 요구사항 매칭 API — 4계층 소스 (db → url → paste → company)
     ============================================================ */

  // ----- 1차: DB에서 회사명으로 공고 검색 -----
  // 에디터의 "DB에서 찾기" 탭 — 실제 수집 공고(940건)에서 요구사항을 가져온다.
  app.get('/api/companies/search', auth.requireAuth, (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json([]); // 2자 미만은 결과 없음 (전체 스캔 방지)
    res.json(db.searchPostingsByCompany(q));
  });

  // ----- 1차: 선택한 DB 공고 → 요구사항 번들 -----
  // job_desc/cert_etc 등에서 주요업무·자격·우대를 정리해 반환 (AI 호출 없음 — 즉시)
  app.get('/api/postings/:id/requirements', auth.requireAuth, (req, res) => {
    const bundle = db.getPostingRequirements(req.params.id);
    if (!bundle) return res.status(404).json({ error: '공고를 찾을 수 없습니다' });
    res.json(bundle);
  });

  // ----- 2차: 공고 URL → 요구사항 번들 -----
  // 우선순위: ① 직접 스크레이핑(사람인 — AI 재해석 없이 원문 그대로, 즉시)
  //          ② Gemini url_context (그 외 사이트 — AI 접근 허용 분석)
  // 차단 도메인(원티드)은 400 + 붙여넣기 안내. 접근 실패는 422 + 붙여넣기 안내.
  app.post('/api/ai/fetch-url', auth.requireAuth, async (req, res) => {
    const { url } = req.body || {};
    if (!url || !/^https?:\/\//i.test(String(url))) {
      return res.status(400).json({ error: 'http(s) 로 시작하는 공고 URL을 입력하세요' });
    }
    const target = String(url).trim();

    // ① 직접 읽기 지원 사이트(사람인 등) — HTML 원문 파싱 (AI 호출 없음)
    if (scraper.isDirectSupported(target)) {
      try {
        const r = await scraper.scrapeUrlRequirements(target);
        return res.json({ bundle: r.bundle, via: 'scraper' });
      } catch (e) {
        // ★ 과부하(AI 분류 폴백까지 포화) → 일시 장애 안내 (다른 경로와 동일하게 503 + code)
        if (e.code === 'AI_BUSY') {
          console.error('[fetch-url:scraper] AI 과부하:', e.cause || e.message);
          return res.status(503).json({ error: e.message, code: 'AI_BUSY' });
        }
        // 파싱 실패(마감/삭제/차단) → 붙여넣기 폴백 안내 (프론트가 3차 탭으로 전환)
        console.error('[fetch-url:scraper]', e.cause || e.message);
        return res.status(422).json({ error: e.message, fallback: 'paste' });
      }
    }

    // ② 그 외 사이트 — Gemini url_context 로 분석
    try {
      const r = await ai.fetchUrlRequirements(target);
      res.json({ bundle: r.bundle, model: r.model });
    } catch (e) {
      // AI_URL_BLOCKED/AI_URL_FAIL → 붙여넣기 폴백 안내 (프론트가 3차 탭으로 전환)
      if (e.code === 'AI_URL_BLOCKED') return res.status(400).json({ error: e.message, fallback: 'paste' });
      if (e.code === 'AI_URL_FAIL' || e.code === 'AI_URL_PARSE') {
        return res.status(422).json({ error: e.message, fallback: 'paste' });
      }
      // ★ 과부하(폴백까지 실패) → 일시 장애 안내 (프론트가 "잠시 후 다시 시도" 표시)
      if (e.code === 'AI_BUSY') {
        console.error('[fetch-url] AI 과부하:', e.cause || e.message);
        return res.status(503).json({ error: e.message, code: 'AI_BUSY' });
      }
      console.error('[fetch-url]', e.message);
      const status = e.code === 'AI_NO_KEY' ? 503 : 500;
      res.status(status).json({ error: e.message });
    }
  });

  // ----- 3차: 붙여넣은 공고 원문 → 2단(PIPE 정제 → QUALITY 구조화) 분석 -----
  app.post('/api/ai/analyze-requirements', auth.requireAuth, async (req, res) => {
    const { text } = req.body || {};
    if (!text || String(text).trim().length < 30) {
      return res.status(400).json({ error: '공고 내용이 너무 짧습니다. 모집분야와 자격요건을 포함해 붙여넣어 주세요' });
    }
    if (String(text).length > ai.MAX_PASTE_CHARS + 1000) {
      return res.status(400).json({ error: `내용이 너무 깁니다. ${ai.MAX_PASTE_CHARS}자 이하로 붙여넣어 주세요` });
    }
    try {
      const r = await ai.analyzeRequirementsText(text);
      res.json({ bundle: r.bundle, models: r.models, cleanedPreview: r.cleanedPreview });
    } catch (e) {
      console.error('[analyze-requirements]', e.message);
      if (e.code === 'AI_BUSY') {
        console.error('[analyze-requirements] AI 과부하:', e.cause || '');
        return res.status(503).json({ error: e.message, code: 'AI_BUSY' });
      }
      const status = e.code === 'AI_NO_KEY' ? 503 : (e.code === 'AI_PASTE_SHORT' || e.code === 'AI_PASTE_PARSE' ? 400 : 500);
      res.status(status).json({ error: e.message });
    }
  });

  // ----- AI 자소서 생성 (5항목 초안) -----
  // 프로필 + 타겟 직무 → Gemini 가 5항목 작성. 실패 시 generation_logs 기록 + 에러 응답.
  // Step 8: ownerId 스코프 — 타인 자소서는 404 (생성 로직 재사용을 위해 인자로 전달)
  async function generateLetter(coverLetterId, ownerId, isRegenerate) {
    const cl = db.getCoverLetter(coverLetterId, ownerId);
    if (!cl) return { status: 404, body: { error: '자소서가 없습니다' } };
    const profile = db.getProfile(cl.profile_id, ownerId);
    if (!profile) return { status: 404, body: { error: '연결된 프로필이 없습니다' } };

    // 타겟 직무의 채용 요건 요약 (워크넷 데이터에서 해당 직종 경력/학력 분포)
    let jobContext = '';
    if (cl.target_job) {
      const recruits = db.getDb()
        .prepare(`SELECT r.career, r.education FROM job_recruits r
                  JOIN job_postings p ON r.emp_seqno = p.emp_seqno
                  WHERE p.job_category = ?`).all(cl.target_job);
      if (recruits.length) {
        const careers = recruits.map((r) => r.career).filter(Boolean);
        const edus = recruits.map((r) => r.education).filter(Boolean);
        const topCareer = topValue(careers);
        const topEdu = topValue(edus);
        jobContext = `모집직무 ${recruits.length}건 기준 주요 경력 ${topCareer || '무관'}, 학력 ${topEdu || '무관'}`;
      }
    }

    // ★ Step 9: 저장된 요구사항 번들(req_json)이 있으면 근거로 주입
    // 소스 무관(db/url/paste) — 회사 일반 지식보다 실제 공고 요건을 우선 반영
    let requirements = null;
    if (cl.req_json) {
      try { requirements = JSON.parse(cl.req_json); } catch { requirements = null; }
    }

    const prompt = ai.buildPrompt({
      profile, targetJob: cl.target_job, jobContext, company: cl.company,
      emphasis: profile.emphasis, requirements,
    });
    try {
      const result = await ai.generate(prompt);
      // 생성된 5항목 저장
      const saved = db.updateCoverLetter(cl.id, ownerId, {
        motivation: result.motivation, growth: result.growth, strength: result.strength,
        career: result.career, vision: result.vision,
      });
      db.logGeneration({
        cover_letter_id: cl.id, action: isRegenerate ? 'regenerate' : 'generate',
        model: result._meta.model, target_job: cl.target_job,
        status: 'success', tokens: result._meta.tokens,
      });
      return { status: 200, body: saved };
    } catch (e) {
      console.error(`[cover-letter ${cl.id} ${isRegenerate ? 'regenerate' : 'generate'}]`, e.message);
      db.logGeneration({
        cover_letter_id: cl.id, action: isRegenerate ? 'regenerate' : 'generate',
        model: ai.DEFAULT_MODEL, target_job: cl.target_job,
        status: 'fail', error: e.message,
      });
      // ★ 과부하는 일시 장애 — 프론트에 code 를 싣어 "잠시 후 다시 시도" 안내
      if (e.code === 'AI_BUSY') return { status: 503, body: { error: e.message, code: 'AI_BUSY' } };
      const status = e.code === 'AI_NO_KEY' ? 503 : 500;
      return { status, body: { error: e.message } };
    }
  }

  // 빈도最高的 값 추출 (직무 요건 요약용 헬퍼)
  function topValue(arr) {
    if (!arr.length) return null;
    const freq = {};
    for (const v of arr) { freq[v] = (freq[v] || 0) + 1; }
    return Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
  }

  app.post('/api/cover-letters/:id/generate', auth.requireAuth, async (req, res) => {
    const r = await generateLetter(Number(req.params.id), req.user.id, false);
    res.status(r.status).json(r.body);
  });

  // 직무 변경 재생성 ★ — body.target_job 로 직무 바꿔 같은 프로필로 재생성
  app.post('/api/cover-letters/:id/regenerate', auth.requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    const cl = db.getCoverLetter(id, req.user.id);
    if (!cl) return res.status(404).json({ error: '자소서가 없습니다' });
    // target_job 이 주어지면 먼저 갱신 (직무 변경), 아니면 기존 직무 유지
    if (req.body && req.body.target_job !== undefined) {
      db.updateCoverLetter(id, req.user.id, { target_job: req.body.target_job });
    }
    const r = await generateLetter(id, req.user.id, true);
    res.status(r.status).json(r.body);
  });

  // ----- 에러 표준화 -----
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했습니다' });
  });

  return app;
}

// ---------- 기동 ----------
if (require.main === module) {
  const app = createApp();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`JobMarketRadar 서버 실행: http://0.0.0.0:${PORT}`);
    console.log(`  데이터: 공고 ${db.countPostings()}건 / 모집직무 ${db.countRecruits()}건`);
  });

  // cron 자동 수집 (1일 2회) — backfill 모드로 상세까지 모두 갱신.
  // 서버가 계속 떠 있으면 09:00·21:00 마다 자동으로 전체 재수집(목록+상세) + 스냅샷 저장.
  if (cron.validate(CRON_SCHEDULE)) {
    cron.schedule(CRON_SCHEDULE, () => {
      console.log(`[cron ${CRON_SCHEDULE}] 자동 수집(backfill) 시작`, new Date().toISOString());
      collector.run({ backfill: true }).catch((e) => console.error('[cron]', e.message));
    });
    console.log(`  자동 수집 스케줄 등록: ${CRON_SCHEDULE} (backfill 모드 — 상세 포함 전체 갱신)`);
  } else {
    console.warn(`  ⚠️ CRON_SCHEDULE("${CRON_SCHEDULE}")이 잘못됨 — 자동수집 비활성화`);
  }
}

module.exports = { createApp };
