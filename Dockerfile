# syntax=docker/dockerfile:1
# JobMarketRadar 컨테이너 이미지 (Step 6)
# - node:20-slim 기반 (가볍게)
# - better-sqlite3 네이티브 모듈 컴파일 → 멀티스테이지로 빌드 도구는 런타임에 남기지 않음
# - data/ 는 런타임 볼륨으로 마운트 (이미지에 넣지 않음 → 배포마다 데이터 날아가는 것 방지)
#
# 참고: 이 환경(labport)에는 Docker가 없어 실제 빌드/실행은 하지 않음.
#       산출물로서 "어디서든 동일하게 실행 가능한 컨테이너 정의"를 남긴 것.
#       로컬 검증은 docker compose up --build 로 (Step 6 문서 4절).

# ---------- 1단계: 빌드 (의존성 + 네이티브 컴파일) ----------
FROM node:20-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 바인딩 컴파일용 빌드 도구
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# 의존성 먼저 복사 → 캐시 효율 (소스 변경에도 npm ci 스킵)
COPY package.json package-lock.json ./
RUN npm ci

# 앱 소스 복사 (data/, .env, *.db 등은 .dockerignore 로 제외됨)
COPY . .

# ---------- 2단계: 런타임 (가벼운 이미지) ----------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# 컨테이너 시간대 → cron "0 9,21 * * *" 가 KST(오전9시/오후9시)로 동작 (기본 UTC는 9시간 어긋남)
ENV TZ=Asia/Seoul

# 빌드 결과물만 복사 (빌드 도구 python3/g++ 제외 → 이미지 가벼움)
# 주의: COPY/ADD 행 끝에는 인라인 주석 불가(경로로 오인됨) → 주석은 별도 행으로.
#   /app/db       : schema.sql (db.init() 이 읽음)
#   /app/public   : 정적 프론트
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/server.js ./
COPY --from=build /app/db.js ./
COPY --from=build /app/collector.js ./
COPY --from=build /app/ai.js ./
# Step 8: 로그인/세션 모듈 (누락 시 서버 기동 실패 — server.js 가 require)
COPY --from=build /app/auth.js ./
COPY --from=build /app/db ./db
COPY --from=build /app/public ./public

# 마이그레이션 시드 DB — 기존 수집 데이터(약 580건)를 이미지에 포함.
# initContainer 가 PVC(영속 볼륨)가 비어있을 때만 /app/data 로 복사.
# 런타임에는 /app/data (PVC) 가 우선하므로, 이 시드는 최초 1회 초기화 용도.
COPY docker-data-seed/jobmarket.db /app/data-seed/jobmarket.db

# data/ 는 컨테이너 안에서 생성 + 볼륨 마운트 대상 (docker-compose.yml 참조)
RUN mkdir -p /app/data

EXPOSE 3000
# PORT 는 .env/compose 로 주입 (기본 3000)
CMD ["node", "server.js"]
