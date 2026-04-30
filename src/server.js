#!/usr/bin/env node
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
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
let accessPollTimer = null;
let stats = {
  streamMessages: 0,
  notificationUpdates: 0,
  soundNotifications: 0,
  filteredNotifications: 0
};

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

app.post('/api/access-request', async (_req, res) => {
  try {
    const response = await requestSignalKAccess();
    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/access-poll', async (_req, res) => {
  try {
    const response = await pollSignalKAccess();
    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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
  next.signalKStream = ['all', 'targeted'].includes(next.signalKStream)
    ? next.signalKStream
    : 'all';
  next.signalKToken = String(next.signalKToken || '');
  next.accessRequest = sanitizeAccessRequest(next.accessRequest);
  next.rejectUnauthorized = next.rejectUnauthorized !== false;
  next.listenHost = String(next.listenHost || defaultConfig.listenHost);
  next.listenPort = clampInteger(next.listenPort, 1, 65535, defaultConfig.listenPort);
  next.piperBinary = String(next.piperBinary || defaultConfig.piperBinary);
  next.audioPlayer = String(next.audioPlayer || defaultConfig.audioPlayer);
  next.voicesDir = String(next.voicesDir || defaultConfig.voicesDir);
  next.voice = String(next.voice || defaultConfig.voice);
  next.speakerId = clampInteger(next.speakerId, -1, 1000, -1);
  next.speechVolume = clampNumber(next.speechVolume, 0, 2, 0.65);
  next.dedupeSeconds = clampInteger(next.dedupeSeconds, 0, 600, 2);
  next.stereoPing = next.stereoPing !== false;
  next.pingFrequencyHz = clampInteger(next.pingFrequencyHz, 200, 2400, 880);
  next.pingSmallFrequencyHz = clampInteger(next.pingSmallFrequencyHz, 200, 2400, 1100);
  next.pingMediumFrequencyHz = clampInteger(next.pingMediumFrequencyHz, 200, 2400, 760);
  next.pingLargeFrequencyHz = clampInteger(next.pingLargeFrequencyHz, 200, 2400, 440);
  next.pingDurationMs = clampInteger(next.pingDurationMs, 50, 1000, 180);
  next.pingVolume = clampNumber(next.pingVolume, 0, 4, 2.2);
  next.pingDoubleGapMs = clampInteger(next.pingDoubleGapMs, 20, 1000, 90);
  next.pingSweepRatio = clampNumber(next.pingSweepRatio, 0.35, 1, 0.72);
  next.pingHarmonic = clampNumber(next.pingHarmonic, 0, 0.6, 0.18);
  next.pingSpeechGapMs = clampInteger(next.pingSpeechGapMs, 0, 2000, 0);
  next.debug = next.debug === true;
  next.volumeCommand = String(next.volumeCommand || '');
  next.enabled = next.enabled !== false;
  return next;
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function publicConfig() {
  return {
    signalKUrl: config.signalKUrl,
    signalKStream: config.signalKStream,
    hasSignalKToken: Boolean(config.signalKToken),
    accessRequest: config.accessRequest,
    rejectUnauthorized: config.rejectUnauthorized,
    listenHost: config.listenHost,
    listenPort: config.listenPort,
    voice: config.voice,
    speakerId: config.speakerId,
    speechVolume: config.speechVolume,
    dedupeSeconds: config.dedupeSeconds,
    stereoPing: config.stereoPing,
    pingFrequencyHz: config.pingFrequencyHz,
    pingSmallFrequencyHz: config.pingSmallFrequencyHz,
    pingMediumFrequencyHz: config.pingMediumFrequencyHz,
    pingLargeFrequencyHz: config.pingLargeFrequencyHz,
    pingDurationMs: config.pingDurationMs,
    pingVolume: config.pingVolume,
    pingDoubleGapMs: config.pingDoubleGapMs,
    pingSweepRatio: config.pingSweepRatio,
    pingHarmonic: config.pingHarmonic,
    pingSpeechGapMs: config.pingSpeechGapMs,
    debug: config.debug,
    enabled: config.enabled
  };
}

function sanitizeAccessRequest(value) {
  const request = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    clientId: String(request.clientId || ''),
    href: String(request.href || ''),
    state: String(request.state || ''),
    permission: String(request.permission || ''),
    expirationTime: String(request.expirationTime || ''),
    message: String(request.message || '')
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
  url.search = `subscribe=${config.signalKStream === 'targeted' ? 'none' : 'all'}`;
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
    if (config.signalKStream === 'targeted') {
      signalKSocket.send(JSON.stringify({
        context: 'vessels.self',
        announceNewPaths: true,
        subscribe: [
          {
            path: 'notifications.collision',
            policy: 'instant',
            format: 'delta'
          },
          {
            path: 'notifications.collision.*',
            policy: 'instant',
            format: 'delta'
          }
        ]
      }));
    }
    broadcast();
  });

  signalKSocket.on('message', data => {
    try {
      stats.streamMessages += 1;
      const message = JSON.parse(data.toString());
      if (config.debug) logEvent('debug', `Stream message ${JSON.stringify(compactDeltaForLog(message))}`);
      handleSignalKDelta(message);
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

async function requestSignalKAccess() {
  if (!config.accessRequest.clientId) {
    config.accessRequest.clientId = crypto.randomUUID();
  }
  const response = await signalKJsonRequest('/signalk/v1/access/requests', {
    method: 'POST',
    body: {
      clientId: config.accessRequest.clientId,
      description: 'AIS Plus Speaker'
    }
  });
  config.accessRequest.state = response.body?.state || `HTTP ${response.statusCode}`;
  config.accessRequest.href = response.body?.href || config.accessRequest.href;
  config.accessRequest.permission = '';
  config.accessRequest.message = response.body?.message || '';
  writeJson(configPath, config);
  logEvent('info', `Signal K access request ${config.accessRequest.state}`);
  startAccessPolling();
  broadcast();
  return { accessRequest: config.accessRequest, hasSignalKToken: Boolean(config.signalKToken) };
}

async function pollSignalKAccess() {
  if (!config.accessRequest.href) {
    throw new Error('No pending access request. Press Request Signal K Access first.');
  }

  const response = await signalKJsonRequest(config.accessRequest.href);
  const accessRequest = response.body?.accessRequest || {};
  config.accessRequest.state = response.body?.state || `HTTP ${response.statusCode}`;
  config.accessRequest.permission = accessRequest.permission || '';
  config.accessRequest.expirationTime = accessRequest.expirationTime || '';
  config.accessRequest.message = response.body?.message || '';

  if (accessRequest.permission === 'APPROVED' && accessRequest.token) {
    config.signalKToken = accessRequest.token;
    logEvent('success', 'Signal K access approved; token saved');
    clearTimeout(accessPollTimer);
    signalKSocket?.close();
    connectSignalK();
  } else if (accessRequest.permission === 'DENIED') {
    logEvent('error', 'Signal K access denied');
    clearTimeout(accessPollTimer);
  } else {
    logEvent('info', `Signal K access ${config.accessRequest.state}`);
    startAccessPolling();
  }

  writeJson(configPath, config);
  broadcast();
  return { accessRequest: config.accessRequest, hasSignalKToken: Boolean(config.signalKToken) };
}

function startAccessPolling() {
  clearTimeout(accessPollTimer);
  if (!config.accessRequest.href || config.accessRequest.permission) return;
  accessPollTimer = setTimeout(() => {
    pollSignalKAccess().catch(error => logEvent('error', `Access poll failed: ${error.message}`));
  }, 5000);
}

function signalKJsonRequest(requestPath, options = {}) {
  const base = new URL(config.signalKUrl);
  const url = new URL(requestPath, base);
  const body = options.body ? JSON.stringify(options.body) : null;
  const client = url.protocol === 'https:' ? https : http;
  const agent = url.protocol === 'https:'
    ? new https.Agent({ rejectUnauthorized: config.rejectUnauthorized })
    : undefined;
  const headers = {
    Accept: 'application/json',
    ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
    ...(config.signalKToken ? { Authorization: `Bearer ${config.signalKToken}` } : {})
  };

  return new Promise((resolve, reject) => {
    const request = client.request(
      url,
      { method: options.method || 'GET', headers, agent },
      response => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', chunk => {
          data += chunk;
        });
        response.on('end', () => {
          let parsed = {};
          if (data.trim()) {
            try {
              parsed = JSON.parse(data);
            } catch {
              parsed = { message: data.trim() };
            }
          }
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve({ statusCode: response.statusCode, body: parsed });
          } else {
            reject(new Error(`Signal K HTTP ${response.statusCode}: ${parsed.message || data.trim()}`));
          }
        });
      }
    );
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
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
  stats.notificationUpdates += 1;
  if (!value || typeof value !== 'object') {
    stats.filteredNotifications += 1;
    return;
  }
  const methods = normalizeMethods(value.method);
  const announcement = value.data?.announcement || {};
  const message = String(value.message || '').trim();
  if (!message || !methods.includes('sound') || announcement.shouldAnnounce === false) {
    stats.filteredNotifications += 1;
    if (config.debug) {
      logEvent(
        'debug',
        `Filtered ${pathName}: message=${Boolean(message)} methods=${methods.join(',') || 'none'} shouldAnnounce=${announcement.shouldAnnounce}`
      );
    }
    return;
  }
  stats.soundNotifications += 1;

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
    const speechFile = await synthesizePiperWav(entry.message);
    try {
      await applyWavGain(speechFile, config.speechVolume);
      await playDirectionalPing(entry);
      if (config.pingSpeechGapMs > 0) {
        await sleep(config.pingSpeechGapMs);
      }
      await playWav(speechFile);
    } finally {
      fs.rm(speechFile, { force: true }, () => {});
    }
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

async function playDirectionalPing(entry) {
  if (!config.stereoPing) return;
  const clock = extractClockPosition(entry);
  if (!clock) return;
  const size = extractVesselSize(entry);
  const pingFile = path.join('/tmp', `ais-plus-speaker-ping-${Date.now()}.wav`);
  await fs.promises.writeFile(pingFile, createPingWav(clock, size, pingCountForClock(clock)));
  try {
    await playWav(pingFile);
    if (config.debug) logEvent('debug', `Stereo ping ${clock} o'clock ${size || 'default'} x${pingCountForClock(clock)}`);
  } finally {
    fs.rm(pingFile, { force: true }, () => {});
  }
}

function extractClockPosition(entry) {
  const value = Number(entry?.clock ?? entry?.relativeClock);
  if (Number.isFinite(value) && value >= 1 && value <= 12) return Math.round(value);
  const match = String(entry?.message || '').match(/\bat\s+([1-9]|1[0-2])\s+o'?clock\b/i);
  return match ? Number(match[1]) : null;
}

function extractVesselSize(entry) {
  const message = String(entry?.message || '').toLowerCase();
  if (/\b(fast\s+)?large\s+vessel\b/.test(message)) return 'large';
  if (/\bmedium\s+vessel\b/.test(message)) return 'medium';
  if (/\bsmall\s+(craft|vessel)\b/.test(message)) return 'small';
  return '';
}

function pingFrequencyForSize(size) {
  if (size === 'large') return config.pingLargeFrequencyHz;
  if (size === 'medium') return config.pingMediumFrequencyHz;
  if (size === 'small') return config.pingSmallFrequencyHz;
  return config.pingFrequencyHz;
}

function pingCountForClock(clock) {
  return clock >= 10 || clock <= 2 ? 1 : 2;
}

function createPingWav(clock, size = '', pingCount = 1) {
  const sampleRate = 44100;
  const channels = 2;
  const bytesPerSample = 2;
  const toneSamples = Math.max(1, Math.round(sampleRate * config.pingDurationMs / 1000));
  const gapSamples = pingCount > 1 ? Math.max(0, Math.round(sampleRate * config.pingDoubleGapMs / 1000)) : 0;
  const durationSamples = toneSamples * pingCount + gapSamples * (pingCount - 1);
  const dataSize = durationSamples * channels * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  const pan = clockToPan(clock);
  const leftGain = Math.cos((pan + 1) * Math.PI / 4);
  const rightGain = Math.sin((pan + 1) * Math.PI / 4);
  const amplitude = Math.round(32767 * config.pingVolume);
  const frequency = pingFrequencyForSize(size);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(bytesPerSample * 8, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < durationSamples; i += 1) {
    const cycleSamples = toneSamples + gapSamples;
    const cycleOffset = cycleSamples > 0 ? i % cycleSamples : i;
    const inTone = cycleOffset < toneSamples;
    const progress = inTone ? cycleOffset / toneSamples : 0;
    const t = cycleOffset / sampleRate;
    const attack = inTone ? Math.min(1, cycleOffset / (sampleRate * 0.012)) : 0;
    const decay = inTone ? Math.exp(-5.2 * progress) : 0;
    const fadeOut = inTone ? Math.min(1, (toneSamples - cycleOffset) / (sampleRate * 0.025)) : 0;
    const envelope = attack * decay * fadeOut;
    const sweptFrequency = frequency * (1 - (1 - config.pingSweepRatio) * progress);
    const phase = 2 * Math.PI * sweptFrequency * t;
    const tone = inTone
      ? Math.sin(phase) + config.pingHarmonic * Math.sin(phase * 2.01)
      : 0;
    const sample = amplitude * tone * Math.max(0, envelope);
    const offset = 44 + i * channels * bytesPerSample;
    buffer.writeInt16LE(clampPcm16(sample * leftGain), offset);
    buffer.writeInt16LE(clampPcm16(sample * rightGain), offset + 2);
  }

  return buffer;
}

function clampPcm16(value) {
  return Math.max(-32768, Math.min(32767, Math.round(value)));
}

function clockToPan(clock) {
  const angle = ((clock % 12) / 12) * Math.PI * 2;
  const pan = Math.sin(angle);
  return Math.max(-1, Math.min(1, pan));
}

function synthesizePiperWav(message) {
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
      resolve(outputFile);
    });
    piper.stdin.end(`${message}\n`);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function applyWavGain(file, gain) {
  if (gain === 1) return;
  const buffer = await fs.promises.readFile(file);
  const dataOffset = findWavDataOffset(buffer);
  if (dataOffset == null) {
    throw new Error('Could not adjust speech volume: WAV data chunk not found');
  }
  for (let offset = dataOffset; offset + 1 < buffer.length; offset += 2) {
    const sample = buffer.readInt16LE(offset);
    buffer.writeInt16LE(clampPcm16(sample * gain), offset);
  }
  await fs.promises.writeFile(file, buffer);
}

function findWavDataOffset(buffer) {
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === 'data') return offset + 8;
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  return null;
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
    stats,
    events: recentEvents.slice(-10).reverse()
  };
}

function compactDeltaForLog(delta) {
  return {
    context: delta?.context,
    updates: (delta?.updates || []).map(update => ({
      source: update.$source,
      paths: (update.values || []).map(value => value.path)
    }))
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
  clearTimeout(accessPollTimer);
  signalKSocket?.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
