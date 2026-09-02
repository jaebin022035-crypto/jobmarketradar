# Step 10: Gitea 전체 소스 업로드 — 배포 순서·해결 과정 기록

> **작업일: 2026-08-31** · 이 단계의 목표: 한 달 넘게 매니페스트만 올라가 있던 Gitea 리포에 **애플리케이션 전체 소스를 업로드**하고, ArgoCD GitOps 흐름(push → 자동 감지 → 자동 적용)을 실제로 검증한다.

---

## 📌 배경 — 무엇이 문제였나

2026-08-31 배포(Step 8/9) 직후 Harbor/Gitea 업로드 상태를 점검한 결과:

| 대상 | 상태 | 문제 |
|---|---|---|
| **Harbor** `std-harbor.kopoctc.kr/kopo13/jobradar` | ✅ 최신 | 없음 — push한 digest(`sha256:5ce2421b…`)와 실행 중 Pod digest가 **정확히 일치** |
| **Gitea** `kopo13/web` | ❌ 한 달치 결측 | 마지막 커밋 `2026-07-28`. **앱 소스가 하나도 없음**(server.js, db.js, ai.js, public/ … 전부). 작업 폴더조차 git 저장소가 아님 |

Gitea에 있던 것은 `deploy/` 매니페스트 3개뿐. 게다가 클러스터의 `GEMINI_API_KEY` env는 8/5에 `kubectl set`으로 **수동 주입**된 것이라 Git과 불일치인 채로 방치돼 있었다(selfHeal이 켜져 있어 언제 되돌려질지 모르는 상태).

**→ GitOps의 근간(Git = 단일 진실의 소스)이 깨진 상태. PVC 유실 시 재구축 불가.**

---

## 🚶 진행 순서 (실제로 수행한 8단계)

### 1️⃣ 로컬 매니페스트를 클러스터 실측값으로 동기화

로컬 `20-deployment.yaml`의 메모리 limit이 `384Mi`(7/28 이전 값)였던 것을 클러스터/Gitea 실측값인 `448Mi`로 수정.
→ **Git ↔ 클러스터 ↔ 로컬 세 곳이 일치하는 기준점**을 먼저 만듦.

### 2️⃣ `git init` + `.gitignore` 보강

```gitignore
# 민감 정보 (절대 커밋 금지)
.env / .env.* / !.env.example / *.pem / *.key

# DB / 데이터
data/ / *.db* / docker-data-seed/

# Node / 런타임 산출물
node_modules/ / server.log / server.pid / server.port / *.log

# NFS 스파이 파일 / .claude / OS
.nfs* / .claude/ / .DS_Store
```

### 3️⃣ 기존 Gitea 이력 위에 올리기 (이력 보존)

`git init`만 하면 이력 0인 새 리포가 되므로, 기존 3개 커밋(`09a1c32` → `fef9194` → `5ecf45c`)을 fetch한 뒤 그 위에 커밋:
```bash
git fetch origin main
git checkout -f -b main 5ecf45c   # 원격 HEAD 위에서 새 main
```

### 4️⃣ 시크릿 누출 스캔 (커밋 전 3중 검사)

1. 패턴 스캔: `api_key|secret|password\s*[:=]\s*'…'` → 검출 0건
2. 실제 키 값 대조: `.env`의 DHS 키(36자)·Gemini 키(53자)를 스테이지된 51개 파일 전체와 문자열 비교 → **일치 0건**
3. 파일명 검사: `*.db`, `data/`, `.env`가 커밋 목록에 없는지 확인 → 없음

### 5️⃣ push 인증 문제 해결 (첫 번째 장애)

| 시도 | 결과 |
|---|---|
| `git push` (기본) | **2분 타임아웃** — credential helper가 없어 자격증명 프롬프트에서 무한 대기 |
| `~/.git-credentials`의 비밀번호 | Gitea 거부: `user's password isn't set` — 계정이 비밀번호 로그인 불가 상태로 바뀜 |
| **ArgoCD repo secret의 토큰** | ✅ 성공 — scope `write:repository` 보유 |

```bash
# 해결 방법 (이 리포의 push 표준 절차)
TOKEN=$(kubectl get secret repo-3176879643 -n argocd -o jsonpath='{.data.password}' | base64 -d)
git -c "http.extraHeader=Authorization: Basic $(printf 'kopo13:%s' "$TOKEN" | base64 -w0)" push origin main
```
> 이 토큰은 push/repo API만 가능(`/api/v1/user`는 scope 부족으로 실패 — 정상).

