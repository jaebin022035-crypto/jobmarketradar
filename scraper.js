// scraper.js — 채용공고 사이트 직접 스크레이퍼 (Step 9.5: URL 원문 그대로 가져오기)
// ------------------------------------------------------------
// 사람인 등 AI 봇은 차단하지만 일반 브라우저 요청은 허용하는 사이트 대상.
// Gemini url_context 를 거치지 않고 서버에서 직접 HTML 을 받아
// 공고 원문(주요업무/자격요건/우대사항/근무조건/채용절차)을 **글자 그대로** 추출한다.
//   - AI 재해석·요약·번역 개입 없음 → 원문 문장 보존
//   - 사이트마다 마크업이 다를 수 있어 **여러 후보 구조를 순차 시도** (parseSaramin)
//   - 실패 시 AI_URL_FAIL → 3차 붙여넣기 폴백으로 연결
// 테스트 fixture: scripts/fixtures/saramin-54211558.html
// ------------------------------------------------------------

'use strict';

const axios = require('axios');
// 아래 지시 시에만 순환 참조 회피용 lazy require (scraper ← ai): AI 폴백 파이프라인 재사용
let aiModule = null;
function getAi() {
  if (!aiModule) aiModule = require('./ai');
  return aiModule;
}

// ---------- 설정 ----------
const FETCH_TIMEOUT_MS = 20000;
const MAX_HTML_BYTES = 3 * 1024 * 1024; // 3MB — 과대 응답 방지

// 직접 읽기를 지원하는 사이트 (host → 파서)
const SITES = {
  'saramin.co.kr': parseSaramin,
};

// ---------- 공통 유틸 ----------

/** URL host 가 지원 사이트인지 — 파서를 반환 (미지원이면 null) */
function parserForUrl(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  for (const [domain, parser] of Object.entries(SITES)) {
    if (host === domain || host.endsWith('.' + domain)) return parser;
  }
  return null;
}

/** URL 이 직접 읽기 지원 사이트인지 (server.js 라우트 분기용) */
function isDirectSupported(url) {
  return parserForUrl(url) !== null;
}

/** HTML 디코딩 — 엔티티를 원문 문자로 (숫자/명명된 주요 것만) */
function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"').replace(/&#0*34;|&#x0*22;/gi, '"')
    .replace(/&#0*39;|&#x0*27;/gi, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/gi, ' ').replace(/&#0*160;|&#x0*a0;/gi, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&') // amp 는 마지막에 (&amp;lt; → &lt; 방지)
    .replace(/&#x?0*[0-9a-f]+;/gi, (m) => {
      // 그 외 숫자 엔티티 → 문자
      const dec = /^&#x/i.test(m) ? parseInt(m.slice(3, -1), 16) : parseInt(m.slice(2, -1), 10);
      return (dec > 0 && dec < 0x110000) ? String.fromCodePoint(dec) : ' ';
    });
}

/** HTML 조각 → 원문 텍스트 행 배열. br/p/li/div/tr/heading 닫힘을 줄바꿈으로, 나머지 태그 제거.
 *  공백 정리만 하고 문장 자체는 절대 건드리지 않는다.
 *  ※ 사람인 마크업은 "</div >" 처럼 '>' 앞에 공백이 있는 닫는 태그가 섞여 있다 — \s* 필수. */
function htmlToLines(fragment) {
  const text = String(fragment || '')
    .replace(/<!--[\s\S]*?-->/g, '')                 // 주석(표시용 노이즈) 제거
    .replace(/<(script|style)[\s\S]*?<\/\1\s*>/gi, '') // 스크립트/스타일 제거
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|div|tr|dd|dt|h[1-6]|ul|ol|table|section)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text)
    .split('\n')
    .map((l) => l.replace(/[\t ]+/g, ' ').trim())
    .filter((l) => l.length > 0);
}

/** "• 고용형태 : 정규직" 등의 행에서 값 부분 추출 시도 (라벨이 앞에 붙은 형태) */
function stripBullet(l) {
  return l.replace(/^[-•·▪○●*]\s*/, '').trim();
}

