# JobMarketRadar 발표 슬라이드 — 7페이지 구성안

> 출처: `public/tech-stack.html` (기술 스택) + `public/deploy-pipeline.html` (배포 파이프라인)
> 발표 시간 가정: 10~15분. 각 페이지 = 슬라이드 1장.
> 시각화 아이디어는 두 HTML 페이지에 이미 그림이 있으니캡처(캡처)해서 붙이면 바로 쓰임.

---

## P1 · 표지 — JobMarketRadar: 채용시장 레이더

**한 줄 메시지:** "외부 SaaS 없이, Node.js 단일 프로세스로 만드는 채용 트렌드 대시보드 + AI 자소서 도구"

| 항목 | 내용 |
|---|---|
| 프로젝트 | JobMarketRadar |
| 정체성 | ① 채용시장 트렌드 대시보드 ② AI 자기소개서 작성 도구 |
| 운영 URL | `https://kopo13-jobradar.std.kopoctc.kr` (교내) · `https://kopo13.kokailab.com` (외부) |
| 발표 포인트 | "작지만 검증된 시스템" — 모든 숫자가 실측값임을 예고 |

**시각화:** 실제 대시보드 스크린샷 + URL 2개.
**발표 팁 (30초):** "이 프로젝트는 만듭니다-올립니다 끝이 아니라, 실제 장애에서 배운 운영 규칙까지 있는 게 특징입니다. 뒤에서 그 이야기까지 하겠습니다."

---

## P2 · 아키텍처 — 한눈에 보는 네 층

**한 줄 메시지:** "마이크로서비스가 아니라 계층화된 모놀리스 — 프로세스 하나 안에서 네 층이 함께 뜬다"

```
[프레젠테이션]  바닐라 JS (ES2023) · Chart.js 4.4.1 · CSS 단일 파일
      ↓ HTTP · JSON (/api/* 로만 통신)
[애플리케이션]  Express 4.19 (33 라우트) · Node 내장 crypto · node-cron
      ↓ AI 호출 · XML 파싱 · 동기 쿼리
[데이터]       SQLite (WAL, better-sqlite3) · 고용24 Open API · Gemini API
      ↓ PVC 마운트 · 컨테이너 런타임
[인프라]       Docker 멀티스테이지 · vcluster/RKE2 · Harbor+GitHub · Cloudflare Tunnel
```

**수치 4개 (큰 숫자로 배치):** npm 의존성 **6** · REST 라우트 **33** · 테이블 **9** · 수집 공고 **1,691**

**시각화:** tech-stack.html의 "한눈에 보는 네 층" 레이어 다이어그램 캡처.
**발표 팁:** "층 사이 화살표가 하나뿐인 게 핵심입니다. 프론트는 /api로만 말하고, 서버가 나머지를 다 합니다."

---

## P3 · 기술 선택 — "유명해서"가 아니라 제약에서 나온 선택

**한 줄 메시지:** "각 선택에는 이 프로젝트의 제약이 만든 이유가 있다"

4개만 크게, 나머지는 작게 (발표 시간 없으면 4개만 말하기):

1. **SQLite + better-sqlite3** — 1일 2회 배치 쓰기 + 대시보드 읽기 = 동시성 불필요. 파일 하나가 곧 백업. WAL로 읽기-쓰기 충돌 회피
2. **바닐라 JS** — 화면 4개, "바뀌면 다시 fetch해서 그리기"로 충분. 빌드 파이프라인 0
3. **Gemini 2단 모델** — 기계적 정제는 `flash-lite`(빠름·저가), 품질 민감한 분석·자소서는 `flash`. SDK 없이 REST 직접 호출 → 모델 교체 = 환경변수 한 줄
4. **Node 내장 crypto** — scrypt(N=16384) 해시 + 세션 토큰 SHA-256 이중 해시. bcrypt 없이 OWASP 권장 파라미터, 의존성 0

(보조로 작게: 멀티스테이지 Docker — native 빌드 도구를 런타임 이미지에 안 넣음 / ArgoCD GitOps — 배포 이력 = 커밋 이력)

**시각화:** 4개 카드 레이아웃 (tech-stack.html "왜 이 기술인가" 섹션 캡처).

---

## P4 · 데이터 모델과 보안 설계

**한 줄 메시지:** "소유 관계가 스키마에 드러나고, 모든 개인 데이터는 소유자 검사를 통과해야 보인다"

**왼쪽 — 9개 테이블 (간단 다이어그램):**
- 공유 데이터: `job_postings` →(1:N) `job_recruits`, `collection_snapshots`, `collection_logs`
- 개인 데이터: `users` → `sessions` / `profiles` → `cover_letters` → `generation_logs` (ON DELETE CASCADE)