### 6️⃣ 실수로 복원된 위험 매니페스트 2종 제거 (두 번째 장애)

첫 push에서 로컬 `deploy/`에 남아 있던 아래 파일을 그대로 올렸는데, **둘 다 과거에 일부러 삭제했던 것들**이었다:

- `00-namespace.yaml` — 커밋 `fef9194`가 "namespaced cluster 모드 호환"을 위해 제거. 이 클러스터(vcluster)에서 ArgoCD가 Namespace 객체를 관리하면 안 됨.
- `40-externalsecret.yaml` — `jobradar-secret`은 **수동 생성 방침**(README에 명시). 특히 실제로 확인해 보니 **Vault에 `secret/jobradar` 경로가 없어서**, ExternalSecret(creationPolicy: Owner)이 apply되면 수동 Secret(DHS+GEMINI 키)을 장악하고 동기화 실패 → **키 유실 위험**.

→ ArgoCD가 감지하기 전에 `git rm --cached` 후 재push (`6afb53c`).

> **교훈: 남의 리포에 파일을 올릴 때는 "없는 파일"이 아니라 "왜 없는지"를 먼저 확인해야 한다. 삭제 커밋 메시지를 읽었어야 했다.**

### 7️⃣ checkout 덮어쓰기로 유실된 블록 복구 (세 번째 장애)

3️⃣에서 `git checkout -f`로 원격 이력을 가져올 때 **로컬 `20-deployment.yaml`이 7/28 구버전으로 조용히 되돌려졌고**, 그 상태로 첫 커밋이 됨. Gitea 버전에서:
- `GEMINI_API_KEY` env 블록 ❌ 사라짐
- initContainer `resources` 블록 ❌ 사라짐

클러스터에는 `kubectl set` 값이 남아 동작 중이라 바로 티가 안 났지만, **Git에 선언이 없으니 Pod 재생성 시 유실될 상태**였다. push 후 diff로 발견 → 복구 커밋 (`ff7df43`).

> **교훈: `git checkout -f`는 워킹트리를 통째로 덮어쓴다. 강제 checkout 후에는 반드시 `git diff`로 최종 상태를 검증하고 커밋하라.**

### 8️⃣ 16Mi 메모리 사고 — 약 3분 서비스 다운 (네 번째 장애)

ArgoCD가 `ff7df43`을 감지·적용하면서 Pod가 재생성됐는데 **Pending** 걸림:

```
Warning SyncError … pod-syncer: forbidden:
minimum memory usage per Container is 32Mi, but request is 16Mi
```

**vcluster 호스트 클러스터 정책이 컨테이너별 최소 memory request 32Mi**인데, initContainer에 16Mi를 지정했던 것. `strategy: Recreate`라 옛 Pod는 이미 종료된 뒤라 **서비스 다운**이었다.

복구: `16Mi → 32Mi` 수정 → commit → push → `kubectl annotate application … argocd.argoproj.io/refresh=normal`(즉시 반영 트리거) → Pod 재생성 → HTTP 200 확인 (`5018172`).

> **교훈: ① vcluster 리소스 하한(32Mi)을 문서화해 둘 것. ② Recreate 전략에서는 스펙 오류가 곧 다운이다 — push 전 매니페스트 lint를 하라.**

---

## ✅ 최종 결과

### 커밋 이력
```
5018172  fix(deploy): initContainer memory request 16Mi → 32Mi (vcluster 최소값)
ff7df43  fix(deploy): GEMINI env·initContainer resources 복구
c1b78fa  README: 전체 소스 리포로 내용 갱신
6afb53c  deploy: namespace/externalsecret 매니페스트 제거 (기존 방침 복원)
f3e65e4  Step 8/9 전체 소스 업로드 (51개 파일, +12,947줄)
───────── (아래는 기존 이력)
5ecf45c  GitOps 자동배포 검증: 메모리 limit 384Mi -> 448Mi
fef9194  namespace 매니페스트 제거 (namespaced cluster 모드 호환)
09a1c32  JobMarketRadar k8s 매니페스트 초기 (ArgoCD GitOps)
```

