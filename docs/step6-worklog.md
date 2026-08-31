# Step 6 — 인프라/배포: 수동배포 작업 로그

> **상태: 수동배포 완료 (labport 실배포 방식)** · 자동배포(Jenkins CI/CD)는 다음 단계

---

## 1. 결정: Docker 기반 수동배포 → labport 실배포 방식으로 대체

`docs/step6-infra-deploy.md` 의 수동배포(1~5절)는 **Docker 컨테이너 빌드/실행**을 전제로 한다.
하지만 현재 labport 개발 환경은:

| 항목 | 상태 |
|---|---|
| Docker / podman | ❌ 미설치 (`apt-cache` 에 후보는 있으나 설치 안 됨) |
| sudo | ❌ 없음 |
| 외부 공개 | `start_server.sh` + Traefik (server.port 자동 감지 공개) |
| Node.js | ✅ v20 설치 |

→ 컨테이너를 직접 띄워 외부 공개하는 것은 불가능.
대신 **labport 표준 방식(Node 직접 실행 + Traefik 자동 공개)**으로 실배포하고,
**Docker 산출물(Dockerfile/compose/Jenkinsfile)은 "어디서든 동일 실행 가능"을 증명하는 포트폴리오 산출물로 작성**했다.

> 결론: 동일한 앱을 두 경로에서 모두 실행 가능하도록 정의.
> - **실배포(지금)**: `start_server.sh` → Node 서버 → Traefik 외부 공개
> - **이식 배포(Docker 환경)**: `docker compose up --build` (산출물 준비 완료)

---

## 2. 실배포 (labport 방식)

### 실행
```bash
bash start_server.sh
# → PORT=12355, node server.js (setsid, 0.0.0.0 bind)
# → server.port / server.pid 기록 → Traefik 자동 공개
```

### 검증 결과 (2026-07-21)
| 항목 | 결과 |
|---|---|
| 프로세스 | ✅ pid 15492, 0.0.0.0:12355 bind |
| `/api/summary` | ✅ `{"totalPostings":263,"totalRecruits":368,...}` |
| `/` (정적 index.html) | ✅ HTTP 200, 10.4KB |
| DB 영속성 | ✅ `data/jobmarket.db` (925KB) — 재기동 후에도 유지 (파일 기반) |
| cron 자동수집 | ✅ `0 9,21 * * *` 등록 로그 확인 |

### 외부 접속 주소
```
https://aisw-apps.kopoctc.kr/g/kopo13/JobMarketRader/
```
> Traefik이 `server.port`(12355)를 감지해 자동 공개. 학생이 별도 버튼 없이 접속 가능.

---

## 3. Docker 산출물 (포트폴리오용 — 실제 빌드는 Docker 환경에서)

> 이 환경엔 Docker가 없어 `docker compose up` 은 실행하지 않았다.
> 대신 **이 프로젝트에 맞게 정합성을 갖춘 정의**를 남겼다 (Docker 지원 환경으로 가져가면 바로 동작).

| 파일 | 역할 | 핵심 |
|---|---|---|
| `Dockerfile` | 컨테이너 이미지 | 멀티스테이지(build→runtime). `better-sqlite3` 네이티브 컴파일(build에 python3/make/g++) 후 런타임엔 미포함(가벼움). `TZ=Asia/Seoul`. |
| `.dockerignore` | 이미지 제외 | `.env`, `*.db`, `data/`, `node_modules` 제외 → 시크릿/데이터 보호 + 빌드 캐시 효율 |
| `docker-compose.yml` | 배포 실행 + 볼륨 | `./data:/app/data` ★SQLite 영속화★, `env_file: .env`, `restart: unless-stopped`, healthcheck(`/api/summary`) |
| `Jenkinsfile` | CI/CD 파이프라인 | Build → Test(스모크 `/api/summary`) → Deploy(down→up). credentials로 API키 주입. |

### 정합성 체크 (실제 코드와 일치)
- **DB 경로**: `db.js` → `data/jobmarket.db` ↔ compose 볼륨 `./data:/app/data` → 컨테이너 `/app/data/jobmarket.db` ✅
- **포트**: `server.js`(3000) ↔ Dockerfile `EXPOSE 3000` ↔ compose `3000:3000` ✅
- **env 변수**: `.env.example`(`DHS_API_KEY`/`PORT`/`CRON_SCHEDULE`) ↔ compose/Jenkinsfile ✅

### Docker 환경에서 검증하는 법 (이 환경 외부에서)
```bash
docker compose up --build
# 1) 데이터 채우기: curl -X POST http://localhost:3000/api/admin/collect
# 2) 재기동 후 유지 확인: docker compose down && docker compose up -d  → 데이터 0이면 볼륨 매핑 오류
```

---

## 4. ⚠️ 함정 대비 (Step 6 주의사항 반영)
1. **SQLite 영속성(최우선)** — `db.js` 경로 ↔ 볼륨 경로 일치 확인 ✅ (위 정합성 체크)
2. **`.env` 주입** — 이미지에 넣지 않고 compose `env_file` / Jenkins credentials 사용 ✅
3. **포트/바인드** — Docker는 호스트 매핑, labport는 `start_server.sh` 규칙(`--bind 0.0.0.0`) ✅
4. **cron은 서버 프로세스 안** — `server.js` 시작 시 등록, `restart: unless-stopped` 로 생존 보장 ✅
5. **TZ** — `TZ=Asia/Seoul` 설정 (UTC 9시간 어긋남 방지) ✅
6. **Test 단계는 가볍게** — 핵심 API 응답 여부만 (스모크) ✅
7. **Jenkins credentials** — API키 평문 노출 금지, credentials로 ✅
8. **이미지 크기** — `node:slim` + 멀티스테이지(빌드 도구 제거) ✅

---

## 5. 남은 일 (자동배포 — 다음 단계)
- [ ] Jenkins 잡 생성 + `Jenkinsfile` 연결
- [ ] git push → Build→Test→Deploy 자동화 확인
- [ ] webhook 또는 폴링 트리거 설정
- [ ] Jenkins credentials(`jobmarketradar-dhs-api-key`) 등록
> Jenkins는 이 labport 환경에 없으므로, 자동배포 단계는 **Docker/Jenkins 환경(별도 서버)에서** 진행해야 한다.

---

## 🔙 돌아가기
**[← 전체 가이드 인덱스](./README.md)** · **[← Step 6 인프라/배포 가이드](./step6-infra-deploy.md)**
