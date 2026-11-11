#!/usr/bin/env bash
set -e

echo "=== TikSave GitHub Action Backend Runner Starting ==="
echo "Date: $(date -u)"

TELLER_URL="${TELLER_URL:-https://api-tiksave.mailtestvartext.workers.dev}"
TELLER_SECRET="${TELLER_SECRET:-tiksave-teller-secret-2026}"
PORT="${PORT:-3000}"
HEARTBEAT_INTERVAL=600 # 10 minutes
MAX_LIFETIME_MINUTES="${MAX_LIFETIME_MINUTES:-300}" # 5 hours default

# 1. Install dependencies & ensure ffmpeg
echo "[1/4] Ensuring ffmpeg & installing backend dependencies..."
if ! command -v ffmpeg &> /dev/null; then
  echo "Installing ffmpeg..."
  sudo apt-get update && sudo apt-get install -y ffmpeg
fi
cd "$(dirname "$0")"
npm install --production

# 2. Start Backend Server
echo "[2/4] Starting Node.js server on port $PORT..."
npm start &
SERVER_PID=$!

# Wait for server to be healthy
echo "Waiting for backend health check..."
for i in {1..30}; do
  if curl -s "http://127.0.0.1:$PORT/health" | grep -q '"status":"ok"'; then
    echo "Backend server is healthy!"
    break
  fi
  sleep 1
done

# 3. Download and Start Cloudflare Tunnel
echo "[3/4] Setting up Cloudflare Quick Tunnel..."
if [ ! -f /tmp/cloudflared ]; then
  echo "Downloading cloudflared binary..."
  curl -sLo /tmp/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  chmod +x /tmp/cloudflared
fi

rm -f /tmp/tunnel.log
/tmp/cloudflared tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate > /tmp/tunnel.log 2>&1 &
TUNNEL_PID=$!

echo "Waiting for tunnel URL to be assigned..."
TUNNEL_URL=""
for i in {1..40}; do
  TUNNEL_URL=$(grep -o 'https://[-a-zA-Z0-9.]*\.trycloudflare\.com' /tmp/tunnel.log | head -n 1 || true)
  if [ -n "$TUNNEL_URL" ]; then
    break
  fi
  sleep 2
done

if [ -z "$TUNNEL_URL" ]; then
  echo "ERROR: Failed to obtain Cloudflare tunnel URL within 80 seconds!"
  cat /tmp/tunnel.log
  exit 1
fi

echo "=========================================================="
echo ">> Active Tunnel URL: $TUNNEL_URL"
echo "=========================================================="

# Function to register/heartbeat with the Teller
send_heartbeat() {
  echo "[Heartbeat] Registering tunnel URL with Teller: $TELLER_URL"
  RESP=$(curl -s -X POST "$TELLER_URL/teller/register" \
    -A "TikSave-Runner/1.0 (Linux; Cloudflare-Tunnel)" \
    -H "Content-Type: application/json" \
    -H "x-teller-secret: $TELLER_SECRET" \
    -d "{\"url\":\"$TUNNEL_URL\",\"secret\":\"$TELLER_SECRET\"}" || true)
  echo "[Heartbeat Response]: $RESP"
}

# Initial Registration
send_heartbeat

# 4. Long-running Heartbeat Loop
echo "[4/4] Serving traffic & heartbeating every ${HEARTBEAT_INTERVAL}s (Max runtime: ${MAX_LIFETIME_MINUTES}m)..."
START_TIME=$(date +%s)

while true; do
  sleep $HEARTBEAT_INTERVAL

  # Health check local server
  if ! curl -s "http://127.0.0.1:$PORT/health" | grep -q '"status":"ok"'; then
    echo "WARNING: Backend server health check failed! Attempting restart..."
    kill $SERVER_PID 2>/dev/null || true
    npm start &
    SERVER_PID=$!
    sleep 3
  fi

  # Send heartbeat to Teller
  send_heartbeat

  # Check session uptime
  CURRENT_TIME=$(date +%s)
  ELAPSED_MINUTES=$(( (CURRENT_TIME - START_TIME) / 60 ))
  echo "[Status] Runner uptime: ${ELAPSED_MINUTES}m / target: ${MAX_LIFETIME_MINUTES}m"

  if [ $ELAPSED_MINUTES -ge $MAX_LIFETIME_MINUTES ]; then
    echo "=========================================================="
    echo "Session target reached (${ELAPSED_MINUTES}m / ${MAX_LIFETIME_MINUTES}m)."
    echo "Shutting down runner cleanly so workflow can recall the next runner..."
    echo "=========================================================="
    break
  fi
done

kill $TUNNEL_PID 2>/dev/null || true
kill $SERVER_PID 2>/dev/null || true
echo "Runner processes stopped. Exiting cleanly."
exit 0
