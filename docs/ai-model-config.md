# AI 모델 변경 가이드 (9-1)

> 작성일: 2026-08-31
> 대상: `ai.js` 의 Gemini 모델 설정 — Step 9의 2단 구조(PIPE/QUALITY) 포함
> 관련: [step7-resume-ai.md](./step7-resume-ai.md) (엔진 교체 — Gemini→OpenAI 등) · [step9-recruit-matching-plan.md](./step9-recruit-matching-plan.md) 3절

---

## 1. 현재 구조 요약

Step 9부터 AI 호출은 **용도별 2단 모델**로 나뉜다. 둘 다 `ai.js` 의 상수 하나로 결정되므로
모델 변경은 **코드 수정 없이 환경변수만**으로 가능하다.

| 단 | 상수 | 기본 모델 | 담당 작업 | 호출 빈도 |
|---|---|---|---|---|
| **PIPE** (파이핑) | `MODEL_PIPE` | `gemini-3.5-flash-lite` | 붙여넣은 공고 원문 정체(잡음 제거) | 잦음·기계적 |
| **QUALITY** (품질) | `MODEL_QUALITY` | `gemini-3.5-flash` | URL 분석, 요구사항 구조화, **자소서 5항목 생성** | 드묾·최종 산출 |

```js
// ai.js:26-27 — 이 두 줄이 모델 결정의 전부
const MODEL_PIPE    = process.env.GEMINI_MODEL_PIPE    || 'gemini-3.5-flash-lite';
const MODEL_QUALITY = process.env.GEMINI_MODEL_QUALITY || process.env.GEMINI_MODEL || 'gemini-3.5-flash';
```

`DEFAULT_MODEL`(하위 호환용 export)은 QUALITY 와 같은 값을 가리킨다 — Step 7 시절 코드가 참조한다.

## 2. 모델 변경 방법 (환경변수 — 권장)

`.env` 에 한 줄 추가하고 서버 재시작:

```bash
# 예: 품질 단을 3.7-flash 로 올리기
GEMINI_MODEL_QUALITY=gemini-3.7-flash

# 예: 파이핑 단을 더 가볍게
GEMINI_MODEL_PIPE=gemini-3.1-flash-lite

# 예: 두 단을 같은 모델로 통합 (단순 구조로 테스트할 때)
GEMINI_MODEL_PIPE=gemini-3.5-flash
GEMINI_MODEL_QUALITY=gemini-3.5-flash
```

| 환경변수 | 대상 | 미설정 시 기본값 |
|---|---|---|
| `GEMINI_MODEL_PIPE` | PIPE 단 | `gemini-3.5-flash-lite` |
| `GEMINI_MODEL_QUALITY` | QUALITY 단 | `gemini-3.5-flash` |
| `GEMINI_MODEL` (구 Step 7 호환) | QUALITY 단 (우선순위 낮음) | — |

> 우선순위: `GEMINI_MODEL_QUALITY` > `GEMINI_MODEL` > 코드 기본값

배포 환경(k8s)에서는 `deploy/20-deployment.yaml` 의 env 항목에 같은 변수를 추가한다.

## 3. 사용 가능한 모델 목록 확인

실제 키로 사용 가능한 모델은 API에 물어봐야 정확하다 (2026-08-31 기준 목록은 하단 7절):

```bash
node -r dotenv/config -e "
const axios = require('axios');
axios.get(\`https://generativelanguage.googleapis.com/v1beta/models?key=\${process.env.GEMINI_API_KEY}&pageSize=100\`)
  .then(r => r.data.models
    .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
    .forEach(m => console.log(m.name.replace('models/', ''))))
  .catch(e => console.log('에러:', e.response?.status, e.message));
"
```

## 4. 모델 선택 기준

### 요건 매트릭스

기능은 모델별 지원 여부가 다르다. 변경 전 반드시 확인:

| 기능 | 필요한 기능 플래그 | 쓰는 곳 |
|---|---|---|
| JSON 강제 모드 (`responseMimeType`) | 대부분 지원 | 자소서 생성, 요구사항 구조화 |
| `url_context` (URL 읽기) | **일부 모델만** | URL 요구사항 분석 (QUALITY 단) |
| 긴 컨텍스트 | 모델별 상이 | 공고 원문 정제 (PIPE 단) |

