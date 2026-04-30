#!/usr/bin/env node
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const configPath = path.join(rootDir, 'config.json');
const defaultConfigPath = path.join(rootDir, 'config.example.json');
const publicDir = path.join(rootDir, 'public');

const defaultConfig = readJson(defaultConfigPath);
let config = loadConfig();
let signalKSocket = null;
let reconnectTimer = null;
let reconnectDelayMs = 1000;
let isSpeaking = false;
let queue = [];
let currentMessage = null;
let lastMessage = null;
let lastMessageKey = '';
let lastMessageAt = 0;
let recentEvents = [];
let clients = new Set();

const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: '128kb' }));
app.use(express.static(publicDir));

app.get('/api/status', (_req, res) => {
  res.json(getStatus());
});

app.get('/api/config', (_req, res) => {
  res.json({ config: publicConfig(), voices: listVoices() });
});

app.put('/api/config', (req, res) => {
  const previousSignalKUrl = config.signalKUrl;
  const next = sanitizeConfig({ ...config, ...req.body });
  config = next;
  writeJson(configPath, config);
  if (config.signalKUrl !== previousSignalKUrl) {
    signalKSocket?.close();
    connectSignalK();
  }
  broadcast();
  res.json({ config: publicConfig(), voices: listVoices() });
});

app.post('/api/test', (_req, res) => {
  enqueueSpeech({
    id: `test-${Date.now()}`,
    message: 'Sound Check. Testing 1, 2, 3.',
    severity: 'alert',
    category: 'test',
    ts: new Date().toISOString(),
    source: 'local-test',
    force: true
  });
  res.json({ ok: true });
});

app.post('/api/repeat', (_req, res) => {
  if (!lastMessage?.message) {
    res.status(404).json({ error: 'No message has been received yet.' });
    return;
  }
  enqueueSpeech({ ...lastMessage, id: `repeat-${Date.now()}`, force: true, source: 'repeat-last' });
  res.json({ ok: true });
});

app.post('/api/stop', (_req, res) => {
  queue = [];
  res.json({ ok: true });
  broadcast();
});