/** 번들 조립 — 모든 소스가 이 형태로 수렴 (db.getPostingRequirements 와 동일 스키마) */
function buildBundle({ company, position, duties, required, preferred, notes, meta }) {
  const dedupe = (arr) => [...new Set((arr || []).filter(Boolean))];
  return {
    company: company || '',
    position: position || '',
    duties: dedupe(duties),
    required: dedupe(required),
    preferred: dedupe(preferred),
    notes: dedupe(notes),
    meta,
  };
}

// ---------- 사람인 파서 ----------
// 실측 구조 (2026-09-08, rec_idx=54211558 — 토스뱅크 Server Developer):
//   ① 공고 본문 템플릿: .info-block__title (📋 주요업무 / 📋 자격요건 / 🏠 근무조건 / 🚀 채용절차 …)
//      + .info-block__list 에 원문 (템플릿 종류·공고사마다 라벨/이모지가 다를 수 있음)
//   ② 요약 테이블: <dt>자격요건</dt><dd class="preferred">… , <dt>우대사항</dt><dd>…
//      우대사항 dd 는 "N건" + 상세 tooltip(id="details-preferred-…") 에 공고사 작성 원문
//   ③ 회사명: a.company_name[title], 직무명: .job-title > b (다중 모집부문이면 여러 개)
// 사람인은 공고사(기업)가 자유 양식 템플릿을 쓰기 때문에 라벨 명칭이 제각각이다.
// 그래서 info-block 을 제목 기준으로 분류하지 않고 **제목 원문을 그대로 항목 앞에 붙여**
// 모든 블록을 순서대로 수집한다 — 어느 템플릿에서도 내용이 누락되지 않게.
function parseSaramin(html, url) {
  let company = '';
  let position = '';

  // --- 회사명: a.company_name[title] → 없으면 og:title 의 [회사명] ---
  const mCo = html.match(/class="company_name[^"]*"[^>]*title="([^"]+)"/)
    || html.match(/<meta property="og:title" content="\[([^[\]]+)\]/);
  if (mCo) company = decodeEntities(mCo[1]).trim();

  // --- 직무명: .job-title 안 <b> (다중 모집부문 전부) ---
  const titles = [...html.matchAll(/<p class="job-title">\s*<b>([\s\S]*?)<\/b\s*>/g)]
    .map((m) => htmlToLines(m[1]).join(' '))
    .filter(Boolean);
  if (titles.length) position = titles.join(' / ');

  // --- ① 본문 info-block: "제목 다음 제목 직전까지" 슬라이싱 ---
  // info-block__list 안엔 중첩 <div>가 있어 여는/닫는 태그 짝 매칭이 깨진다("</div >" 공백 포함 닫힘도 있음).
  // 제목(<p class="info-block__title">)은 본문에 없는 안전한 경계이므로, 제목 위치 배열로 영역을 자른다.
  const titleRe = /<p class="info-block__title">([\s\S]*?)<\/p\s*>/g;
  const titleMatches = [...html.matchAll(titleRe)];
  // 공고 본문은 <main> 안에만 있다 — 마지막 블록의 끝 경계를 </main> 으로 잘라
  // 이후의 기업정보/리뷰/푸터 등 페이지 노이즈가 유입되지 않게 한다.
  const mainEnd = (() => {
    const m = html.match(/<\/main\s*>/);
    return m ? m.index : html.length;
  })();
  const sections = [];
  titleMatches.forEach((m, i) => {
    const start = m.index + m[0].length;
    const end = Math.min(
      i + 1 < titleMatches.length ? titleMatches[i + 1].index : html.length,
      mainEnd
    );
    // 영역 안에서 실제 콘텐츠(info-block__list 뒤)만: 첫 info-block__list 여는 태그 이후
    const body = html.slice(start, end);
    const mOpen = body.match(/class="[^"]*info-block__list[^"]*"[^>]*>/);
    const content = mOpen ? body.slice(mOpen.index + mOpen[0].length) : body;
    const title = decodeEntities(m[1].replace(/<[^>]+>/g, '')).trim();
    const lines = htmlToLines(content);
    if (title && lines.length) sections.push({ title, lines });
  });

  // --- 분류: 제목 키워드 → 역할 (공고 템플릿마다 라벨이 달라도 흔한 명칭 전부 커버) ---
  const isDutyTitle = /(주요\s*업무|담당\s*업무|업무\s*내용|job\s*duties|responsib)/i;
  const isQualTitle = /(자격\s*요건|지원\s*자격|필수\s*자격|필수\s*요건|자격\s*조건|필수\s*조건|qualif|requirement)/i;
  const isPrefTitle = /(우대\s*사항|우대\s*요건|우대\s*자격|우대\s*조건|preferred|plus)/i;
  const isCondTitle = /(근무\s*조건|근무\s*환경|고용\s*조건|working\s*condition)/i;
  const isProcTitle = /(채용\s*절차|전형\s*절차|전형\s*방법|hiring\s*process)/i;

  const duties = [];
  const required = [];
  const preferred = [];
  const notes = [];

  for (const { title, lines } of sections) {
    // 제목에서 이모지·장식 제거한 뒤 키워드 비교 (원문 라벨 "📋 주요업무" → "주요업무")
    const t = title.replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, '');
    if (isDutyTitle.test(t)) duties.push(...lines);
    else if (isPrefTitle.test(t)) preferred.push(...lines);
    else if (isQualTitle.test(t)) required.push(...lines);
    else if (isCondTitle.test(t) || isProcTitle.test(t)) notes.push(...lines);
    else {
      // 미지정 라벨(예: "인재상", "복리후생") — 원문 보존 위해 제목을 붙여 notes 로 (버리지 않음)
      notes.push(title, ...lines);
    }
  }

  // --- ② 요약 테이블 tooltip: 자격요건(details-required)·우대사항(details-preferred) 원문 ---
  // tooltip 내용은 닫는 경계(btnClose 버튼)까지 — 이후의 조회수/해시태그 등 페이지 노이즈를 포함하지 않는다.
  const tipReq = extractTooltip(html, 'details-required-');
  const tipPref = extractTooltip(html, 'details-preferred-');

  // 자격요건: 본문 info-block 이 줄바꿈을 잃은 경우(한 <p>에 전체가 들어간 경우) 대비,
  // 줄바꿈이 보존되는 tooltip 원문이 있으면 그것으로 대체 (내용 동일 — 원문 그대로).
  if (tipReq.length) {
    const infoBlockReq = required.map(stripBullet).join(' ');
    const tooltipJoined = tipReq.map(stripBullet).join(' ');
    // tooltip 이 info-block 내용을 포함하면(정규화 후 접두사) 줄 단위 원문인 tooltip 채택
    const norm = (s) => s.replace(/\s+/g, '');
    if (norm(tooltipJoined).includes(norm(infoBlockReq).slice(0, 40)) || !required.length) {
      required.length = 0;
      required.push(...tipReq);
    } else {
      required.push(...tipReq); // 내용이 다르면 둘 다 보존 (누락 방지 우선)
    }
  }

  // 우대사항: 등록형 우대("N건")는 본문에 없고 tooltip 에만 있다 — 항상 병합
  for (const l of tipPref) {
    const b = stripBullet(l);
    if (b && b !== '상세보기') preferred.push(b);
  }

  // --- 요약 테이블 기본 조건: 경력/학력/근무형태/급여/근무지역 (dl dt/dd) → notes ---
  const summaryRe = /<dt>\s*(경력|학력|근무형태|급여|근무지역|모집인원)\s*<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd\s*>/g;
  for (const m of html.matchAll(summaryRe)) {
    const val = htmlToLines(m[2]).join(' ');
    if (val) notes.push(`${m[1]}: ${val}`);
  }

  // --- 자격요건 내 "[우대]" 마커 이후 행은 우대로 이동 (공고사가 한 섹션에 같이 쓰는 경우) ---
  splitRequiredByMarkers(required, preferred);

  // --- 최소 검증: 본문에서 공고다운 내용을 못 찾으면 실패 (→ 붙여넣기 폴백) ---
  if (!duties.length && !required.length && !preferred.length) {
    const err = new Error('사람인 공고에서 본문(주요업무/자격요건)을 찾지 못했습니다. 공고가 마감·삭제되었거나 비공개 처리되었을 수 있습니다.');
    err.code = 'SCRAPE_EMPTY';
    throw err;
  }

  return buildBundle({
    company, position, duties, required, preferred, notes,
    meta: { source: 'url', scraper: 'saramin', url },
  });
}

/** 자유양식 공고(이미지·table형 — info-block 템플릿이 아닌 공고)의 원문 텍스트 추출.
 *  user_content(공고사가 올린 본문 컨테이너) 시작 → jv_footer(공고 하단) 직전까지.
 *  @returns {string} 원문 텍스트 (빈 문자열이면 폴백 불가) */
function extractSaraminFreeformText(html) {
  const i = html.search(/class="user_content[^"]*"/);
  if (i === -1) return '';
  const j = html.indexOf('jv_footer', i);
  const seg = html.slice(i, j === -1 ? undefined : j);
  const lines = htmlToLines(seg)
    .filter((l) => l !== '&nbsp;' && !/^&?nbsp;?$/.test(l));
  return lines.join('\n');
}

/** 스크레이핑으로 구조를 못 잡은 사람인 공고 → 원문 텍스트를 AI 2단 파이프라인(정제→구조화)로 분류.
 *  원문 문장은 그대로 두고 분류만 AI가 수행 (붙여넣기 경로와 동일한 원문 보존 프롬프트).
 *  @returns {Promise<{bundle: object, via: 'scraper+ai'}|null>} 폴백 불가(원문 없음)면 null */
async function saraminAiFallback(html, url) {
  const rawText = extractSaraminFreeformText(html);
  if (rawText.trim().length < 30) return null;

  let result;
  try {
    result = await getAi().analyzeRequirementsText(rawText);
  } catch (e) {
    // AI 폴백 실패(과부하 등)는 원폭 폴백 안내가 아니라 원 상태 코드 그대로 전달
    if (e.code === 'AI_BUSY') throw e;
    const err = new Error('공고 원문을 가져왔지만 자동 분류에 실패했습니다. ③ 붙여넣기에 공고 내용을 직접 넣어주세요.');
    err.code = 'SCRAPE_PARSE';
    err.cause = e.message;
    throw err;
  }

  // 회사/직무/기본조건은 HTML 에서 더 정확히 얻을 수 있으니 덮어쓴다
  const mCo = html.match(/class="company_name[^"]*"[^>]*title="([^"]+)"/)
    || html.match(/<meta property="og:title" content="\[([^[\]]+)\]/);
  const bundle = { ...result.bundle };
  if (!bundle.company && mCo) bundle.company = decodeEntities(mCo[1]).trim();
  bundle.meta = { source: 'url', scraper: 'saramin+ai', url };
  return { bundle, via: 'scraper+ai', rawText };
}

/** tooltip(id prefix) 내용 → 원문 행 배열. li 항목은 "라벨 내용" 한 줄로, freeform 은 줄 단위.
 *  경계: tooltip 컨테이너 시작 → 닫기 버튼(btnClose) 직전까지. */
function extractTooltip(html, idPrefix) {
  const m = html.match(new RegExp(`id="${idPrefix}[0-9]+"[^>]*>`));
  if (!m) return [];
  const start = m.index + m[0].length;
  const endRel = html.slice(start).search(/<button[^>]*class="[^"]*btnClose/);
  if (endRel === -1) return [];
  const content = html.slice(start, start + endRel);
  const lis = [...content.matchAll(/<li>([\s\S]*?)<\/li\s*>/g)];
  if (lis.length) {
    // 등록형 우대 li 는 "<span>라벨</span>내용" — 라벨 뒤 공백만 보정(화면 표시와 동일), 텍스트는 그대로
    return lis.map((li) => htmlToLines(li[1].replace(/<\/span\s*>/g, ' ')).join(' ')).filter(Boolean);
  }
  return htmlToLines(content)
    .map(stripBullet)
    .filter((l) => l && l !== '상세보기');
}

/** required 원문 행들에서 '[우대]' 계열 마커 이후 행을 preferred 로 이동.
 *  마커가 없으면 그대로 둔다 — 원문 구조를 존중. */
function splitRequiredByMarkers(required, preferred) {
  // "우대사항", "[우대]", "【우대】", "우대 조건" 행 이후를 우대로 — 원문 라벨 그대로 인식
  const markerRe = /^\[?\(?우대(사항|요건|자격|조건)?\)?\]?[\s:：·]*$|^[【\[]우대[】\]]/u;
  let idx = required.findIndex((l) => markerRe.test(l));
  if (idx === -1) return;
  const moved = required.splice(idx).filter((l) => !markerRe.test(l));
  preferred.push(...moved);
}

// ---------- 직접 fetch + 파싱 ----------

/** 사람인 relay/view(m-list 래퍼)·모바일 URL → 본문이 있는 정식 view URL 로 정규화 */
function normalizeSaraminUrl(url) {
  const m = url.match(/rec_idx=([0-9]+)/);
  if (!m) return url;
  return `https://www.saramin.co.kr/zf_user/jobs/view?rec_idx=${m[1]}`;
}

/** 지원 사이트 공고 URL → 요구사항 번들 (원문 그대로).
 *  ① 구조 파싱(템플릿형 공고 — AI 미경유, 즉시)
 *  ② 실패 시 원문 텍스트 + AI 2단 분류 폴백(자유양식 공고 — 원문 문장은 보존)
 *  @returns {Promise<{bundle: object, via: 'scraper'|'scraper+ai'}>} */
async function scrapeUrlRequirements(url) {
  const parser = parserForUrl(url);
  if (!parser) {
    const err = new Error('직접 읽기를 지원하지 않는 사이트입니다.');
    err.code = 'SCRAPE_UNSUPPORTED';
    throw err;
  }
  const target = /saramin/.test(new URL(url).hostname) ? normalizeSaraminUrl(url) : url;

  let html;
  try {
    const resp = await axios.get(target, {
      timeout: FETCH_TIMEOUT_MS,
      maxContentLength: MAX_HTML_BYTES,
      responseType: 'text',
      // AI 봇이 아닌 일반 브라우저 요청으로 — 사람인은 브라우저는 허용
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      },
      validateStatus: (s) => s === 200, // 403/404 등은 예외로
    });
    html = typeof resp.data === 'string' ? resp.data : String(resp.data);
  } catch (e) {
    const status = e.response?.status;
    const err = new Error(
      status === 403 || status === 401
        ? '공고 사이트가 서버 접근을 차단했습니다. 새 탭에서 공고를 열어 내용을 붙여넣어 주세요.'
        : status === 404
          ? '공고를 찾을 수 없습니다 (삭제·마감). 새 탭에서 확인 후 내용을 붙여넣어 주세요.'
          : '공고 페이지를 가져오지 못했습니다. 잠시 후 다시 시도하거나 내용을 붙여넣어 주세요.'
    );
    err.code = 'SCRAPE_BLOCKED';
    err.cause = `fetch(${target}) HTTP ${status || '-'}: ${e.message}`;
    throw err;
  }

  // ① 구조 파싱 — 성공하면 AI 없이 원문 그대로 즉시 반환
  try {
    const bundle = parser(html, target);
    return { bundle, via: 'scraper' };
  } catch (parseErr) {
    if (parseErr.code !== 'SCRAPE_EMPTY') throw parseErr;
    // ② 자유양식 공고 — 원문 텍스트를 AI 2단 파이프라인으로 분류 (문장은 그대로)
    const fb = await saraminAiFallback(html, target);
    if (fb) return fb;
    // 원문조차 없음(이미지 전용 공고 등) → 붙여넣기 폴백
    throw parseErr;
  }
}

module.exports = {
  scrapeUrlRequirements, isDirectSupported, parserForUrl,
  // 테스트용
  parseSaramin, normalizeSaraminUrl, extractSaraminFreeformText, decodeEntities, htmlToLines,
};
