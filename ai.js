// ai.js — AI 생성 추상화 모듈 (Step 7 + Step 9: 2단 모델 구조)
// ------------------------------------------------------------
// 이력서 관리 페이지의 자기소개서 생성 + 채용공고 요구사항 분석 담당.
// **엔진 교체 경계**: 이 파일의 호출부 본문만 바꾸면
//   Gemini → Ollama / OpenAI / Claude 등으로 교체 가능.
//   (교체 절차는 docs/step7-resume-ai.md 참고)
//
// 현재 엔진: Google Gemini (REST 직접 호출, axios 재사용 → 의존성 추가 0)
//
// ★ Step 9: 모델 2단 구조 (2026-08-31 실측 기반)
//   PIPE    = gemini-3.5-flash-lite — 기계적 파이핑(정제/분류). 0.9초·저비용
//   QUALITY = gemini-3.5-flash     — 품질 민감 작업(분석/생성). 고품질
//   환경변수: GEMINI_MODEL_PIPE / GEMINI_MODEL_QUALITY
//   (구 GEMINI_MODEL 은 호환용으로 QUALITY 에 적용)
// ------------------------------------------------------------

'use strict';

const axios = require('axios');

// ---------- 설정 ----------
const API_KEY = process.env.GEMINI_API_KEY;
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

// 2단 모델 (Step 9)
const MODEL_PIPE = process.env.GEMINI_MODEL_PIPE || 'gemini-3.5-flash-lite';
const MODEL_QUALITY = process.env.GEMINI_MODEL_QUALITY || process.env.GEMINI_MODEL || 'gemini-3.5-flash';
// 하위 호환: 구 코드가 DEFAULT_MODEL 을 참조함 → 생성(품질) 단계와 동일
const DEFAULT_MODEL = MODEL_QUALITY;

// url_context 시도를 skip 하는 도메인 (2026-08-31 robots.txt/CloudFront 실측)
// - 원티드: CloudFront 가 비브라우저 요청 403 차단
// ※ 사람인(2026-09-08 재실측)은 일반 브라우저 요청을 허용 → BLOCKED 에서 제외하고
//   scraper.js 가 서버에서 직접 HTML 을 받아 원문 그대로 추출한다 (AI 재해석 없음).
const BLOCKED_URL_DOMAINS = ['wanted.co.kr'];

// 붙여넣기 원문 최대 길이 (프롬프트 보호)
const MAX_PASTE_CHARS = 8000;

// ---------- 공통 호출기 ----------
/** Gemini 과부하 상태코드 (503 UNAVAILABLE / 429 RESOURCE_EXHAUSTED) */
function isOverloadStatus(status) {
  return status === 503 || status === 429;
}

/**
 * 과부하 폴백 — 요청을 flash-lite(MODEL_PIPE)로 1회 재시도.
 * lite 조차 과부하면 AI_BUSY 에러로 바꿔 "잠시 후 다시 시도" 안내가 뜨게 한다.
 * (lite 는 기본 모델이 아닐 때만 폴백 대상 — PIPE 모델 자체가 과부하인 경우는 재시도 무의미)
 */