app.get('/api/events', (_req, res) => {
  res.json({ events: recentEvents.slice().reverse() });
});

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.write(`data: ${JSON.stringify(getStatus())}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

server.listen(config.listenPort, config.listenHost, () => {
  logEvent('info', `AIS Plus Speaker listening on http://${config.listenHost}:${config.listenPort}`);
  connectSignalK();
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function loadConfig() {
  if (!fs.existsSync(configPath)) {
    writeJson(configPath, defaultConfig);
  }
  return sanitizeConfig({ ...defaultConfig, ...readJson(configPath) });
}

function sanitizeConfig(input) {
  const next = { ...defaultConfig, ...input };
  next.signalKUrl = String(next.signalKUrl || defaultConfig.signalKUrl).replace(/\/+$/, '');
  next.signalKToken = String(next.signalKToken || '');
  next.rejectUnauthorized = next.rejectUnauthorized !== false;
  next.listenHost = String(next.listenHost || defaultConfig.listenHost);
  next.listenPort = clampInteger(next.listenPort, 1, 65535, defaultConfig.listenPort);
  next.piperBinary = String(next.piperBinary || defaultConfig.piperBinary);
  next.audioPlayer = String(next.audioPlayer || defaultConfig.audioPlayer);
  next.voicesDir = String(next.voicesDir || defaultConfig.voicesDir);
  next.voice = String(next.voice || defaultConfig.voice);
  next.speakerId = clampInteger(next.speakerId, -1, 1000, -1);
  next.dedupeSeconds = clampInteger(next.dedupeSeconds, 0, 600, 2);
  next.volumeCommand = String(next.volumeCommand || '');
  next.enabled = next.enabled !== false;
  return next;
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function publicConfig() {
  return {
    signalKUrl: config.signalKUrl,
    hasSignalKToken: Boolean(config.signalKToken),
    rejectUnauthorized: config.rejectUnauthorized,
    listenHost: config.listenHost,
    listenPort: config.listenPort,
    voice: config.voice,
    speakerId: config.speakerId,
    dedupeSeconds: config.dedupeSeconds,
    enabled: config.enabled
  };
}

function absoluteFromRoot(value) {
  return path.isAbsolute(value) ? value : path.join(rootDir, value);
}

function listVoices() {
  const dir = absoluteFromRoot(config.voicesDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(name => name.endsWith('.onnx'))
    .map(name => {
      const id = name.replace(/\.onnx$/, '');
      const configFile = path.join(dir, `${name}.json`);
      return {
        id,
        modelPath: path.join(dir, name),
        hasConfig: fs.existsSync(configFile)
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function selectedVoice() {
  const voices = listVoices();
  return voices.find(voice => voice.id === config.voice) || voices[0] || null;
}

function signalKWebSocketUrl() {
  const url = new URL(config.signalKUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/signalk/v1/stream';
  url.search = 'subscribe=none';
  return url.toString();
}

function connectSignalK() {
  clearTimeout(reconnectTimer);
  const wsUrl = signalKWebSocketUrl();
  logEvent('info', `Connecting to Signal K at ${wsUrl}`);
  const headers = config.signalKToken
    ? { Authorization: `Bearer ${config.signalKToken}` }
    : {};
  signalKSocket = new WebSocket(wsUrl, {
    followRedirects: true,
    headers,
    rejectUnauthorized: config.rejectUnauthorized
  });

  signalKSocket.on('open', () => {
    reconnectDelayMs = 1000;
    logEvent('info', 'Connected to Signal K');
    signalKSocket.send(JSON.stringify({
      context: 'vessels.self',
      subscribe: [
        { path: 'notifications.collision', policy: 'instant' },
        { path: 'notifications.collision.*', policy: 'instant' }
      ]
    }));
    broadcast();
  });

  signalKSocket.on('message', data => {
    try {
      handleSignalKDelta(JSON.parse(data.toString()));
    } catch (error) {
      logEvent('error', `Could not parse Signal K message: ${error.message}`);
    }
  });

  signalKSocket.on('close', () => {
    logEvent('warning', 'Signal K connection closed');
    scheduleReconnect();
    broadcast();
  });

  signalKSocket.on('error', error => {
    logEvent('error', `Signal K connection error: ${error.message}`);
  });

  signalKSocket.on('unexpected-response', (_request, response) => {
    const location = response.headers.location ? ` Redirect target: ${response.headers.location}` : '';
    const hint = response.statusCode === 301 || response.statusCode === 302
      ? ' Use the real Signal K HTTPS port in signalKUrl, for example https://nemo3.local:3443, not the HTTP redirect port.'
      : '';
    logEvent('error', `Signal K rejected WebSocket with HTTP ${response.statusCode}.${location}${hint}`);
  });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectSignalK, reconnectDelayMs);
  reconnectDelayMs = Math.min(30000, reconnectDelayMs * 1.5);
}

function handleSignalKDelta(delta) {
  if (!delta || typeof delta !== 'object') return;
  const updates = Array.isArray(delta.updates) ? delta.updates : [];
  for (const update of updates) {
    const values = Array.isArray(update.values) ? update.values : [];
    for (const value of values) {
      handleNotificationValue(value, update.$source || 'unknown');
    }
  }
}

function handleNotificationValue(value, source) {
  if (!value || typeof value.path !== 'string') return;
  if (value.path === 'notifications.collision' && value.value && typeof value.value === 'object') {
    for (const [id, notification] of Object.entries(value.value)) {
      handleNotification(`notifications.collision.${id}`, notification, source);
    }
    return;
  }
  if (value.path.startsWith('notifications.collision.')) {
    handleNotification(value.path, value.value, source);
  }
}

function handleNotification(pathName, value, source) {
  if (!value || typeof value !== 'object') return;
  const methods = normalizeMethods(value.method);
  const announcement = value.data?.announcement || {};
  const message = String(value.message || '').trim();
  if (!message || !methods.includes('sound') || announcement.shouldAnnounce === false) return;

  const entry = {
    id: String(announcement.id || `${pathName}-${Date.now()}`),
    message,
    severity: String(value.state || value.data?.alarmState || 'alert'),
    category: String(value.data?.category || 'cpa'),
    ts: String(announcement.ts || new Date().toISOString()),
    source
  };
  enqueueSpeech(entry);
}

function normalizeMethods(method) {
  const values = Array.isArray(method) ? method : [method];
  return values
    .flatMap(value => String(value || '').split(','))
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
}

function enqueueSpeech(entry) {
  if (!entry?.message) return;
  lastMessage = { ...entry };
  const key = `${entry.id}|${entry.message}`;
  const now = Date.now();
  if (!entry.force && key === lastMessageKey && now - lastMessageAt < config.dedupeSeconds * 1000) {
    logEvent('info', `Suppressed duplicate: ${entry.message}`);
    return;
  }
  lastMessageKey = key;
  lastMessageAt = now;

  if (!config.enabled && !entry.force) {
    logEvent('warning', `Speech disabled, ignored: ${entry.message}`);
    broadcast();
    return;
  }
  queue.push(entry);
  logEvent('info', `Queued: ${entry.message}`);
  processQueue();
  broadcast();
}

async function processQueue() {
  if (isSpeaking || queue.length === 0) return;
  const entry = queue.shift();
  isSpeaking = true;
  currentMessage = entry;
  broadcast();
  try {
    await speakWithPiper(entry.message);
    logEvent('success', `Spoken: ${entry.message}`);
  } catch (error) {
    logEvent('error', `Speech failed: ${error.message}`);
  } finally {
    isSpeaking = false;
    currentMessage = null;
    broadcast();
    processQueue();
  }
}

function speakWithPiper(message) {
  const voice = selectedVoice();
  if (!voice) {
    throw new Error(`No Piper voices found in ${absoluteFromRoot(config.voicesDir)}`);
  }

  const piperBinary = absoluteFromRoot(config.piperBinary);
  const outputFile = path.join('/tmp', `ais-plus-speaker-${Date.now()}.wav`);
  const args = ['--model', voice.modelPath, '--output_file', outputFile];
  if (config.speakerId >= 0) {
    args.push('--speaker', String(config.speakerId));
  }

  return new Promise((resolve, reject) => {
    const piper = spawn(piperBinary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    piper.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    piper.on('error', reject);
    piper.on('close', code => {
      if (code !== 0) {
        reject(new Error(`piper exited with code ${code}: ${stderr.trim()}`));
        return;
      }
      playWav(outputFile).then(resolve, reject).finally(() => {
        fs.rm(outputFile, { force: true }, () => {});
      });
    });
    piper.stdin.end(`${message}\n`);
  });
}

function playWav(file) {
  return new Promise((resolve, reject) => {
    const player = spawn(config.audioPlayer, [file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    player.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    player.on('error', reject);
    player.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${config.audioPlayer} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

function getStatus() {
  return {
    connected: signalKSocket?.readyState === WebSocket.OPEN,
    enabled: config.enabled,
    isSpeaking,
    queueLength: queue.length,
    currentMessage,
    lastMessage,
    voice: selectedVoice()?.id || '',
    events: recentEvents.slice(-10).reverse()
  };
}

function logEvent(level, message) {
  const entry = { ts: new Date().toISOString(), level, message };
  recentEvents.push(entry);
  recentEvents = recentEvents.slice(-100);
  const prefix = `[ais-plus-speaker] ${level.toUpperCase()}`;
  console.log(`${prefix} ${message}`);
  broadcast();
}

function broadcast() {
  const payload = `data: ${JSON.stringify(getStatus())}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
}

function shutdown() {
  clearTimeout(reconnectTimer);
  signalKSocket?.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
