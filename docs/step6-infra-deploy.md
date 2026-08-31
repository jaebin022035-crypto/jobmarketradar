# Step 6: 인프라/배포

> **기간: 1.5일** · 이 단계의 목표: 앱을 Docker로 컨테이너화하고 Jenkins 파이프라인으로 배포 자동화(CI/CD)를 구축한다.

---

## 📌 이 단계의 목표

이 단계는 **"어디서든 동일하게 실행 + 배포 자동화"** 경험을 증명하는 단계다 (계획서 3·9절). `git push`만 하면 Jenkins가 빌드·테스트·배포까지 자동으로 처리하게 만든다. K8s/ArgoCD는 이번엔 제외하고 **Jenkins + Docker**로 단순화한다 (계획서 4.1, 9절 참고).

완료하면:
- ✅ `Dockerfile` (컨테이너 이미지)
- ✅ `docker-compose.yml` (배포 실행 + 볼륨)
- ✅ `Jenkinsfile` (CI/CD 파이프라인)
- ✅ 서버에 배포되어 외부 접속 가능
- ✅ SQLite 데이터가 배포 후에도 유지됨 (볼륨)
- ✅ 배치 수집(cron)이 컨테이너 안에서 정상 동작

---

## 📋 해야 할 일 (체크리스트)

- [ ] `Dockerfile` 작성 (Node + 앱)
- [ ] `.dockerignore` 추가
- [ ] `docker-compose.yml` (앱 + SQLite 볼륨)
- [ ] 로컬에서 docker-compose로 동작 확인
- [ ] **SQLite 볼륨 영속성 검증** (재기동 후 데이터 유지)
- [ ] `Jenkinsfile` 작성 (Build → Test → Deploy)
- [ ] Jenkins 잡 생성 + git webhook(또는 폴링)
- [ ] `git push` → 자동 빌드·배포 확인
- [ ] 컨테이너 안에서 cron 수집 정상 동작 확인
- [ ] labport 외부 접속 주소로 최종 확인

---

## 🚶 진행 순서 (단계별)

### 1. `Dockerfile` 작성

가벼운 Node 이미지 기반:
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev        # 프로덕션 의존성만
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

### 2. `.dockerignore` 추가

이미지에 불필요한 파일 제외 (빌드 속도 + 보안):
```
node_modules
.env
*.db
*.db-journal
server.log
server.pid
server.port
.git
```
> ⚠️ `.env`와 `.db`를 이미지에 넣으면 안 됨. `.env`는 런타임 주입, `.db`는 볼륨으로.

### 3. `docker-compose.yml` (가장 중요)

```yaml
services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - WORKNET_API_KEY=${WORKNET_API_KEY}   # 호스트 .env에서 주입
    volumes:
      - app-data:/app/data                    # SQLite 파일 영속화 ★
    restart: unless-stopped
volumes:
  app-data:
```

> 💡 **이 단계의 가장 큰 함정**: SQLite 파일 경로를 컨테이너 내부 경로(예: `/app/data/app.db`)로 잡고, 그 경로를 **볼륨에 마운트**해야 배포마다 데이터가 날아가지 않는다.

### 4. 로컬에서 docker-compose 동작 확인

```bash
docker compose up --build
```
- 서버 기동 로그 확인
- 브라우저에서 대시보드 표시 확인
- API 응답 확인

### 5. SQLite 볼륨 영속성 검증 (반드시)

배포마다 데이터가 날아가는지 확인:
```bash
# 1) 수집으로 데이터 채우기 (POST /api/admin/collect 또는 직접)
# 2) 컨테이너 재기동
docker compose down && docker compose up -d
# 3) 데이터가 그대로 있는지 확인
```
> ⚠️ 데이터가 0이 되면 볼륨 매핑이 잘못된 것. `db.js`의 DB 경로와 compose의 volume 경로가 **일치**해야 함.

### 6. `Jenkinsfile` 작성 (CI/CD)

계획서 9절의 파이프라인:
```groovy
pipeline {
  agent any
  stages {
    stage('Build') {
      steps {
        sh 'docker compose build'
      }
    }
    stage('Test') {
      steps {
        // 스모크 테스트: 핵심 API 응답 확인
        sh 'curl -sf http://localhost:3000/api/summary'
      }
    }
    stage('Deploy') {
      steps {
        sh 'docker compose down && docker compose up -d'
      }
    }
  }
}
```

