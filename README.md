# jobradar-deploy

JobMarketRadar k8s 매니페스트 (ArgoCD GitOps 진실의 소스).

## 구조
- `deploy/` — 앱 리소스 (namespace, PVC, Deployment, Ingress)
- `deploy/argocd/application.yaml` — ArgoCD Application CR (별도 apply)

## Secret
- `DHS_API_KEY` 가 담긴 `jobradar-secret` 은 Git에서 관리하지 않고 수동 생성.
  - `kubectl -n jobradar create secret generic jobradar-secret --from-literal=DHS_API_KEY=...`
  - ArgoCD Application 의 ignoreDifferences 로 data 무시.

## 동기화
- ArgoCD Application `jobradar` 가 `deploy/` 디렉토리를 auto-sync.
- Git push → ArgoCD 감지 → 자동 배포.
