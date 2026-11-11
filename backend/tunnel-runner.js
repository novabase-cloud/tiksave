import { spawn, execSync } from 'child_process';
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import os from 'os';

const PORT = process.env.PORT || 3000;
const TELLER_URL = (process.env.TELLER_URL || 'https://api-tiksave.mailtestvartext.workers.dev').replace(/\/+$/, '');
const TELLER_SECRET = process.env.TELLER_SECRET || 'tiksave-teller-secret-2026';
const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes (per user requirement)
const MAX_RUN_TIME_MS = 5 * 60 * 60 * 1000 + 45 * 60 * 1000; // 5 hours 45 minutes

console.log('=== Starting TikSave Backend & Cloudflare Quick Tunnel ===');
console.log(`Port: ${PORT}`);
console.log(`Teller Endpoint: ${TELLER_URL}/teller`);
console.log(`Heartbeat interval: ${HEARTBEAT_INTERVAL_MS / 60000} minutes`);

// 1. Start backend server
console.log('\n[1/4] Starting Node.js backend server...');
const serverProcess = spawn('node', ['server.js'], {
  env: { ...process.env, PORT: PORT.toString() },
  stdio: 'inherit',
});

serverProcess.on('exit', (code) => {
  console.error(`[backend-server] Exited with code ${code}`);
  process.exit(code || 1);
});

// Wait for server to be ready
await new Promise((resolve) => setTimeout(resolve, 2000));

// 2. Ensure cloudflared is present
console.log('\n[2/4] Ensuring cloudflared binary is available...');
let cloudflaredCmd = 'cloudflared';
const isWin = process.platform === 'win32';

function isCommandAvailable(cmd) {
  try {
    execSync(isWin ? `where ${cmd}` : `which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

if (!isCommandAvailable('cloudflared')) {
  console.log('cloudflared not found in PATH, downloading standalone binary...');
  const binName = isWin ? 'cloudflared.exe' : 'cloudflared';
  const binPath = path.resolve(binName);

  if (!fs.existsSync(binPath)) {
    const downloadUrl = isWin
      ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
      : 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';

    console.log(`Downloading from ${downloadUrl}...`);
    execSync(`curl -L -o "${binPath}" "${downloadUrl}"`, { stdio: 'inherit' });
    if (!isWin) {
      execSync(`chmod +x "${binPath}"`);
    }
  }
  cloudflaredCmd = binPath;
}

console.log(`Using cloudflared binary: ${cloudflaredCmd}`);

// 3. Launch cloudflared tunnel
console.log('\n[3/4] Launching Cloudflare Quick Tunnel...');
const tunnelArgs = ['tunnel', '--url', `http://127.0.0.1:${PORT}`, '--no-autoupdate'];
const tunnelProc = spawn(cloudflaredCmd, tunnelArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

let tunnelUrl = null;
const urlRegex = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/i;

function processLogChunk(chunk) {
  const str = chunk.toString();
  process.stdout.write(str);
  if (!tunnelUrl) {
    const match = str.match(urlRegex);
    if (match) {
      tunnelUrl = match[0];
      onTunnelEstablished(tunnelUrl);
    }
  }
}

tunnelProc.stdout.on('data', processLogChunk);
tunnelProc.stderr.on('data', processLogChunk);

tunnelProc.on('exit', (code) => {
  console.error(`[cloudflared] Tunnel process exited with code ${code}`);
  process.exit(code || 1);
});

// 4. On Tunnel established: Register & Heartbeat loop
async function sendHeartbeat(url) {
  const target = `${TELLER_URL}/teller`;
  console.log(`[heartbeat] Sending tunnel URL to teller: ${target}`);
  try {
    const resp = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TELLER_SECRET}`,
      },
      body: JSON.stringify({
        url: url,
        timestamp: Date.now(),
        service: 'tiksave-backend',
        runner: os.hostname(),
      }),
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      console.warn(`[heartbeat-warning] Teller responded with HTTP ${resp.status}: ${txt}`);
    } else {
      const resJson = await resp.json().catch(() => ({}));
      console.log(`[heartbeat-success] Teller acknowledged:`, resJson);
    }
  } catch (err) {
    console.error(`[heartbeat-error] Failed to reach teller:`, err.message);
  }
}

async function triggerNextWorkflow() {
  const ghToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!ghToken || !repo) {
    console.log('[rotation] No GH_TOKEN or GITHUB_REPOSITORY set; skipping automatic restart dispatch.');
    return;
  }

  console.log(`[rotation] Dispatching next workflow run for ${repo}...`);
  try {
    const resp = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/backend-runner.yml/dispatches`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ghToken}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'TikSave-Runner',
      },
      body: JSON.stringify({ ref: 'main' }),
    });

    if (resp.ok || resp.status === 204) {
      console.log('[rotation] Next workflow dispatched successfully!');
    } else {
      console.warn(`[rotation] Workflow dispatch returned HTTP ${resp.status}`);
    }
  } catch (err) {
    console.error('[rotation] Failed to dispatch next workflow:', err.message);
  }
}

function onTunnelEstablished(url) {
  console.log(`\n======================================================`);
  console.log(`>>> CLOUDFLARE QUICK TUNNEL ONLINE: ${url} <<<`);
  console.log(`======================================================\n`);

  // Initial registration
  sendHeartbeat(url);

  // Heartbeat loop every 10 minutes
  setInterval(() => {
    sendHeartbeat(url);
  }, HEARTBEAT_INTERVAL_MS);

  // Graceful runner rotation near the 6-hour GitHub Actions job timeout
  setTimeout(async () => {
    console.log('[runner-lifecycle] Reaching 5h 45m runtime limit. Triggering next runner...');
    await triggerNextWorkflow();
    // Allow 2 minutes for next runner to take over before shutting down
    setTimeout(() => {
      console.log('[runner-lifecycle] Handover complete. Exiting gracefully.');
      process.exit(0);
    }, 120000);
  }, MAX_RUN_TIME_MS);
}