**주요 단계 (계획서 9절):**
- **Build** : Docker 이미지 생성
- **Test** : `/api/summary` 등 핵심 엔드포인트 응답 확인 (스모크 테스트)
- **Deploy** : `docker compose down/up` 으로 컨테이너 재기동

### 7. Jenkins 잡 + 트리거

- Jenkins에 새 Item(Pipeline) 생성
- 소스: GitHub 레포, `develop`/`main` 브랜치
- `Jenkinsfile` 경로 지정
- 트리거: git push 감지(webhook) 또는 주기 폴링

### 8. `git push` → 자동 배포 확인

```bash
git push origin develop
# → Jenkins 감지 → Build → Test → Deploy
# → 브라우저에서 변경사항 반영 확인
```

### 9. 컨테이너 안 cron 수집 확인

수집기의 `node-cron`은 **서버 프로세스 안에서** 도는 것(계획서 3절). 컨테이너가 계속 떠 있으므로 cron도 동작한다.
- 단기 cron(`*/5 * * * *`)으로 테스트 → 로그(`collection_logs`)에 실행 이력 쌓이는지 확인
- 확인 후 실제 주기(예: 매일 새벽)로 되돌림

### 10. labport 외부 접속 최종 확인

```bash
echo "외부 주소: https://aisw-lab.kopoctc.kr/g/$(basename "$HOME")/$(basename "$PWD")/"
```
외부 주소로 접속해 대시보드가 정상 동작하는지 최종 확인.

---

## ⚠️ 주의사항

1. **💾 SQLite 볼륨 영속성 — 최우선** — 볼륨 매핑 없으면 `docker compose down`할 때마다 데이터 날아감. `db.js` 경로 ↔ compose volume 경로 일치 필수.
2. **🔑 `.env` 주입 방식** — `.env`를 이미지에 넣지 말고 compose의 `environment:` 또는 `env_file:`로 런타임 주입.
3. **🌐 포트/바인드** — 로컬 테스트는 호스트 포트 매핑. labport 실배포는 `start_server.sh` 규칙(`--bind 0.0.0.0`, 고유 포트) 따를 것.
4. **🔁 cron은 서버 프로세스 안** — 별도 컨테이너가 아니라 `server.js` 시작 시 등록. 컨테이너가 죽으면 cron도 멈추므로 `restart: unless-stopped` 필수.
5. **⏰ 컨테이너 시간대** — cron "새벽 3시"가 의도대로 가려면 컨테이너 TZ를 `Asia/Seoul`로 (기본은 UTC라 9시간 어긋남).
6. **🧪 Test 단계는 가볍게** — 무거운 단위테스트 말고 핵심 API 응답 여부만(스모크). 배포 지연 방지.
7. **🔐 Jenkins credentials** — Jenkins에 깃/서버 접근 권한은 credentials로 관리, 평문 노출 금지.
8. **📦 이미지 크기** — `node:alpine` + `--omit=dev`로 가볍게.
9. **🚫 K8s/ArgoCD는 이번 제외** — 일정 리스크. Jenkins+Docker까지만 (계획서 9절 권고).

---

## ✅ 완료 기준 (산출물)

- [ ] `docker compose up` 으로 로컬에서 동작
- [ ] 컨테이너 재기동 후 **SQLite 데이터 유지** 확인
- [ ] `Jenkinsfile` 파이프라인 통과 (Build→Test→Deploy)
- [ ] `git push` → 자동 배포 확인
- [ ] 컨테이너 안에서 cron 수집 정상 동작
- [ ] labport 외부 주소로 접속 시 대시보드 정상

---

## 🎉 프로젝트 완료

모든 단계(1~6)를 마치면 **공공데이터 배치 수집 → 집계 분석 → 대시보드 시각화 → CI/CD 배포** 까지 갖춘 완성형 데이터 분석 웹이 된다.

취업용 어필 포인트(계획서 10절)를 README에 정리:
1. 공공데이터 API 연동 + 배치 자동 수집
2. GROUP BY 기반 데이터 집계/분석 설계
3. Git + Jenkins CI/CD
4. Docker 컨테이너화
5. 실사용 시각화 대시보드
6. 단계별 커밋 히스토리
7. 아키텍처 도면 + 수집 스케줄 설명

---

## 🔙 돌아가기

**[← 전체 가이드 인덱스](./README.md)**
