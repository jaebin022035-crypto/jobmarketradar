# Step 7 · 이력서 관리 페이지 — 설계 문서

> **AI 자기소개서 작성 기능** — 사용자의 이력/기술/포트폴리오를 입력하면, 직무와 **지원 회사**에 맞춰 자기소개서를 AI가 자동 작성·저장하는 페이지
> JobMarketRadar 4번째 탭 · 2026-08-05 ~ (구현 완료 · v20260805_8 배포)

---

## 0. 한 줄 소개

**"내 이력을 한 번 입력하면, 원하는 직무와 회사에 맞춰 자소서를 AI가 써준다"**
직무를 바꾸면 같은 이력에서 해당 직무 자소서로, **회사명을 입력하면 그 회사의 이상향(인재상·핵심가치)을 반영**해 다시 생성해 주는 것이 핵심 차별점.

---

## 1. 핵심 요구사항 (확정 · 구현 반영)

| 항목 | 결정 | 비고 |
|---|---|---|
| AI 엔진 | **Gemini API** (현재) | 교체 대비 추상화 — 상세는 [[step7-resume-ai]] |
| AI 키 관리 | **서버 환경변수** `GEMINI_API_KEY` | DHS_API_KEY 패턴과 동일 |
| 데이터 저장 | **SQLite** (신규 3 테이블) | 기존 db.js 구조 준수 |
| 자소서 구조 | **표준 5항목** | 지원동기/성장과정/성격장단점/직무경험/입사후포부 |
| 작성 방식 | AI 초안 → **직접 수정** | 에디터에서 자유 편집, 수정본 저장 |
| 핵심 기능 ① | **직무 변경 → AI 재생성** ★ | 같은 프로필, 다른 직무 자소서 파생 |
| 핵심 기능 ② | **회사 맞춤 작성** ★ | 회사명 입력 → 그 회사 인재상·핵심가치 반영 |
| 핵심 기능 ③ | **항목별 강조 포인트** ★ | 프로필에 항목마다 강조할 기술/일화 지정 → 한 경험 반복 방지 |
| 프로필 | **다중 프로필** | 예: 백엔드지원용 / 프론트지원용 |
| 직무 타겟팅 | **수집 데이터 연동** | 워크넷 job_category 드롭다운 (차별점) |
| UI 패턴 | **마스터-디테일** | 리스트 모드(자소서 목록+AI카드) ↔ 에디터 모드 |
| 관계 | **프로필 1 : 자소서 N** | 한 프로필에서 여러 직무/회사 자소서 파생 |
| AI 실패 처리 | 에러 메시지 + **재시도** | 네트워크/할당량 오류 대비 |
| 항목 길이 | 항목당 **300~500자** | 기업 제출용 표준 |

---

## 2. 데이터 모델 (SQLite 3 테이블)

```
┌─────────────────┐       ┌──────────────────────┐       ┌─────────────────────┐
│   profiles      │ 1   N │   cover_letters      │ 1   N │  generation_logs    │
│ (다중 프로필)   ├──────►│ (자소서)             ├──────►│ (AI 생성 이력)      │
└─────────────────┘       └──────────────────────┘       └─────────────────────┘
```

### profiles — 사용자 프로필 (다중)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | INTEGER PK | 자동증가 |
| name | TEXT | 프로필명 (예: "백엔드 지원용") |
| experience | TEXT | 경력/경험 (자유 텍스트) |
| skills | TEXT | 기술/스택 (예: "Java, Spring, MySQL, Docker") |
| portfolio | TEXT | 포트폴리오 (링크/설명) |
| **emphasis** | TEXT (JSON) | **항목별 강조 포인트** `{"motivation":..,"growth":..,"strength":..,"career":..,"vision":..}` — 어느 기술/일화를 어느 항목에 강조할지 (AI 작성 요구사항). 비운 항목은 AI가 자유 선택. 한 경험 반복 방지. — Step 7 추가 |
| created_at / updated_at | TEXT | 생성/수정시각 ISO |

### cover_letters — 자기소개서 (프로필 1:N)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | INTEGER PK | 자동증가 |
| profile_id | INTEGER FK | → profiles.id (CASCADE) |
| title | TEXT | 자소서 제목 |
| target_job | TEXT | 타겟 직무 (워크넷 job_category) |
| **company** | TEXT | **지원 회사명** (입력 시 그 회사 인재상 반영) — Step 7 추가 |
| motivation/growth/strength/career/vision | TEXT | 5개 항목 |
| created_at / updated_at | TEXT | 생성/수정시각 ISO |

