# Step 7 · AI 엔진 운영 가이드 — 교체/키 관리

> 이력서 관리 페이지의 **AI 호출 부분**만 교체/변경할 때 참고하는 문서.
> 현재는 **Gemini API** 사용. 나중에 Ollama/OpenAI/Claude 등으로 바꿀 때 이 문서를 따르면 됨.
> 설계 전체는 [[step7-resume-design]] 참고.

---

## 0. 왜 이 문서가 필요한가

AI 엔진은 비용·품질·가용성에 따라 바뀔 수 있다. 이 프로젝트는 **AI 호출을 `ai.js` 한 파일에 격리**해 두었으므로, 엔진을 바꿀 때 **`ai.js`만 수정**하면 된다. 이 문서는 그 절차를 단계별로 기록한다.

---

## 1. 현재 구성 (기본값)

| 항목 | 값 |
|---|---|
| 엔진 | **Google Gemini** (`gemini-2.5-flash`) |
| 호출 방식 | **REST 직접 호출** (axios 재사용, SDK 의존성 0) |
| 엔드포인트 | `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={KEY}` |
| 인증 | 환경변수 `GEMINI_API_KEY` |
| 무료 할당량 | 분당 15회 / 일일 150만 토큰 (자소서 생성 수십 편 커버) |

### 키 발급 방법 (서버 키 방식)
1. https://aistudio.google.com/apikey 접속 (구글 계정 로그인)
2. "Create API key" 클릭 → 키 복사
3. `.env` 파일에 추가:
   ```env
   GEMINI_API_KEY=AIza...
   ```
4. **vcluster 배포 시**: 기존 `DHS_API_KEY`와 동일하게 Secret에 주입
   ```bash
   kubectl -n jobradar create secret generic jobradar-secret \
     --from-literal=DHS_API_KEY='<기존>' \
     --from-literal=GEMINI_API_KEY='<새키>' \
     --dry-run=client -o yaml | kubectl -n jobradar apply -f -
   ```
   → Deployment env의 `secretKeyRef` 에 `GEMINI_API_KEY` 추가 필요 (server.js / 매니페스트)

---

## 2. 추상화 경계 (어디를 수정해야 하는가)

```
┌─────────────────────────────────────────────┐
│ server.js  (라우터)                          │  ← 건드릴 필요 없음
│   POST /api/cover-letters/:id/generate      │
│     → prompt 조립 (프로필+직무)              │
│     → const result = await ai.generate(p)   │  ← 이 호출 인터페이스 고정
└─────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────┐
│ ai.js  (추상화 경계) ★ 엔진 교체 시 여기만   │
│   async function generate(prompt) {          │
│     // 현재: Gemini REST 호출                │
│     // 교체: 이 함수 본문만 바꾸면 됨        │
│   }                                          │
└─────────────────────────────────────────────┘
```

**규칙**: `ai.generate(prompt)` 의 **입력(prompt 문자열)과 출력(JSON 결과)** 인터페이스는 엔진과 무관하게 고정. 엔진마다 내부 구현만 바꾼다.

---

## 3. 엔진 교체 절차 (예: Ollama 로컬로 전환)

### A. Ollama (로컬 무료, 오프라인)
1. 서버에 Ollama 설치: `curl -fsSL https://ollama.com/install.sh | sh`
2. 모델 다운로드: `ollama pull gemma3:4b` (한글 가능한 가벼운 모델)
3. `ai.js`의 `generate()` 본문을 Ollama REST로 교체:
   ```js
   // Ollama 로컬 (http://localhost:11434/api/generate)
   const { data } = await axios.post('http://localhost:11434/api/generate', {
     model: 'gemma3:4b',
     prompt,
     stream: false,
     format: 'json',
   });
   return JSON.parse(data.response);
   ```
4. 키 불필요 → `GEMINI_API_KEY` 환경변수 제거

> ⚠️ **주의**: 현재 서버는 GPU 없는 CPU 환경. Ollama 로컬 구동 시 자소서 1편 생성에 수십 초~분 소요될 수 있음. RAM 점유도 큼(Node 서버와 경합). 응답 지연이 심하면 Gemini 유지 권장.

### B. OpenAI (GPT)
1. `ai.js` 본문 교체:
   ```js
   const { data } = await axios.post('https://api.openai.com/v1/chat/completions', {
     model: 'gpt-4o-mini',
     messages: [{ role: 'user', content: prompt }],
     response_format: { type: 'json_object' },
   }, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } });
   return JSON.parse(data.choices[0].message.content);
   ```
2. 환경변수 `OPENAI_API_KEY` 추가 + Secret 주입

### C. Anthropic Claude
1. `ai.js` 본문 교체 (Claude messages API)
2. 환경변수 `ANTHROPIC_API_KEY` 추가

---

## 4. 키 관리 정책

| 환경 | 위치 | 비고 |
|---|---|---|
| **로컬 개발** | `.env` 파일 | `.gitignore` 포함됨 (커밋 금지) |
| **vcluster 배포** | Kubernetes Secret `jobradar-secret` | ExternalSecret(Vault) 또는 수동 생성 |
| **Docker 이미지** | 포함 ❌ | 런타임 환경변수/Secret으로만 주입 (Dockerfile/.dockerignore 확인) |

> 기존 `DHS_API_KEY` 와 **동일한 패턴**. 새 AI 키 추가 시:
> 1. `.env.example` 에 항목 추가 (예: `GEMINI_API_KEY=`)
> 2. `deploy/40-externalsecret.yaml` 또는 수동 Secret 에 키 추가
> 3. `deploy/20-deployment.yaml` env 에 `secretKeyRef` 추가

---

## 5. 실패 처리 & 비용 관리

- **API 호출 실패** (네트워크/할당량 초과/잘못된 키): `ai.generate()` 가 에러 throw → 라우터가 500 응답 → 프론트에 에러 메시지 + **재시도 버튼** 표시
- **생성 이력**: 모든 호출을 `generation_logs` 테이블에 기록 (model/status/tokens) → 비용/사용량 추적 가능
- **할당량 초과 대비**: 무료 할당량(일 150만 토큰) 모니터링. 초과 시 유료 플랜 전환 또는 Ollama fallback 고려

---

## 6. 빠른 점검 체크리스트 (엔진 교체 후)

- [ ] `ai.js` 의 `generate()` 가 새 엔진을 호출하는가?
- [ ] 입력(prompt) / 출력(JSON) 인터페이스가 동일한가? (라우터 수정 없어야 함)
- [ ] 새 환경변수가 `.env.example` 에 추가되었는가?
- [ ] vcluster Secret 에 새 키가 주입되었는가?
- [ ] `generation_logs` 에 새 모델명이 기록되는가?
- [ ] 실제 자소서 1건 생성 테스트 통과?
