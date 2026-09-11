#!/usr/bin/env bash
# ============================================================
# deploy.sh — JobMarketRadar vcluster 배포 (수동 / 초기 검증용)
# ------------------------------------------------------------
# ArgoCD 적용 전 단계: 이미지 빌드/push + 매니페스트 apply.
# (ArgoCD GitOps 를 쓰게 되면 Git push 만으로 자동 동기화되므로
#  이 스크립트는 최초 1회 / 긴급 수동 배포용으로 남김.)
#
# 환경 (사전 확인 완료):
#   - 컨텍스트: vcluster (RKE2 위 syncer 가상 클러스터)
#   - StorageClass: nfs-std-1 (default)
#   - Ingress: traefik (호스트 k3s, vcluster 동기화) + *.std.kopoctc.kr
#   - 레지스트리: std-harbor.kopoctc.kr/kopo13 (public, imagePullSecret 불필요)
#
# Secret 주의:
#   DHS_API_KEY·GEMINI_API_KEY 가 필요. 이 클러스터는 수동 생성 방침:
#     kubectl -n jobradar create secret generic jobradar-secret \
#       --from-literal=DHS_API_KEY='<키>' --from-literal=GEMINI_API_KEY='<키>'
#   (ExternalSecret 40-*.yaml 은 vcluster namespaced 모드 정책상 deploy/ 에
#    두지 않음 — ArgoCD 가 Vault 경로 없는 CR 을 apply 하는 것을 막기 위함.)
# ============================================================
set -euo pipefail

HARBOR="std-harbor.kopoctc.kr"
PROJECT="kopo13"
IMAGE="${HARBOR}/${PROJECT}/jobradar:latest"
APP_NS="jobradar"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"

echo "▶ 작업 디렉토리: ${ROOT}"
echo "▶ 현재 kubectl 컨텍스트: $(kubectl config current-context)"
if [ "$(kubectl config current-context)" != "vcluster" ]; then
  echo "⚠ 컨텍스트가 'vcluster' 가 아닙니다. kubectl config use-context vcluster 후 실행하세요."
  exit 1
fi

command -v kubectl >/dev/null || { echo "✗ kubectl 없음"; exit 1; }
command -v docker  >/dev/null || { echo "✗ docker 없음";  exit 1; }
if ! grep -q "$HARBOR" ~/.docker/config.json 2>/dev/null; then
  echo "✗ Harbor 로그인 안 됨: docker login $HARBOR 먼저 실행"
  exit 1
fi
echo "✓ Harbor 로그인 확인됨"
kubectl cluster-info >/dev/null 2>&1 || { echo "✗ vcluster 연결 실패"; exit 1; }

# ----- 1. 이미지 빌드 & push -----
echo "▶ [1/3] 이미지 빌드 & push → ${IMAGE}"
docker build -t "${IMAGE}" "${ROOT}"
docker push "${IMAGE}"

# ----- 2. 매니페스트 apply (순서대로) -----
echo "▶ [2/3] k8s 매니페스트 apply..."
kubectl apply -f "${HERE}/10-pvc.yaml"

# Secret: 수동 생성 방침 (ExternalSecret 미사용 — Vault 경로 없음)
if ! kubectl -n "${APP_NS}" get secret jobradar-secret >/dev/null 2>&1; then
  echo "  ⚠ Secret jobradar-secret 없음. 수동 생성 필요:"
  echo "    kubectl -n ${APP_NS} create secret generic jobradar-secret --from-literal=DHS_API_KEY='<키>' --from-literal=GEMINI_API_KEY='<키>'"
fi

kubectl apply -f "${HERE}/20-deployment.yaml"
kubectl apply -f "${HERE}/30-ingress.yaml"

# ----- 3. 상태 확인 -----
echo "▶ [3/3] Pod 기동 대기..."
kubectl -n "${APP_NS}" rollout status deployment/jobradar --timeout=300s

echo
echo "✅ 배포 완료:"
kubectl -n "${APP_NS}" get all,ingress,pvc

echo
echo "▶ 접속:"
echo "  [외부]    https://kopo13-jobradar.std.kopoctc.kr"
echo "  [검증]    curl -sk https://kopo13-jobradar.std.kopoctc.kr/api/summary"
echo "  [내부]    kubectl -n ${APP_NS} port-forward svc/jobradar 8080:3000 → http://localhost:8080"