**오른쪽 — 보안 3 원칙:**
1. **소유자 스코프** — 남의 리소스는 403이 아니라 **404** (존재 미노출 → ID 열거 공격 불가)
2. **세션** — 5분 슬라이딩 + 3분 하트비트, 만료 세션은 하트비트로 부활 불가, 쿠키 HttpOnly+SameSite=Lax
3. **시크릿** — API 키는 환경변수만. Git·이미지 어디에도 없음. 로그인 실패 응답 통일 (계정 존재 추측 불가)

**시각화:** 테이블 관계 화살표 + 잠금 아이콘 3개 카드.

---

## P5 · 배포 파이프라인 — 두 갈래가 한 Pod에서 수렴

**한 줄 메시지:** "진실의 소스는 Git. ArgoCD가 클러스터를 계속 Git 상태로 되잡는다 (GitOps)"

```
       [로컬] 앱 소스 + deploy/ 매니페스트
              ├─ 이미지 경로:  docker build → Harbor (jobradar:latest)
              └─ 매니페스트 경로: git push → GitHub main (ArgoCD가 deploy/만 감시)
                      ↓ 자동 수렴 (automated · selfHeal · prune)
       [vcluster ns=jobradar] Deployment(recreate, 1 replica)
            · PVC(SQLite 1,691건 영속) · Secret(수동) · Service+Ingress
                      ↓
       [외부] traefik ← Cloudflare Tunnel  →  kopo13.kokailab.com
```

**핵심 용어 3개만 설명:**
- **selfHeal** — kubectl로 손대면 Git 상태로 되돌려짐
- **prune** — Git에서 지우면 클러스터에서도 삭제
- **latest 태그 함정** — 스펙 변화 없음 → ArgoCD도 안움 → `rollout restart` 필요 (P6 연결)

**시각화:** deploy-pipeline.html "전체 흐름" 도식 캡처 (가장가장 잘 빠진 그림).
**발표 팁:** "매니페스트 변경은 git push 1단계로 끝납니다. 3분 내 자동 반영."

---

## P6 · 자동화 사이 남은 수동 3곳 + 변경 경로 비교

**한 줄 메시지:** "완전 자동화는거짓이다 — 남긴 3곳엔 이유가 있다"

**왼쪽 — 경로 비교 표:**

| 무엇을 바꾸나 | 경로 | 수동 단계 |
|---|---|---|
| 앱 코드 | build → push → rollout restart (+git push) | **3** |
| 매니페스트 | git push → ArgoCD 자동 | **1** |
| API 키 | secret patch → rollout restart | **2** (Git 불필요 — ignoreDifferences) |

**오른쪽 — 수동 개입 3곳 (주황):**
1. **REPO** — GitHub가 ArgoCD 익명 fetch 거부 → ArgoCD ns에 read-only repo secret 등록 (push는 표준 credential helper로 간단해짐, 2026-10-07 Gitea→GitHub 전환)
2. **ROLL** — latest 태그라 이미지 교체 감지 불가 → 직접 재시작 신호
3. **SECR** — Vault 경로 없어 Secret 수동 생성 → ArgoCD `/data` 무시 설정

**발표 팁:** "여기서 '왜 자동화하지 않았나'를 아는 게 이 프로젝트 운영의 핵심입니다."

---

## P7 · 운영 가드레일 — 실제 사고에서 나온 규칙 6 + 검증 5단계

**한 줄 메시지:** "이 슬라이드의 6줄은 전부 그날의 장애 가격이다"

**가드레일 6개 (각 1줄):**
1. **32Mi** — vcluster memory request 최소 32Mi. 16Mi 지정 시 pod-syncer 거부 → 3분 다운
2. **DIFF** — `git checkout -f`가 로컬 수정을 조용히 되돌림 → push 전 `git diff` 필수
3. **PRUN** — prune+selfHeal 아래 수동 kubectl 변경은 언제든 삭제 → 매니페스트로 고친다
4. **WHY** — 없는 파일(00-namespace 등)엔 이유가 있다 → 삭제 커밋 메시지부터 읽어라
5. **MERG** — develop→main 병합 시 `git diff main..develop -- deploy/` 감사
6. **KYVR** — 외부 도메인 Ingress는 Kyverno에 막힘 → cloudflared `httpHostHeader`로 Host 재작성 (012466e→64ad3b8)

**검증 5고리 (마지막 줄):** 로컬 Git = GitHub = ArgoCD = Pod digest = 외부 URL 200 — "네 고리가 같은 것을 가리키는지 확인한다"

**클로징 (마지막 한 줄, 크게):**
> "만드는 것보다 지키는 게 시스템이다 — 배포 이력은 커밋 이력, 장애 이력은 규칙이 된다."

---

## 부록: 페이지별 시간 배분 (15분 기준)

| P1 | P2 | P3 | P4 | P5 | P6 | P7 |
|---|---|---|---|---|---|---|
| 1분 | 2분 | 3분 | 2분 | 3분 | 2분 | 2분 (클로징 포함) |

Q&A 예상 질문: 왜 마이크로서비스 아냐 / SQLite 확장은 / latest 태그 개선안 (digest 고정 push 시 매니페스트 tag 변경 커밋)