> `company` 컬럼은 배포 후 자동 마이그레이션(`db.js init`의 `ALTER TABLE`)으로 기존 DB에 추가됨.

### generation_logs — AI 생성 이력 (디버깅/비용 추적)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | INTEGER PK | 자동증가 |
| cover_letter_id | INTEGER FK | → cover_letters.id |
| action | TEXT | generate / regenerate |
| model | TEXT | 사용 모델 (예: gemini-2.5-flash) |
| target_job / company | TEXT | 생성 시 타겟 직무/회사 |
| status / error | TEXT | success / fail + 메시지 |
| tokens | INTEGER | 사용 토큰 수 |
| created_at | TEXT | 생성시각 ISO |

> FK + ON DELETE CASCADE: 프로필 삭제 → 자소서 → 생성이력까지 연쇄 삭제.

---

## 3. 백엔드 API 명세

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/target-jobs` | 워크넷 직종 목록 (job_category 연동, 빈도순 100개) |
| GET/POST/PUT/DELETE | `/api/profiles[/:id]` | 프로필 CRUD |
| GET/POST/PUT/DELETE | `/api/cover-letters[/:id]` | 자소서 CRUD (company 포함) |
| POST | `/api/cover-letters/:id/generate` | **5항목 초안 생성** (프로필+직무+회사 → AI) |
| POST | `/api/cover-letters/:id/regenerate` | **직무/회사 변경 재생성** ★ |

**회사 맞춤 + 항목별 강조 생성 흐름** (`generateLetter` in server.js):
1. 자소서의 `target_job` → 워크넷 수집 데이터에서 해당 직종 경력/학력 요건 요약 → `jobContext`
2. 자소서의 `company` → 프롬프트에 "그 회사 인재상·핵심가치 반영" 지시
3. 프로필의 `emphasis` → 프롬프트에 "각 항목에 강조할 기술/일화" + "한 경험 반복 금지" 지시
4. `ai.buildPrompt({ profile, targetJob, jobContext, company, emphasis })` → `ai.generate()` → 5항목 저장

---

## 4. 프론트 UI (마스터-디테일 패턴)

우측 패널은 **3가지 상태**를 오가며 동작:

```
프로필 클릭 → [리스트 모드]                     자소서/AI카드 클릭 → [에디터 모드]
┌───────────────────────────┐                   ┌────────────────────────────┐
│ 📝 자기소개서              │                   │ 📝 자기소개서              │
│                           │                   │ [← 목록으로] 제목미리보기   │
│ [저장된 자소서]            │                   │ 제목 / 직무 / 회사 입력칸   │
│ • 카카오 백엔드 (소프트웨어)│  ← 클릭           │ 💡 회사 인재상 반영 힌트    │
│ • 네이버 백엔드 (웹개발)   │                   │ [🤖 AI초안][🔄재생성][💾저장]│
│                           │                   │   [삭제]                    │
│ ┌─────────────────────┐   │                   │ 5개 항목 textarea          │
│ │🤖 AI로 초안 생성  ＋ │   │  ← 카드 클릭       └────────────────────────────┘
│ │  직무 선택하면 자동  │   │
│ └─────────────────────┘   │
└───────────────────────────┘
```

### 상태 전환 규칙
| 트리거 | 전환 |
|---|---|
| 프로필 미선택 | `showEditorEmpty()` |
| 프로필 선택 | `showListView()` (자동 에디터 오픈 X) |
| 자소서 클릭 / AI카드 클릭 | `openEditor()` |
| 💾 저장 / 삭제 | `showListView()` (리스트로 복귀) |
| ← 목록으로 | `showListView()` (수정본 미저장) |

### 핵심 UX 개선 (반복 튜닝 완료)
- **단계 chip** (헤더): "직무 선택 → AI 초안 생성" / "수정 중" / "저장 완료!" 등 현재 할 일 표시
- **직무 미선택 시 AI 생성 차단** + 안내
- **회사명 입력 시 힌트 실시간 갱신**: "🏢 카카오의 인재상·핵심가치를 반영합니다"
- **프로필 개수 정합성**: `refreshProfilesState()`로 자소서 생성/삭제 시 좌측 프로필 카운트 갱신

---

## 5. AI 프롬프트 (회사 맞춤 + 항목별 강조)

`ai.js buildPrompt()`:
```
당신은 전문 이력서 컨설턴트입니다.
[지원자 정보] · [타겟 직무] · [지원 회사] · [항목별 강조 포인트] 를 바탕으로 맞춤 자소서 5항목 작성.

