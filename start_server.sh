#!/bin/bash
# kopolab-auto-server : labport 웹 서버 실행 (앱별 고유 포트, 실행하면 자동 외부공개)
cd "$(dirname "$0")"
proj=$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9-]+/-/g; s/^-+|-+$//g')
URL="https://aisw-apps.kopoctc.kr/g/$(basename "$HOME")/${proj}/"
if [ -f server.pid ] && kill -0 "$(cat server.pid)" 2>/dev/null && [ -f server.port ]; then
  echo "이미 실행 중 (포트 $(cat server.port))"; echo "외부 접속 주소: $URL"; exit 0
fi
[ -f server.pid ] && kill "$(cat server.pid)" 2>/dev/null; rm -f server.pid
PORT=$(python3 - <<'PY'
import socket, random
def free(p):
    s = socket.socket(); r = s.connect_ex(('127.0.0.1', p)); s.close(); return r != 0
old = None
try: old = int(open('server.port').read().strip())
except Exception: pass
if old and 10000 <= old < 20000 and free(old):
    print(old)
else:
    for p in random.sample(range(10000, 20000), 100):
        if free(p): print(p); break
PY
)
[ -z "$PORT" ] && PORT=10080
export PORT
export HOST=0.0.0.0
: > server.log
# 실행 명령 자동 판별 (동적 서버는 반드시 $PORT 를 읽고 0.0.0.0 에 바인딩해야 자동공개됨)
if [ -f run.sh ]; then
  setsid bash run.sh >> server.log 2>&1 &
elif [ -f package.json ]; then
  if [ ! -d node_modules ] && command -v npm >/dev/null 2>&1; then npm install >> server.log 2>&1; fi
  if command -v npm >/dev/null 2>&1 && grep -q '"start"' package.json 2>/dev/null; then
    setsid npm start >> server.log 2>&1 &
  else
    entry=""
    for c in server.js app.js index.js main.js; do [ -f "$c" ] && entry="$c" && break; done
    setsid node "${entry:-index.js}" >> server.log 2>&1 &
  fi
elif [ -f app.py ] || [ -f main.py ] || [ -f requirements.txt ]; then
  [ -f requirements.txt ] && python3 -m pip install -q --user -r requirements.txt >> server.log 2>&1
  if [ -f main.py ] && grep -qi fastapi main.py 2>/dev/null; then
    setsid python3 -m uvicorn main:app --host 0.0.0.0 --port "$PORT" >> server.log 2>&1 &
  elif [ -f app.py ]; then
    setsid python3 app.py >> server.log 2>&1 &
  else
    setsid python3 -m http.server "$PORT" --bind 0.0.0.0 >> server.log 2>&1 &
  fi
else
  setsid python3 -m http.server "$PORT" --bind 0.0.0.0 >> server.log 2>&1 &
fi
echo $! > server.pid
echo "$PORT" > server.port
sleep 1
echo "서버 실행됨 (포트 $PORT)."
echo "외부 접속 주소(잠시 후 자동으로 열림): $URL"
