# Gemini 복귀 절차 — 로컬 릴레이(cc-qwen) 임시 적용 되돌리기

> 2026-10-06 적용. Gemini API 프로젝트 차단(`403 Your project has been denied access`) 기간 동안
> **로컬 서버만** 학교 LLM 릴레이(qwen3.8-flash-next)를 쓰도록 임시 우회한 상태입니다.
> Gemini 키를 새로 발급받아 정상 동작 확인되면 이 문서대로 되돌립니다.

## 적용된 변경 내역 (되돌릴 대상)

| 파일 | 변경 | 되돌리기 |
|---|---|---|
| `.env` (gitignore됨, 로컬 전용) | `AI_PROVIDER=relay` + `RELAY_*` 3줄 블록 추가 | 아래 ①번 |
| `ai.js` | `[임시]` 마커로 감싼 `callRelay()` 함수 블록 + `callGemini()` 앞 분기 1줄 | 아래 ②번 |

**배포본(클러스터)은 영향 없음** — 배포 Deployment의 env는 K8s Secret `jobradar-secret`에서
주입되며 `AI_PROVIDER` 변수 자체가 없으므로 무조건 Gemini 경로를 탑.
`ai.js`의 분기가 `process.env.AI_PROVIDER === 'relay'` 일 때만 활성화되기 때문.
(이미지에 이 ai.js가 들어가도 동작상 무해하나, 복구 후 ②번 정리 후 재빌드 권장)

## ① .env 되돌리기 (필수 — 이것만으로도 Gemini 복귀)

`.env`의 해당 블록 삭제 또는 비활성화:

```bash
# 방법 A: AI_PROVIDER 줄만 주석 처리 (其余 RELAY_* 는 방치해도 무해)
sed -i 's|^AI_PROVIDER=relay|# AI_PROVIDER=relay|' .env

# 방법 B: 블록 전체 제거
sed -i '/# ===== \[임시\] 학교 LLM 릴레이/,/^RELAY_MODEL=/d' .env
```

## ② ai.js 코드 정리 (복구 후 이 타이밍에 커밋과 함께 정리 권장)

`ai.js`에서 `[임시]` 마커로 감싼 부분만 지우면 됩니다:

1. `// ---------- [임시] 학교 LLM 릴레이` ~ `// ---------- [임시] 여기까지 ----------` 블록 삭제
2. `callGemini()` 함수 첫머리의 아래 2줄 삭제:
   ```js
   // [임시] 로컬 릴레이 모드 (AI_PROVIDER=relay) — 설정 시에만 분기, 기본은 아래 Gemini
   if (RELAY) return callRelay({ prompt, jsonMode, temperature, timeoutMs, images, tools });
   ```

git 커밋 이력으로 보면 정확히 어디인지 확인 가능:

```bash
git log --oneline -- ai.js | head    # [임시] 릴레이 커밋 확인 후
git revert <커밋해시>                # 또는 수동 편집
```

## ③ 새 Gemini 키 반영 + 재시작

```bash
# .env 교체 확인 후 로컬 재시작
kill $(cat server.pid); bash start_server.sh

# 클러스터 배포본에도 새 키 반영 (키-only 변경, 매니페스트 변경 없음)
ENVKEY=$(grep '^GEMINI_API_KEY=' .env | cut -d= -f2-)
kubectl -n jobradar patch secret jobradar-secret --type merge \
  -p "$(jq -Rn --arg k "$ENVKEY" '{"stringData":{"GEMINI_API_KEY":$k}}')"
kubectl -n jobradar rollout restart deployment/jobradar
kubectl -n jobradar rollout status deployment/jobradar --timeout=180s
```

> ArgoCD는 `jobradar-secret`의 `/data`를 ignoreDifferences로 무시하므로 GitOps 충돌 없음.
> (Secret에 GitOps 외 변경하는 이 절차는 운영 확정된 패턴 — 관련: deploy/20-deployment.yaml 주석)

## 검증 (복구 후 반드시)

```bash
# 1) 새 키 자체 검증 (차단 해제 확인)
node -e '
require("dotenv").config(); const axios = require("axios");
axios.post("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=" + process.env.GEMINI_API_KEY,
  { contents: [{ parts: [{ text: "say OK" }] }] },
  { headers: { "content-type": "application/json" }, timeout: 30000 })
  .then(r => console.log("PASS", r.status)).catch(e => console.log("FAIL", e.response?.status, e.response?.data?.error?.message));'

# 2) Pod 주입 확인
PODKEY=$(kubectl -n jobradar exec deployment/jobradar -- printenv GEMINI_API_KEY | tr -d '\r\n')
[ "$ENVKEY" = "$PODKEY" ] && echo MATCH || echo MISMATCH

# 3) 릴레이 경로 비활성 확인 (log의 모델명이 gemini-* 여야 함)
#    앱에서 자소서 생성 → 응답 모델이 gemini-3.5-flash 면 복귀 완료
```

## 참고: 로컬 릴레이 모드에서 동작하지 않는 기능 (복구 전까지)

| 기능 | 상태 |
|---|---|
| 자소서 생성 (5항목) | ✅ qwen 정상 (`/api/profiles/:id/generate`) |
| 공고 텍스트 분석 | ✅ qwen 정상 |
| 공고 URL 읽기 (`url_context`) | ❌ qwen 미지원 → `AI_PROVIDER_LIMIT` 안내 (해당 공고는 붙여넣기 사용) |
| 이미지 공고 OCR | ❌ qwen vision 미지원 →同上 |
| 파이핑 정제(PIPE) | ✅ qwen 통과 (jsonMode 지시문 병기) |

릴레이 URL: `https://relay-std.kopoctc.kr/v1/chat/completions` (OpenAI 규약, 실측 200)
Anthropic 규약(`/v1/messages`)도 동일 키로 동작 확인됨 — cc-qwen과 같은 토큰 사용.