async function callGeminiOnFallback({ model, prompt, jsonMode, tools, temperature, timeoutMs, rawMsg }) {
  if (model === MODEL_PIPE) {
    const err = new Error('AI 서버가 일시적으로 혼잡합니다. 잠시 후 다시 시도해주세요.');
    err.code = 'AI_BUSY';
    err.status = 503;
    throw err;
  }
  const url = `${BASE}/models/${MODEL_PIPE}:generateContent?key=${API_KEY}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {},
  };
  if (jsonMode) body.generationConfig.responseMimeType = 'application/json';
  if (temperature !== undefined) body.generationConfig.temperature = temperature;
  if (tools) body.tools = tools;

  try {
    const resp = await axios.post(url, body, { timeout: timeoutMs });
    const text = extractText(resp.data);
    if (text.trim()) return { text, usage: resp.data?.usageMetadata || {}, model: MODEL_PIPE };
    throw new Error('빈 응답');
  } catch (e) {
    const status = e.response?.status;
    // lite 폴백도 과부하/실패 → 사용자 안내용 AI_BUSY 로 통일
    const err = new Error('AI 서버가 일시적으로 혼잡합니다. 잠시 후 다시 시도해주세요.');
    err.code = 'AI_BUSY';
    err.status = 503;
    err.cause = `fallback(${MODEL_PIPE}) 실패 (HTTP ${status || '-'}): ${rawMsg}`;
    throw err;
  }
}

/** generateContent 응답에서 텍스트 부분만 추출 */
function extractText(data) {
  return data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
}

/**
 * Gemini generateContent 공통 호출.
 * @param {object} opts { model, prompt, jsonMode, tools, temperature, timeoutMs }
 * @returns {{text: string, usage: object}} 응답 텍스트 (빈 경우 throw)
 */
async function callGemini({ model, prompt, jsonMode = false, tools, temperature, timeoutMs = 60000 }) {
  if (!API_KEY) {
    const err = new Error('GEMINI_API_KEY 가 서버에 설정되지 않았습니다. (.env 또는 Secret 확인)');
    err.code = 'AI_NO_KEY';
    throw err;
  }
  const url = `${BASE}/models/${model}:generateContent?key=${API_KEY}`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {},
  };
  if (jsonMode) body.generationConfig.responseMimeType = 'application/json';
  if (temperature !== undefined) body.generationConfig.temperature = temperature;
  if (tools) body.tools = tools;

  let data;
  try {
    const resp = await axios.post(url, body, { timeout: timeoutMs });
    data = resp.data;
  } catch (e) {
    const status = e.response?.status;
    const msg = e.response?.data?.error?.message || e.message;
    // ★ 과부하(503/429)/타임아웃이면 flash-lite 로 1회 폴백 — 프리 티어 모델이 함께 다운되는 일은 드물다
    if (isOverloadStatus(status) || e.code === 'ECONNABORTED') {
      return callGeminiOnFallback({ model, prompt, jsonMode, tools, temperature, timeoutMs, rawMsg: msg });
    }
    const err = new Error(`Gemini API 호출 실패${status ? ` (HTTP ${status})` : ''}: ${msg}`);
    err.code = 'AI_CALL_FAIL';
    err.status = status;
    throw err;
  }

  const text = extractText(data);
  if (!text.trim()) {
    const blockReason = data?.promptFeedback?.blockReason;
    throw new Error(`Gemini 응답에 텍스트가 없습니다.${blockReason ? ` (차단 사유: ${blockReason})` : ''}`);
  }
  return { text, usage: data?.usageMetadata || {}, model };
}

// JSON 파싱 방어 (코드블록/잡음 제거 후 재시도)
function parseJsonLoose(text) {
  try { return JSON.parse(text); } catch { /* 아래로 */ }
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

/* ============================================================
   Step 9: 요구사항 소스 2차 — URL 읽기 (url_context)
   ============================================================ */

/** URL이 차단 도메인인지 검사 (people.saramin.co.kr 등 서브도메인 포함) */
function isBlockedUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return BLOCKED_URL_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
  } catch {
    return true; // 파싱 불가 URL은 시도하지 않음
  }
}

/**
 * 공고 URL을 Gemini url_context 로 읽어 요구사항 번들로 분석. (QUALITY 모델)
 * 실패 감지: 응답에 접근 실패 의사 표현/빈 구조 → AI_URL_FAIL 에러 (→ 3차 붙여넣기 안내)
 *
 * @param {string} url 공고 URL
 * @returns {Promise<{bundle: object, model: string, tokens: number}>}
 */
async function fetchUrlRequirements(url) {
  if (isBlockedUrl(url)) {
    const err = new Error(
      '해당 채용 사이트는 AI 자동 읽기가 차단되어 있습니다. 새 탭에서 공고를 열어 내용을 복사해 붙여넣어 주세요.'
    );
    err.code = 'AI_URL_BLOCKED';
    throw err;
  }

  const prompt = `아래 URL의 채용공고 페이지를 직접 읽고 모집부문 전체 내용을 추출해라.
URL: ${url}

만약 페이지에 접근할 수 없거나, 채용공고 내용(모집분야/자격요건)이 없으면 아래 형식으로 성공 여부를 반드시 표시해라:
{"success": false, "reason": "접근 실패 사유"}

성공했을 경우에만 아래 형식으로 응답해라.

★ 원문 보존 규칙 (가장 중요 — 반드시 지킬 것):
- 공고 원문의 문장을 **글자 그대로 한 문장씩** 배열 항목으로 옮겨라. 단어를 고치거나, 요약하거나, 재작성하거나, 번역하지 마라.
- 하나의 항목이 여러 문장이면 문장 단위로 나눠 각각 별도 항목으로 넣어라.
- 모집부문에 있는 것은 전부 수집해야 한다: 주요업무, 자격요건 중 필수 조건(학력/경력/스킬/자격증), 우대사항, 근무조건, 채용절차.
- "우대", "우대사항", "[우대]" 로 표시된 내용은 반드시 preferred 에 넣고, 필수 자격요건과 섞지 마라.
- 공고에 따라 섹션 명칭이 달라도(예: "담당업무", "지원자격", "필수요건", "자격조건") 의미로 분류해라.

{
  "success": true,
  "company": "회사명",
  "position": "모집 직무명",
  "duties": ["주요 업무 항목들 — 원문 문장 그대로"],
  "required": ["지원자격/필수 요건 항목들 — 원문 문장 그대로"],
  "preferred": ["우대사항 항목들 — 원문 문장 그대로"],
  "notes": ["근무지역/고용형태/채용절차 등 기타 정보 — 원문 그대로"]
}`;

  const { text, model: usedModel } = await callGemini({
    model: MODEL_QUALITY, prompt, tools: [{ url_context: {} }], timeoutMs: 90000,
  });

  let parsed;
  try { parsed = parseJsonLoose(text); } catch {
    // JSON 아님 → 실패 문구로 응답했을 가능성
    if (/접근.{0,6}실패|실패했|unable to access|cannot access|접근할 수 없/i.test(text)) {
      const err = new Error('공고 URL에 접근하지 못했습니다. 새 탭에서 공고를 열어 내용을 붙여넣어 주세요.');
      err.code = 'AI_URL_FAIL';
      throw err;
    }
    const err = new Error('URL 분석 결과를 해석하지 못했습니다.');
    err.code = 'AI_URL_PARSE';
    throw err;
  }

  if (!parsed.success) {
    const err = new Error('공고 URL에 접근하지 못했습니다. 새 탭에서 공고를 열어 내용을 붙여넣어 주세요.');
    err.code = 'AI_URL_FAIL';
    throw err;
  }
  if (!Array.isArray(parsed.duties) && !Array.isArray(parsed.required)) {
    const err = new Error('URL에서 채용공고 요구사항을 찾지 못했습니다. 내용을 붙여넣어 주세요.');
    err.code = 'AI_URL_FAIL';
    throw err;
  }

  return {
    bundle: {
      company: parsed.company || '',
      position: parsed.position || '',
      duties: (parsed.duties || []).map(String),
      required: (parsed.required || []).map(String),
      preferred: (parsed.preferred || []).map(String),
      notes: (parsed.notes || []).map(String),
      meta: { source: 'url', url, model: usedModel },
    },
    model: usedModel,
  };
}

/* ============================================================
   Step 9: 요구사항 소스 3차 — 붙여넣은 원문 분석
   ============================================================ */

/**
 * 사용자가 붙여넣은 공고 원문 → 요구사항 번들. (2단: PIPE 정제 → QUALITY 구조화)
 * PIPE 단: 원문에서 공고 본문 아닌 잡음(내비게이션/광고/개인정보 동의 등)을 걷어낸다.
 * QUALITY 단: 정제 텍스트를 duties/required/preferred 로 구조화.
 *
 * @param {string} rawText 붙여넣은 원문
 * @returns {Promise<{bundle: object, models: string[]}>}
 */
async function analyzeRequirementsText(rawText) {
  const clipped = String(rawText || '').trim().slice(0, MAX_PASTE_CHARS);
  if (clipped.length < 30) {
    const err = new Error('공고 내용이 너무 짧습니다. 모집분야와 자격요건을 포함해 붙여넣어 주세요.');
    err.code = 'AI_PASTE_SHORT';
    throw err;
  }

  // --- 1단: PIPE 정제 (잡음 제거) ---
  const cleanPrompt = `아래는 채용공고 페이지에서 복사한 원문이다. 채용공고 본문(회사명, 모집분야/직무, 주요 업무, 지원자격/필수요건, 우대사항, 근무조건)과 관련 없는 텍스트(내비게이션 메뉴, 광고, 개인정보 처리방침, 로그인 안내, 다른 공고 목록, 버튼 라벨 등)를 모두 제거하고 본문만 남겨라. 원문 표현을 그대로 보존하고 요약·번역하지 마라. 결과는 텍스트로만 출력해라.

[원문]
${clipped}`;

  const clean = await callGemini({ model: MODEL_PIPE, prompt: cleanPrompt, timeoutMs: 30000 });
  const cleanedText = clean.text.trim();

  // --- 2단: QUALITY 구조화 ---
  const structPrompt = `아래 채용공고 본문을 분석해 요구사항을 JSON으로 구조화해라.

★ 원문 보존 규칙 (가장 중요 — 반드시 지킬 것):
- 공고 원문의 문장을 **글자 그대로 한 문장씩** 배열 항목으로 옮겨라. 단어를 고치거나, 요약하거나, 재작성하거나, 번역하지 마라.
- 하나의 항목이 여러 문장이면 문장 단위로 나눠 각각 별도 항목으로 넣어라.
- 모집부문에 있는 것은 전부 수집해야 한다: 주요업무, 자격요건 중 필수 조건(학력/경력/스킬/자격증), 우대사항, 근무조건, 채용절차.
- "우대", "우대사항", "[우대]" 로 표시된 내용은 반드시 preferred 에 넣고, 필수 자격요건과 섞지 마라.
- 공고에 따라 섹션 명칭이 달라도(예: "담당업무", "지원자격", "필수요건", "자격조건") 의미로 분류해라. 구분이 모호한 항목은 required 에 넣어라.

[채용공고 본문]
${cleanedText}

[출력 형식] 반드시 아래 JSON 형태로만 응답:
{
  "company": "회사명 (없으면 빈 문자열)",
  "position": "모집 직무명",
  "duties": ["주요 업무 항목 — 원문 문장 그대로"],
  "required": ["지원자격/필수 요건 항목 — 원문 문장 그대로"],
  "preferred": ["우대사항 항목 — 원문 문장 그대로"],
  "notes": ["근무지역/고용형태 등 기타 — 원문 그대로"]
}`;

  const { text: structText, model: structModel } = await callGemini({
    model: MODEL_QUALITY, prompt: structPrompt, jsonMode: true, timeoutMs: 60000,
  });

  const parsed = parseJsonLoose(structText);
  if (!Array.isArray(parsed.duties) && !Array.isArray(parsed.required)) {
    const err = new Error('붙여넣은 내용에서 채용공고 요구사항을 찾지 못했습니다. 모집분야와 자격요건을 포함해 다시 붙여넣어 주세요.');
    err.code = 'AI_PASTE_PARSE';
    throw err;
  }

  return {
    bundle: {
      company: parsed.company || '',
      position: parsed.position || '',
      duties: (parsed.duties || []).map(String),
      required: (parsed.required || []).map(String),
      preferred: (parsed.preferred || []).map(String),
      notes: (parsed.notes || []).map(String),
      meta: { source: 'paste', model: structModel },
    },
    models: [MODEL_PIPE, structModel],
    cleanedPreview: cleanedText.slice(0, 500),
  };
}

/* ============================================================
   Step 7: 자소서 생성 (Step 9: 요구사항 근거 기반 매핑 추가)
   ============================================================ */

/**
 * 요구사항 번들 → 프롬프트용 근거 블록 문자열
 */
function formatRequirementsBlock(bundle) {
  const fmt = (title, arr) => (arr && arr.length
    ? `- ${title}:\n${arr.map((x) => `  · ${String(x).trim()}`).join('\n')}`
    : null);
  const parts = [
    fmt('주요 업무', bundle.duties),
    fmt('지원자격/필수 요건', bundle.required),
    fmt('우대사항', bundle.preferred),
    fmt('근무조건 등', bundle.notes),
  ].filter(Boolean);
  if (!parts.length) return '';
  const head = [
    '[채용공고 분석 결과 — 실제 데이터이며 반드시 근거로 삼을 것]',
    bundle.position ? `- 모집 직무: ${bundle.position}` : null,
    parts.join('\n'),
    '',
    '★ 요구사항 매핑 규칙 (매우 중요):',
    '1. 위 요건 각각에 [지원자 정보]의 기술·경험이 어떻게 대응하는지 자소서 항목에 명시적으로 녹여라.',
    '2. 공고가 요구하지 않은 역량을 지어내 과장하지 마라. 근거 없는 구체적 수치도 금지.',
    '3. 지원자가 부족한 요건은 언급을 회피하지 말고, 인접 경험·학습 의지로 설득력 있게 연결하라.',
    '4. 우대사항에 부합하는 경험이 있다면 최우선으로 부각하라.',
  ].filter(Boolean);
  return head.join('\n');
}

/**
 * 단일 텍스트 프롬프트로부터 JSON 결과 생성. (QUALITY 모델 — 최종 산출물)
 * 입력(prompt)·출력(객체) 인터페이스는 엔진과 무관하게 고정 — 이것이 추상화 경계.
 *
 * @param {string} prompt  생성 지시문 (자소서 5항목 JSON 요구)
 * @param {object} [opts]  { model? }
 * @returns {Promise<object>}  { motivation, growth, strength, career, vision, _meta }
 * @throws {Error}  API 미설정/호출 실패/파싱 실패 시 (라우터에서 catch → 500 + 재시도 UI)
 */
async function generate(prompt, opts = {}) {
  const model = opts.model || MODEL_QUALITY;

  const { text, usage, model: usedModel } = await callGemini({
    model,
    prompt,
    jsonMode: true,
    temperature: 0.8, // 자소서는 약간의 다양성
  });

  let parsed;
  try {
    parsed = parseJsonLoose(text);
  } catch {
    throw new Error('Gemini 응답을 JSON으로 파싱하지 못했습니다.');
  }

  // 메타(토큰/모델) — generation_logs 기록용
  return {
    motivation: parsed.motivation || '',
    growth: parsed.growth || '',
    strength: parsed.strength || '',
    career: parsed.career || '',
    vision: parsed.vision || '',
    _meta: { model: usedModel, tokens: usage.totalTokenCount || 0 },
  };
}

/**
 * 자소서 생성용 프롬프트 조립 (프로필 + 타겟 직무 + 회사 + 요구사항 번들 → 5항목 JSON).
 * 라우터가 호출하며, 결과를 generate() 에 넘긴다.
 * company 가 있으면 그 회사의 인재상·핵심가치를 반영하도록 유도 (회사 맞춤 자소서).
 * ★ Step 9: requirements(요구사항 번들)가 있으면 근거 기반 매핑 블록이 회사 일반 지식보다 우선.
 * emphasis 가 있으면 각 항목에 어떤 기술/경험을 강조할지 사용자 지정을 반영 (한 경험 반복 방지).
 */
function buildPrompt({ profile, targetJob, jobContext, company, emphasis, requirements }) {
  // ★ Step 9: 요구사항 근거 블록 (있으면 최우선 배치)
  const reqBlock = requirements ? formatRequirementsBlock(requirements) : '';

  const companyBlock = company
    ? `\n[지원 회사 — 가장 중요한 반영 기준]
- 회사명: ${company}

★ 회사 맞춤 작성 절차 (반드시 따를 것):
1. 먼저 ${company} 의 ① 핵심가치 ② 비전/미션 ③ 인재상 ④ 지향점(추구하는 방향성) 을 먼저 떠올려 파악한다.
2. 이 4가지를 자소서 전체에 자연스럽게 녹여낸다 — 단순히 회사명을 언급하는 수준이 아니라,
   그 기업이 추구하는 가치와 지원자의 경험·역량이 어떻게 맞닿아 있는지를 설득력 있게 연결한다.
3. 항목별 반영 가이드:
   - 지원동기(motivation): ${company}의 비전·핵심가치에 공감한 구체적 계기 + 그 가치에 기여할 수 있는 이유
   - 성장과정(growth): 회사의 인재상(예: 주도성·협업·도전 등)과 부합하는 성장 경험 강조
   - 성격 장단점(strength): 회사가 중시하는 태도/역량과 연결되는 장점 우선 부각
   - 직무경험(career): 회사의 지향점(사업 방향·기술 스택 등)에 기여할 수 있는 경험 중심
   - 입사 후 포부(vision): 회사의 비전을 실현하는 구체적 기여 방안 제시
4. 절대 금지: 회사를 잘 모를 때 대충 일반적인 칭찬으로 때우지 말 것. 아는 만큼 정확한 키워드와 방향성을 반영.`
    : '';

  // 항목별 강조 포인트: 사용자가 프로필에 지정한 "어떤 기술/일화를 어느 항목에 쓸지" 가이드.
  // 프로필에 여러 기술/경험이 있을 때 한 경험을 5항목에 반복하는 것을 방지.
  const EMPHASIS_LABEL = {
    motivation: '지원동기(motivation)',
    growth: '성장과정(growth)',
    strength: '성격 장단점(strength)',
    career: '직무경험(career)',
    vision: '입사 후 포부(vision)',
  };
  let parsedEmphasis = {};
  if (emphasis) {
    try { parsedEmphasis = JSON.parse(emphasis); } catch { parsedEmphasis = {}; }
  }
  const emphasisLines = Object.keys(EMPHASIS_LABEL)
    .filter((k) => parsedEmphasis[k] && String(parsedEmphasis[k]).trim())
    .map((k) => `- ${EMPHASIS_LABEL[k]}: ${String(parsedEmphasis[k]).trim()}`);
  const emphasisBlock = emphasisLines.length
    ? `\n[항목별 강조 포인트 — 지원자가 직접 지정한 작성 가이드, 반드시 반영할 것]
${emphasisLines.join('\n')}

★ 경험 배정 원칙 (매우 중요):
- 위 강조 포인트에 적힌 기술·프로젝트·일화를 그 항목의 중심 소재로 사용하라.
- 지원자는 [지원자 정보]에 여러 기술과 경험을 보유하고 있다. 각 항목에는 서로 다른 경험을 배정하여
  자소서 전체가 다양한 역량을 보여주도록 하라. 한 기술/경험을 여러 항목에 반복하지 말 것.
- 강조 포인트를 비운 항목은 [지원자 정보]에서 그 항목에 가장 어울리는 경험을 자유롭게 선택하라.`
    : '';

  return `당신은 전문 이력서/자기소개서 컨설턴트입니다.
아래 [지원자 정보]와 [타겟 직무]${company ? '·[지원 회사]' : ''}를 바탕으로 맞춤형 자기소개서 5개 항목을 작성하세요.
각 항목은 300~500자, 자연스럽고 설득력 있는 한국어로 작성.
${requirements ? '\n⚠ 이 공고는 실제 채용공고 요구사항이 분석되어 있다. 아래 [채용공고 분석 결과]를 모든 문장의 근거로 삼고, 회사 일반 상식은 보조로만 사용하라.' : ''}

[지원자 정보]
- 경력/경험: ${profile.experience || '(미입력)'}
- 보유 기술/스택: ${profile.skills || '(미입력)'}
- 포트폴리오: ${profile.portfolio || '(미입력)'}

[타겟 직무]
- 직무명: ${targetJob || '(일반 IT/개발)'}
${jobContext ? `- 주요 채용 요건(워크넷 수집 데이터): ${jobContext}` : ''}${reqBlock ? '\n\n' + reqBlock : ''}${companyBlock}${emphasisBlock}

[작성 항목]
1. motivation: 지원동기 (이 직무/회사에 지원한 이유)
2. growth: 성장과정 (경험을 통해 어떻게 성장했는지)
3. strength: 성격의 장단점 (직무 수행에 유리한 장점과 보완할 단점)
4. career: 직무경험 (보유 기술/프로젝트가 이 직무에 어떻게 기여하는지)
5. vision: 입사 후 포부 (합격 시 어떻게 기여할 것인지)

[출력 형식] 반드시 아래 JSON 형태로만 응답할 것.
{"motivation":"...","growth":"...","strength":"...","career":"...","vision":"..."}`;
}

module.exports = {
  generate, buildPrompt, DEFAULT_MODEL,
  // 2단 모델 (Step 9)
  MODEL_PIPE, MODEL_QUALITY, MAX_PASTE_CHARS, BLOCKED_URL_DOMAINS,
  // 요구사항 소스 (Step 9)
  fetchUrlRequirements, analyzeRequirementsText, isBlockedUrl,
};
