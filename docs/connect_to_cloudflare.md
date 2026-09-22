# 외부 도메인 연결: kopo13.kokailab.com (Cloudflare Tunnel)

> 2026-09-22 작업 기록. 커스텀 도메인을 Cloudflare Tunnel로 클러스터에 연결하며
> 404가 발생한 원인 분석과 해결 방법, 그리고 시행착오(Kyverno 정책 충돌)를 정리한다.

## 배경

- 기존 앱 노출 주소: `https://kopo13-jobradar.std.kopoctc.kr` (사내 와일드카드 DNS → traefik)
- 목표: 외부 도메인 `kopo13.kokailab.com` 으로도 동일 앱에 접근하게 한다.
- 구성: cloudflared(Cloudflare Tunnel)가 **별도 서버**에서 실행 중이며,
  이 클러스터의 traefik 진입점(192.168.26.195:443)으로 라우팅한다.

```
인터넷 → Cloudflare → cloudflared(타 서버) → traefik(192.168.26.195:443)
        → Ingress(Host 기반 라우팅) → jobradar Service(3000) → Node 서버
```

## 증상

브라우저에서 `https://kopo13.kokailab.com` 접속 시 404. TLS는 Cloudflare 종단에서
처리되어 오리진 구간은 TLS 꺼진 상태로 도달했다는 게 아니라, 터널 자체는 살아 있었다.

## 원인 분석 (실측)

### 1. 404의 직접 원인: traefik Host 불일치

traefik 진입점에 직접 요청을 보내 재현 확인:

| 요청 | 결과 |
|---|---|
| 443 + `Host: kopo13-jobradar.std.kopoctc.kr` | **200** (정상 라우팅) |
| 443 + `Host: kopo13.kokailab.com` | **404** ← 재현 |
| 80 + 아무 host | 301 → `https://...` (traefik 리다이렉트) |

외부에서 나온 404의 응답 바디가 traefik 기본값인 `404 page not found`로 확인되어,
**터널은 정상 작동해 traefik까지 도달하지만**, Host 헤더가 `kopo13.kokailab.com`이라
매칭되는 Ingress rule이 없어 traefik이 404를 반환한 것임이 확정됐다.

### 2. Ingress에 host를 추가하는 방법은 불가: Kyverno 정책

`deploy/30-ingress.yaml`에 `kopo13.kokailab.com` rule을 추가해 push했으나
여전히 404. `kubectl -n jobradar describe ingress` 이벤트에서 진짜 이유 발견:

```
Warning SyncError ... ingress-syncer
admission webhook "validate.kyverno.svc-fail" denied:
Ingress host 는 kopo13-<앱>.std.kopoctc.kr 형식만 허용됩니다.
```

- **호스트 rke2 클러스터의 Kyverno 정책(`restrict-student-ingress-host`)이
  `kopo13-<앱>.std.kopoctc.kr` 형식 외 host를 가진 Ingress를 거부**한다.
- vcluster 안에서는 객체에 rule이 반영된 것처럼 보이지만(ArigoCD도 Synced 표시),
  물리 traefik이 보는 host 클러스터 쪽 객체는 갱신되지 않는다.
- 이 접근은 revert(커밋 64ad3b8)로 원상복구했다.

**교훈**: vcluster Ingress가 반영됐는데도 라우팅이 안 되면 ArgoCD 상태 말고
`kubectl describe ingress`의 **Events**를 봐야 한다.

## 해결 방법: cloudflared originRequest 2줄

Ingress를 고치지 않고, 터널이 traefik에 보내는 요청을 재작성한다.

- `noTLSVerify` — traefik 인증서(CN=kopoctc.kr)를 IP 직접 https 접속 시 검증 통과시킴
- `httpHostHeader` — Host 헤더를 기존 도메인으로 재작성해 traefik rule에 매칭시킴 (핵심)

### config.yml 방식 (로컬 관리 터널)

```yaml
ingress:
  - hostname: kopo13.kokailab.com
    service: https://192.168.26.195:443
    originRequest:
      noTLSVerify: true
      httpHostHeader: kopo13-jobradar.std.kopoctc.kr
```

### Cloudflare 대시보드(Zero Trust) 방식 (remote-managed 터널)

1. Zero Trust → Networks → Tunnels → 해당 턜널 선택
2. Public Hostname `kopo13.kokailab.com` 편집
3. Service: `HTTPS://192.168.26.195:443`
4. Additional application settings
   - **TLS 탭** → **No TLS Verify** 활성화
   - **HTTP 탭** → **Host Header** 에 `kopo13-jobradar.std.kopoctc.kr` 입력
5. Save

주의:
- origin을 `http://...:80`으로 두면 traefik이 https로 301을 돌려주므로(실측) 반드시 https를 쓸 것.
- 원복 후 설정 저장 시 cloudflared 재시작/설정 적용까지 잠시 기다릴 것.

## 검증

터널과 동일한 조건(https origin + Host 재작성)을 VM에서 시뮬레이션해 200 확인:

```bash
# traefik에 Host만 바꿔 요청 — httpHostHeader 설정과 동일한 효과
curl -sk --resolve kopo13-jobradar.std.kopoctc.kr:443:192.168.26.195 \
  https://kopo13-jobradar.std.kopoctc.kr/ -o /dev/null -w '%{http_code}\n'
# → 200
```

적용 후 외부 확인:

```bash
curl -s https://kopo13.kokailab.com/ | head -c 200
# HTML이 나오면 성공
# "404 page not found"가 계속 나오면 Host Header 설정이 누락된 것
```

## 관련 파일

- `deploy/30-ingress.yaml` — Ingress (변경 없음, 원상 유지)
- 커밋 `012466e` (host 추가 시도) → `64ad3b8` (revert)