[지원자] 경력/기술/포트폴리오
[타겟 직무] 직무명 + 워크넷 수집 요건(경력/학력 분포)
[지원 회사] (company 입력 시) — 가장 중요한 반영 기준
  ★ 회사 맞춤 작성 절차:
  1. 먼저 {회사}의 ① 핵심가치 ② 비전/미션 ③ 인재상 ④ 지향점(추구 방향성) 파악
  2. 4가지를 자소서 전체에 자연스럽게 녹여냄 (가치-경험 연결)
  3. 항목별 반영 가이드:
     - 지원동기: 회사 비전·핵심가치에 공감한 계기 + 기여 이유
     - 성장과정: 회사 인재상(주도성·협업·도전 등)과 부합하는 경험
     - 장단점: 회사가 중시하는 태도/역량과 연결되는 장점
     - 직무경험: 회사 지향점(사업 방향·기술)에 기여할 경험 중심
     - 입사 후 포부: 회사 비전을 실현하는 구체적 기여 방안
  4. 금지: 잘 모를 때 대충 일반적 칭찬으로 때우지 말 것
[항목별 강조 포인트] (profile.emphasis 입력 시) — 사용자가 각 항목에 강조할 기술/일화 지정
  ★ 경험 배정 원칙:
  - 강조 포인트에 적힌 기술·프로젝트·일화를 그 항목의 중심 소재로 사용
  - 여러 기술/경험을 보유한 경우, 각 항목에 서로 다른 경험을 배정 (한 경험 반복 금지)
  - 강조 포인트를 비운 항목은 프로필에서 가장 어울리는 경험을 자유 선택

출력: {"motivation","growth","strength","career","vision"} JSON
```

**검증 결과**:
- 카카오 입력 → "연결이라는 핵심 가치", "사람과 기술을 연결해 일상의 가치를 높이는 비전" 반영
- 현대모비스 입력 → "Mobility Beyond Mobility 비전", "자율주행·전동화·SDV 전환 지향점" 반영

---

## 6. AI 엔진 추상화 (교체 대비)

```
server.js (라우터)
    ↓ ai.buildPrompt() / ai.generate()
ai.js  ★ 엔진 교체 시 이 파일만 수정
    ↓ 현재: Gemini REST (axios)
```

교체 상세는 [[step7-resume-ai]] 참고. 인터페이스(prompt 입력 / JSON 출력) 고정.

---

## 7. 파일 변경 목록 (구현 완료)

| 파일 | 변경 | 설명 |
|---|---|---|
| `db/schema.sql` | 수정 | profiles, cover_letters(company 포함), generation_logs 3 테이블 |
| `db.js` | 수정 | 3 테이블 CRUD + company 컬럼 자동 마이그레이션 |
| `ai.js` | 신규 | Gemini REST 추상화 + 회사 맞춤 프롬프트 |
| `server.js` | 수정 | 이력서 API + generateLetter(회사 반영) |
| `public/index.html` | 수정 | 4번째 탭 + 마스터-디테일 UI + 회사명 입력칸 |
| `public/app.js` | 수정 | 프로필/자소서 로직, 상태 전환, 개별 이벤트 부착 |
| `public/style.css` | 수정 | 이력서 페이지 스타일 (리스트/에디터/카드/힌트) |
| `.env.example` | 수정 | GEMINI_API_KEY 항목 |
| `deploy/20-deployment.yaml` | 수정 | GEMINI_API_KEY env (secretKeyRef, optional) |
| `Dockerfile` | 수정 | ai.js COPY 추가 (초기 누락 수정) |
| `docs/step7-resume-design.md` | 본 문서 | 설계 |
| `docs/step7-resume-ai.md` | 신규 | AI 엔진 교체/키 관리 가이드 |
| `docs/step7-worklog.md` | 신규 | 작업 이력 (이번 세션 전체) |
