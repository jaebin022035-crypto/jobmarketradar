# Step 6: 인프라/배포 — 환경 제약과 두 배포 경로

> **작업일: 2026-07-21 검증 완료** · 목표: "어디서든 동일하게 실행 + 배포 자동화" 증명.

---

## 1. 결정: Docker 실배포 불가 → 두 경로 분리 (실패→복구 사례)

계획은 Docker + Jenkins CI/CD 실배포였으나, labport 환경 실측 결과:

| 항목 | 상태 |
|---|---|
| Docker / podman | ❌ 미설치 (apt 후보만 있음) |
| sudo | ❌ 없음 |
| Node.js | ✅ v20 |

→ 컨테이너를 직접 띄워 외부 공개하는 것은 불가능. **대체 결정:**
- **실배포**: labport 표준 방식 — `start_server.sh`(Node 직접 실행) + Traefik 자동 외부 공개
- **이식 배포**: Docker 산출물(Dockerfile/compose/Jenkinsfile)은 "어디서든 동일 실행 가능"을 증명하는 산출물로 작성. `docker compose up`은 이 환경에서 실행하지 않았고, 대신 **DB 경로·포트·env 3자 정합성 체크**로 품질 보증
- Jenkins도 이 환경에 없어 자동배포는 별도 Docker/Jenkins 서버에서 (이후 Step 10에서 vcluster+ArgoCD GitOps로 실현)

---

## 2. 실배포 검증 결과 (2026-07-21)

```
https://aisw-apps.kopoctc.kr/g/kopo13/JobMarketRader/
```

| 항목 | 결과 |
|---|---|
| 프로세스 | ✅ pid 15492, 0.0.0.0:12355 bind (Traefik이 `server.port` 감지해 자동 공개) |
| `/api/summary` | ✅ `{"totalPostings":263,"totalRecruits":368,...}` (당시 백필 직후 수치) |
| `/` 정적 서빙 | ✅ HTTP 200, 10.4KB |
| DB 영속성 | ✅ `data/jobmarket.db` 925KB — 재기동 후 유지 (파일 기반) |
| cron 자동수집 | ✅ `0 9,21 * * *` 등록 로그 확인 |

---

## 3. Docker 산출물과 정합성

| 파일 | 핵심 |
|---|---|
| `Dockerfile` | 멀티스테이지(build→runtime). `better-sqlite3` 네이티브 컴파일(python3/make/g++)을 build에 격리, 런타임엔 빌드 도구 제거로 가볍게. `TZ=Asia/Seoul` |
| `.dockerignore` | `.env`, `*.db`, `data/`, `node_modules` 제외 — 시크릿/데이터 보호 |
| `docker-compose.yml` | `./data:/app/data` SQLite 볼륨 영속화, `env_file`, `restart: unless-stopped`, healthcheck(`/api/summary`) |
| `Jenkinsfile` | Build → Test(스모크) → Deploy(down→up), API키는 credentials 주입 |

**정합성 체크 (실제 코드와 일치 확인)**
- DB 경로: `db.js`의 `data/jobmarket.db` ↔ compose 볼륨 `/app/data` ✅
- 포트: server.js(3000) ↔ EXPOSE 3000 ↔ compose 3000:3000 ✅
- env: `.env.example`(`DHS_API_KEY`/`PORT`/`CRON_SCHEDULE`) ↔ compose/Jenkinsfile ✅

**Docker 환경으로 가져갔을 때 검증 절차**
```bash
docker compose up --build
curl -X POST http://localhost:3000/api/admin/collect   # 데이터 채우기
docker compose down && docker compose up -d            # 재기동 후 데이터 0이면 볼륨 매핑 오류
```

---

## 4. 함정 체크리스트 (반영 완료)

1. **SQLite 영속성(최우선)** — `db.js` 경로 ↔ 볼륨 경로 일치
2. **`.env`는 이미지에 넣지 않음** — `env_file`/credentials 런타임 주입
3. **cron은 서버 프로세스 안** — 컨테이너 재시작과 운명 공유, `restart: unless-stopped` 필수 (실운영에서 재기동으로 cron 끊긴 사례 → [collection-cycle.md](./collection-cycle.md))
4. **TZ** — 컨테이너 기본 UTC라 cron 9시간 어긋남 → `TZ=Asia/Seoul`
5. **Test 단계는 스모크만** — 무거운 단위테스트는 배포 지연 유발
6. **K8s/ArgoCD는 이 단계에서 제외** — "일정 리스크"로 보류했다가 이후 vcluster 환경에서 도입 ([step10-gitops-gitea-sync.md](./step10-gitops-gitea-sync.md))

> 3뷰 구조(대시보드/인사이트/맞춤공고) 설계: [step6-views-plan.md](./step6-views-plan.md)
