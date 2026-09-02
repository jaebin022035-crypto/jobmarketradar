# JobMarketRadar · 단계별 개발 가이드

> 채용시장 트렌드 분석 웹 — 폴리텍대학교 인공지능응용소프트웨어 수료 포트폴리오
> 작성일: 2026-07-07

이 폴더는 `JobMarketRadar.md`(전체 계획서)를 **실행 가능한 단계별 가이드**로 쪼갠 문서 모음입니다.
각 단계는 독립된 md 파일로 되어 있으며, **목표 → 해야 할 일 → 진행 순서 → 주의사항 → 완료 기준**의 동일한 구조로 작성되어 있습니다.

---

## 📌 전체 진행 순서 (꼭 이 순서대로)

| 순서 | 단계 | 기간 | 문서 | 핵심 산출물 |
|---|---|---|---|---|
| **1** | 설계 + API 키 발급 | 1일 | [step1-design-and-api-key.md](./step1-design-and-api-key.md) | 인증키, DB 스키마, API 명세, 폴더 뼈대 |
| **2** | 수집기(collector) 구현 | 1일 | [step2-collector.md](./step2-collector.md) | 동작하는 배치 수집 스크립트 |
| **3** | 백엔드 집계 API | 2일 | [step3-backend-api.md](./step3-backend-api.md) | Express + 집계 쿼리 API |
| **4** | 프론트 대시보드 | 2~3일 | [step4-frontend-dashboard.md](./step4-frontend-dashboard.md) | 다크테마·반응형 대시보드 |
| **5** | 연동·디테일 | 1일 | [step5-integration.md](./step5-integration.md) | 실데이터 연동 + 트렌드 요약 |
| **6** | 인프라/배포 | 1.5일 | [step6-infra-deploy.md](./step6-infra-deploy.md) | Docker + Jenkins CI/CD |
| **7** | 이력서 관리 (AI 자소서) | — | [step7-resume-design.md](./step7-resume-design.md) · [step7-resume-ai.md](./step7-resume-ai.md) · [step7-worklog.md](./step7-worklog.md) | 4번째 탭, Gemini 자소서 생성, 회사 맞춤 |
| **8** | 로그인 시스템 (회원별 이력서 격리) | — | [step8-auth-plan.md](./step8-auth-plan.md) · [step8-auth-worklog.md](./step8-auth-worklog.md) | 회원가입/로그인, 이력서 접근 제어, 개인정보 격리 |
| **9** | 채용공고 요구사항 매칭 자소서 | — | [step9-recruit-matching-plan.md](./step9-recruit-matching-plan.md) · [step9-recruit-matching-worklog.md](./step9-recruit-matching-worklog.md) | DB/URL/붙여넣기 4계층 소스, 모델 2단(3.5-flash-lite/flash), 근거 기반 매핑 |
| **9-1** | AI 모델 변경 가이드 | — | [ai-model-config.md](./ai-model-config.md) | 모델 2단 구조, 환경변수 변경법, 지원 모델 목록, 롤백 |
| **10** | Gitea 전체 소스 업로드 (GitOps) | — | [step10-gitops-gitea-sync.md](./step10-gitops-gitea-sync.md) | 앱 소스 51파일 푸시, push 인증 토큰화, 장애 4건 해결 기록, 표준 배포 절차 |

> **총 기간: 약 1.5주(10~11일)** (Step 7는 후속 기능 확장)

### ⚠️ 순서를 바꾸면 안 되는 이유

- **API 키가 없으면 수집기를 만들 수 없다** → 1단계는 무조건 최우선.
- **DB에 데이터가 없으면 집계 API를 검증할 수 없다** → 수집기(2)가 API(3)보다 먼저.
- **API가 없으면 프론트에 띄울 데이터가 없다** → 백엔드(3)가 프론트(4)보다 먼저.
- **로컬에서 동작 확인 전에 배포하면 디버깅이 지옥** → 연동(5) 이후에만 배포(6).

---