### 업로드된 것 (54개 파일)
| 분류 | 내용 |
|---|---|
| 앱 소스 | `server.js` `db.js` `ai.js` `auth.js` `collector.js` |
| 프론트 | `public/` app.js · index.html · style.css |
| 스키마 | `db/schema.sql` |
| 빌드 | `Dockerfile` `package.json` `package-lock.json` `docker-compose.yml` `Jenkinsfile` |
| 문서 | `docs/` 24종 (step1~10, ai-model-config 등) |
| 검증 | `scripts/verify-step5/8/9.js` |
| 배포 | `deploy/` 10-pvc · 20-deployment · 30-ingress · argocd · deploy.sh |

### 클러스터 최종 상태 (Git 선언과 완전 일치)
| 항목 | 값 |
|---|---|
| ArgoCD | **Synced / Healthy** @ `5018172` |
| Pod | 1/1 Running |
| 서비스 | `https://kopo13-jobradar.std.kopoctc.kr` HTTP 200 |
| DB | postings 1691 / recruits 2248 보존 |
| env | TZ · PORT · DHS_API_KEY · GEMINI_API_KEY |
| 리소스 | app 448Mi / init 32Mi requests · 64Mi limits |

---

## 🔁 재사용: 앞로운 배포 절차 (표준)

### 앱 코드를 바꿀 때 (server.js, public/ 등)
```bash
docker build -t std-harbor.kopoctc.kr/kopo13/jobradar:latest .
docker push std-harbor.kopoctc.kr/kopo13/jobradar:latest
git add -A && git commit -m "…" && <push 명령 (아래)>
kubectl -n jobradar rollout restart deployment/jobradar   # 이미지 태그가 latest라 restart 필요
```

### deploy/ 매니페스트를 바꿀 때
```bash
git add deploy/ && git commit -m "…" && <push 명령 (아래)>
# ArgoCD가 최대 3분 내 자동 감지·적용. 즉시 반영 원하면:
kubectl annotate application jobradar -n argocd argocd.argoproj.io/refresh=normal --overwrite
```

### push 명령 (비밀번호 로그인 불가 → 토큰 필수)
```bash
TOKEN=$(kubectl get secret repo-3176879643 -n argocd -o jsonpath='{.data.password}' | base64 -d)
git -c "http.extraHeader=Authorization: Basic $(printf 'kopo13:%s' "$TOKEN" | base64 -w0)" push origin main
```

---

## 🚨 이 단계의 주의사항 (다음에 반복하지 않기 위해)

| # | 주의사항 |
|---|---|
| 1 | **push 전 `git diff`로 워킹트리 최종 검증** — `checkout -f`는 로컬 수정을 조용히 되돌린다 (실제 사고: GEMINI env 유실) |
| 2 | **삭제된 파일의 커밋 메시지를 읽어라** — 없는 파일은 "못 올린 것"이 아니라 "일부러 뺀 것"일 수 있다 (namespace, externalsecret) |
| 3 | **vcluster 컨테이너 최소 memory request = 32Mi** — 이하로 push하면 pod-syncer가 거부하고 Recreate 전략이라 즉시 다운 |
| 4 | **`jobradar-secret`은 수동 생성 방침** — ExternalSecret을 Git에 넣지 않는다 (Vault에 경로 없음) |
| 5 | **시크릿 3중 스캔을 커밋 전에** — 패턴 grep → 실제 키 값 대조 → 파일명 검사 |
| 6 | **GitOps 불일치(드리프트)를 `kubectl set`으로 우회하지 않기** — 이번 GEMINI env처럼 Git에 없는 수동 변경은 언제든 selfHeal에 지워진다 |

---

## ✦ 검증 방법 (이 문서의 내용이 참인지 확인하는 명령)

```bash
# Gitea 리포가 로컬과 일치하는지
git ls-remote https://std-gitea.kopoctc.kr/kopo13/web.git refs/heads/main
# → 마지막 커밋 해시가 로커 git rev-parse HEAD 와 일치해야 함

# ArgoCD 동기화 상태
kubectl get application jobradar -n argocd          # Synced / Healthy
kubectl get application jobradar -n argocd -o jsonpath='{.status.sync.revision}'

# 서비스 생존
curl -sk https://kopo13-jobradar.std.kopoctc.kr/api/summary | head -c 120

# 시크릿이 Git에 없는지 (아무것도 나오면 안 됨)
git log --all --full-history -- '*.env' 'data/*' '*.db'
```
