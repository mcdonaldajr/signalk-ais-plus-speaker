const controls = {
  enabled: document.getElementById('enabled'),
  signalKUrl: document.getElementById('signalKUrl'),
  voice: document.getElementById('voice'),
  saveButton: document.getElementById('saveButton'),
  testButton: document.getElementById('testButton'),
  repeatButton: document.getElementById('repeatButton'),
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
        voice: controls.voice.value
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
    await fetch(url, { method: 'POST' });
  } finally {
    button.disabled = false;
  }
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
  controls.repeatButton.disabled = !status.lastMessage;
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
controls.testButton.addEventListener('click', () => postAction('/api/test', controls.testButton));
controls.repeatButton.addEventListener('click', () => postAction('/api/repeat', controls.repeatButton));
controls.enabled.addEventListener('change', saveConfig);

loadConfig().then(connectEvents).catch(error => {
  controls.connectionText.textContent = `Could not load config: ${error.message}`;
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