## 🧭 단계별 공통 원칙

이 원칙은 **모든 단계**에 적용됩니다.

### 1. 작게 만들고, 바로 확인한다
- 한 번에 큰 기능을 통째로 만들지 말 것.
- "API 1개 호출 → 콘솔 출력" 수준부터 시작해서 점점 붙인다.
- 각 단계마다 **"화면/콘솔에 결과가 보이는가?"** 로 완료를 판단한다.

### 2. 커밋은 단계별로 쪼갠다
- 한 단계가 끝날 때마다 `git add .` 후 커밋.
- 커밋 메시지는 **무엇을 했는지** 드러내게 (예: `feat: 워크넷 API 수집기 구현`).
- 단계별 커밋 히스토리 자체가 **취업용 어필 포인트**가 된다(계획서 10절).

### 3. 인증키·비밀번호는 절대 코드에 하드코딩하지 않는다
- 모두 `.env` 파일로 관리.
- `.env`는 반드시 `.gitignore`에 추가 (키 유출 방지).

### 4. 공공데이터 API는 합법·안정성이 생명
- 크롤링 금지. 공식 Open API만 사용.
- API 호출 제한(분당 횟수)을 반드시 지킨다.

### 5. labport 환경 규칙
- 메인 페이지는 `index.html`이어야 외부에서 바로 열림.
- 서버는 `start_server.sh`로 실행 (고유 포트 자동 할당).
- 코드 수정 후 프론트는 "브라우저 새로고침", 서버 로직은 서버 재시작.

---

## 🚨 전체 주의사항 TOP 5 (어떤 단계에서든 빠지면 큰일)

| # | 주의사항 | 해당 단계 |
|---|---|---|
| 1 | **워크넷 API 키 발급은 승인에 시간이 걸린다 → 1일차 최우선 신청** | 1단계 |
| 2 | **인증키는 `.env` + `.gitignore`** (깃허브에 올리면 키 만료/악용) | 전체 |
| 3 | **API 호출 제한 준수** (너무 빨리 호출하면 차단/에러) | 2단계 |
| 4 | **SQLite 파일은 Docker 볼륨으로 영속화** (안 하면 배포마다 데이터 날아감) | 6단계 |
| 5 | **빈 데이터 화면 처리** (수집 직후 텅 빈 대시보드 대비) | 4~5단계 |

---

## 📂 이 docs 폴더의 구조

```
JobMarketRader/
├── JobMarketRadar.md          # 전체 계획서 (개요/아키텍처/기술스택)
└── docs/
    ├── README.md              # ← 지금 보는 파일 (전체 인덱스)
    ├── step1-design-and-api-key.md   # 설계 + API 키 발급
    ├── step2-collector.md            # 수집기 구현
    ├── step3-backend-api.md          # 백엔드 집계 API
    ├── step4-frontend-dashboard.md   # 프론트 대시보드
    ├── step5-integration.md          # 연동·디테일
    ├── step6-infra-deploy.md         # 인프라/배포
    ├── step7-resume-*.md             # 이력서 관리 (AI 자소서) — design/ai/worklog
    ├── step8-auth-*.md               # 로그인 시스템 — plan(설계)/worklog(수행)
    ├── step9-recruit-matching-*.md  # 채용공고 요구사항 매칭 — plan/worklog
    ├── ai-model-config.md           # AI 모델 변경 가이드 (9-1) — 2단 구조/환경변수/롤백
    └── step10-gitops-gitea-sync.md  # Gitea 전체 소스 업로드 — 배포 순서·장애 해결 기록
```

---

## ▶️ 지금 당장 시작하기

**[Step 1: 설계 + API 키 발급 →](./step1-design-and-api-key.md)**

1일차에 가장 먼저 할 일은 **공공데이터포털에서 워크넷 API 키를 신청**하는 것입니다. 승인 대기 시간 동안 나머지 설계 작업(DB 스키마, API 명세, 폴더 뼈대)을 진행하면 됩니다.
