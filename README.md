# JobMarketRadar

AI 채용공고 수집 · 분석 대시보드 + 이력서/자기소개서 관리 (ArgoCD GitOps 진실의 소스).

## 구조
- `server.js` / `db.js` / `ai.js` / `auth.js` / `collector.js` — Express 단일 서버
- `public/` — 대시보드 + 이력서 UI (바닐라 JS)
- `db/schema.sql` — SQLite 스키마 (users / sessions / profiles / cover_letters / job_postings …)
- `deploy/` — k8s 매니페스트 (PVC, Deployment, Ingress) ← ArgoCD 동기화 대상
- `deploy/argocd/application.yaml` — ArgoCD Application CR (별도 apply)
- `docs/` — 단계별 설계/작업로그 (step1~step9, ai-model-config)
- `scripts/verify-*.js` — 단계별 E2E 검증 스크립트

## 주요 기능
| 단계 | 내용 |
|---|---|
| Step 1~6 | 고용24 채용공고 수집(cron 2회/일) + 대시보드 |
| Step 7 | 프로필 기반 AI 자기소개서 생성 (Gemini) |
| Step 8 | 회원 로그인 (scrypt + SQLite 세션, 소유자 스코프) |
| Step 9 | 채용공고 요건 AI 매칭 (DB → URL → 붙여넣기 → 회사명 4단 폴백) |

## Secret (Git에 두지 않음)
`jobradar-secret` (DHS_API_KEY, GEMINI_API_KEY) 은 수동 생성.
```
kubectl -n jobradar create secret generic jobradar-secret \
  --from-literal=DHS_API_KEY=... --from-literal=GEMINI_API_KEY=...
```
ArgoCD Application 의 ignoreDifferences 로 data 무시.

## 이미지 빌드 / 배포
```
docker build -t std-harbor.kopoctc.kr/kopo13/jobradar:latest .
docker push std-harbor.kopoctc.kr/kopo13/jobradar:latest
# deploy/ 변경분은 push 만으로 ArgoCD 자동 반영
```
앱 코드 변경은 이미지 빌드+push 후 `kubectl -n jobradar rollout restart deployment/jobradar`.

## 개발
```
cp .env.example .env   # 실제 키 채우기 (절대 커밋 금지)
npm install
node server.js
```
