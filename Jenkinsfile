// JobMarketRadar CI/CD 파이프라인 (Step 6 문서 6~8절)
// 단계: Build → Test(스모크) → Deploy
//   - Build  : docker compose build (이미지 생성)
//   - Test   : 컨테이너 띄우고 /api/summary 응답 확인 (가벼운 스모크 — 배포 지연 방지)
//   - Deploy : down → up 으로 교체 (무중단은 아님, 추후 blue-green 가능)
//
// 트리거: git push (webhook) 또는 주기 폴링 — Jenkins 잡 설정에서 지정
// 참고: 이 환경(labport)엔 Jenkins가 없어 실제 실행은 안 함. 산출물로서 파이프라인 정의를 남긴 것.

pipeline {
  agent any

  // 시크릿은 Jenkins credentials로 주입 (평문 노출 금지 — Step 6 주의사항 7절)
  // Jenkins 관리 > Credentials 에 'jobmarketradar-dhs-api-key' 등록 필요
  environment {
    DHS_API_KEY = credentials('jobmarketradar-dhs-api-key')
  }

  options {
    timestamps()
    timeout(time: 15, unit: 'MINUTES')
    buildDiscarder(logRotator(numToKeepStr: '10'))
  }

  stages {

    stage('Build') {
      steps {
        sh 'docker compose build'
      }
    }

    stage('Test') {
      steps {
        // 컨테이너 기동 후 헬스체크 — 핵심 API가 응답하는지 확인 (스모크 테스트)
        sh 'docker compose up -d'
        sh '''
          echo "헬스체크 대기중..."
          for i in $(seq 1 20); do
            if curl -sf http://localhost:3000/api/summary; then
              echo ""; echo "✅ /api/summary 응답 확인 (${i}회 시도)"; exit 0
            fi
            sleep 2
          done
          echo "❌ /api/summary 응답 없음"; docker compose logs --tail=100; exit 1
        '''
      }
    }

    stage('Deploy') {
      steps {
        // down → up 으로 교체. data/ 볼륨은 호스트에 남아 데이터 유지됨 (영속성)
        sh 'docker compose down && docker compose up -d'
      }
    }

  }

  post {
    always {
      // 배포 산 로그 보존 (디버깅용)
      sh 'docker compose logs --tail=200 || true'
      // 테스트 컨테이너 정리 (배포된 up 상태는 유지)
      // sh 'docker compose down'  // 필요시 주석 해제
    }
    failure {
      echo "❌ 파이프라인 실패 — 로그와 헬스체크를 확인하세요."
    }
    success {
      echo "✅ 배포 완료 — https://aisw-apps.kopoctc.kr/g/<user>/<app>/ 에서 확인"
    }
  }
}
