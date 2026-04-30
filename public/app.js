const controls = {
  enabled: document.getElementById('enabled'),
  signalKUrl: document.getElementById('signalKUrl'),
  voice: document.getElementById('voice'),
  stereoPing: document.getElementById('stereoPing'),
  speechVolume: document.getElementById('speechVolume'),
  speechVolumeValue: document.getElementById('speechVolumeValue'),
  pingVolume: document.getElementById('pingVolume'),
  pingVolumeValue: document.getElementById('pingVolumeValue'),
  saveButton: document.getElementById('saveButton'),
  accessButton: document.getElementById('accessButton'),
  pollAccessButton: document.getElementById('pollAccessButton'),
  testButton: document.getElementById('testButton'),
  repeatButton: document.getElementById('repeatButton'),
  clearBufferButton: document.getElementById('clearBufferButton'),
  accessStatus: document.getElementById('accessStatus'),
  queueCount: document.getElementById('queueCount'),
  connectionText: document.getElementById('connectionText'),
  statusPill: document.getElementById('statusPill'),
  lastMessage: document.getElementById('lastMessage'),
  events: document.getElementById('events')
};

let loadedConfig = null;

async function loadConfig() {
  const response = await fetch('/api/config');
  const data = await response.json();
  loadedConfig = data.config;
  controls.enabled.checked = data.config.enabled;
  controls.signalKUrl.value = data.config.signalKUrl;
  controls.voice.innerHTML = '';
  for (const voice of data.voices) {
    const option = document.createElement('option');
    option.value = voice.id;
    option.textContent = voice.id;
    controls.voice.appendChild(option);
  }
  controls.voice.value = data.config.voice;
  controls.stereoPing.checked = data.config.stereoPing;
  controls.speechVolume.value = data.config.speechVolume;
  controls.pingVolume.value = data.config.pingVolume;
  updateVolumeLabels();
  renderAccess(data.config);
}

async function saveConfig() {
  controls.saveButton.disabled = true;
  try {
    const response = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: controls.enabled.checked,
        signalKUrl: controls.signalKUrl.value,
        voice: controls.voice.value,
        stereoPing: controls.stereoPing.checked,
        speechVolume: Number(controls.speechVolume.value),
        pingVolume: Number(controls.pingVolume.value)
      })
    });
    const data = await response.json();
    loadedConfig = data.config;
  } finally {
    controls.saveButton.disabled = false;
  }
}

async function postAction(url, button) {
  button.disabled = true;
  try {
    const response = await fetch(url, { method: 'POST' });
    if (url.includes('access')) {
      const data = await response.json();
      renderAccess({ ...loadedConfig, ...data });
    }
  } finally {
    button.disabled = false;
  }
}

function updateVolumeLabels() {
  controls.speechVolumeValue.textContent = Number(controls.speechVolume.value).toFixed(2);
  controls.pingVolumeValue.textContent = Number(controls.pingVolume.value).toFixed(1);
}

function renderAccess(config) {
  const request = config.accessRequest || {};
  if (config.hasSignalKToken) {
    controls.accessStatus.textContent = 'Signal K access approved; token saved.';
    return;
  }
  if (request.permission === 'DENIED') {
    controls.accessStatus.textContent = 'Signal K access denied.';
    return;
  }
  if (request.href) {
    controls.accessStatus.textContent = `Signal K access ${request.state || 'pending'}. Approve AIS Plus Speaker in Signal K, then press Check Access.`;
    return;
  }
  controls.accessStatus.textContent = 'Signal K access not requested.';
}

function applyStatus(status) {
  controls.connectionText.textContent = status.connected
    ? 'Connected to Signal K'
    : 'Waiting for Signal K';
  controls.statusPill.textContent = status.isSpeaking
    ? 'Speaking'
    : status.queueLength
      ? `${status.queueLength} queued`
      : 'Idle';
  controls.statusPill.classList.toggle('speaking', status.isSpeaking);
  controls.lastMessage.textContent = status.lastMessage?.message || 'No AIS Plus message received yet.';
  controls.queueCount.textContent = status.queueLength;
  controls.repeatButton.disabled = !status.lastMessage;
  controls.clearBufferButton.disabled = status.queueLength === 0;
  controls.events.innerHTML = '';
  for (const event of status.events || []) {
    const row = document.createElement('div');
    row.className = `event ${event.level}`;
    const time = document.createElement('div');
    time.className = 'eventTime';
    time.textContent = new Date(event.ts).toLocaleString();
    const text = document.createElement('div');
    text.textContent = event.message;
    row.append(time, text);
    controls.events.appendChild(row);
  }
}

function connectEvents() {
  const source = new EventSource('/api/stream');
  source.onmessage = event => {
    applyStatus(JSON.parse(event.data));
  };
  source.onerror = () => {
    controls.connectionText.textContent = 'Control connection interrupted';
  };
}

controls.saveButton.addEventListener('click', saveConfig);
controls.accessButton.addEventListener('click', () => postAction('/api/access-request', controls.accessButton));
controls.pollAccessButton.addEventListener('click', () => postAction('/api/access-poll', controls.pollAccessButton));
controls.testButton.addEventListener('click', () => postAction('/api/test', controls.testButton));
controls.repeatButton.addEventListener('click', () => postAction('/api/repeat', controls.repeatButton));
controls.clearBufferButton.addEventListener('click', () => postAction('/api/stop', controls.clearBufferButton));
controls.enabled.addEventListener('change', saveConfig);
controls.stereoPing.addEventListener('change', saveConfig);
controls.speechVolume.addEventListener('input', updateVolumeLabels);
controls.pingVolume.addEventListener('input', updateVolumeLabels);
controls.speechVolume.addEventListener('change', saveConfig);
controls.pingVolume.addEventListener('change', saveConfig);

loadConfig().then(connectEvents).catch(error => {
  controls.connectionText.textContent = `Could not load config: ${error.message}`;
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