`url_context` 지원 모델만 QUALITY 로 쓸 수 있다 (2026-08-31 실측 목록은 7절 참고).

### 실측 응답 속도 (2026-08-31, 동일 프롬프트)

| 모델 | 응답 | 비고 |
|---|---|---|
| `gemini-3.5-flash-lite` | **0.9초** | PIPE 적임 |
| `gemini-3.5-flash` | 6.8초 | 품질 필요 시 감수 |

### 권장 조합

| 상황 | PIPE | QUALITY |
|---|---|---|
| 기본 (현재) | `3.5-flash-lite` | `3.5-flash` |
| 품질 최우선 | `3.5-flash` | `3.7-flash` |
| 비용 최소 | `3.1-flash-lite` | `3.5-flash-lite` |
| 신규 모델 검증 | 기존 유지 | 새 모델만 교체 (A/B 비교) |

## 5. 변경 후 검증

```bash
# 1) 모델 반영 확인 (서버 재시작 후)
node -r dotenv/config -e "console.log('PIPE:', require('./ai').MODEL_PIPE, '/ QUALITY:', require('./ai').MODEL_QUALITY)"

# 2) 실제 동작 확인 — 붙여넣기 분석(PIPE→QUALITY 2단) + 생성(QUALITY)
node -r dotenv/config scripts/verify-step9-matching.js
# 마지막 "generation_logs에 3.5 모델 기록" 항목이 새 모델명을 감지하는지 스크립트의 정규식 확인 필요

# 3) DB에 실제 기록된 모델명 확인
node -e "const db=require('./db'); db.init(); console.log(db.getDb().prepare('SELECT model, COUNT(*) c FROM generation_logs GROUP BY model ORDER BY id DESC LIMIT 5').all())"
```

> `generation_logs.model` 컬럼에 **실제 호출에 쓰인 모델명**이 기록되므로, 환경변수가 의도대로 반영됐는지 최종 확인하는 곳은 DB다.

## 6. 장애 시 롤백

`.env` 에서 해당 줄을 지우거나 주석 처리 → 서버 재시작 → 코드 기본값으로 복귀:

```bash
# .env
# GEMINI_MODEL_QUALITY=gemini-3.7-flash   ← 주석 처리 = 기본값(3.5-flash) 복귀
```

에러 코드별 대처:

| 증상 | 원인 | 조치 |
|---|---|---|
| `404 model not found` | 모델명 오타 / 키에 권한 없음 | 3절 스크립트로 존재 확인 |
| `AI_CALL_FAIL (HTTP 400)` + tools 관련 | 그 모델이 `url_context` 미지원 | QUALITY 를 지원 모델로 변경 |
| 응답 품질 저하 (JSON 파싱 실패 증가) | lite 급 모델을 생성 단에 사용 | QUALITY 를 flash 급으로 |

## 7. 부록: 2026-08-31 실측 사용 가능 모델

`generateContent` 지원 + 본 프로젝트 관점 정리:

**flash 계열 (본 프로젝트 후보)**
```
gemini-2.5-flash            # Step 7 시절 기본 (현행 하위 호환)
gemini-2.5-flash-lite
gemini-3.1-flash-lite       # url_context 지원 ✅
gemini-3.5-flash            # 현행 QUALITY 기본 — url_context 지원 ✅
gemini-3.5-flash-lite       # 현행 PIPE 기본 — url_context 지원 ✅
gemini-3.6-flash
gemini-3.7-flash
gemini-flash-latest         # alias (Google이 최신 flash로 자동 지정)
```

**참고용**
```
gemini-2.5-pro, gemini-3.1-pro-preview   # 고성능 (비용↑ — 품질 테스트용)
gemma-4-26b-a4b-it, gemma-4-31b-it       # 오픈 모델 (url_context 미지원)
```

> 이 목록은 시점에 따라 달라진다. 변경 전 반드시 3절의 스크립트로 재확인할 것.

---

## 변경 이력

| 일자 | 내용 |
|---|---|
| 2026-08-31 | 문서 신설. Step 9 2단 구조(PIPE=3.5-flash-lite / QUALITY=3.5-flash) 기준으로 작성. 구 `GEMINI_MODEL`(2.5-flash 시절)의 호환 규칙 정리 |
