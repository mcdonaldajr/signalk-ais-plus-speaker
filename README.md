# SignalK AIS Plus Speaker

Standalone Piper speech output for AIS Plus.

AIS Plus remains the alarm brain. This app connects to the Signal K WebSocket stream, listens for `vessels.self.notifications.collision.*` sound notifications, and speaks the supplied message using local Piper.

It is intended for a Lubuntu cockpit/display machine where you want the Piper voice instead of browser speech.

## Install on Lubuntu

```bash
sudo apt update
sudo apt install -y git curl tar nodejs npm alsa-utils
git clone https://github.com/mcdonaldajr/signalk-ais-plus-speaker.git
cd signalk-ais-plus-speaker
./bin/install-lubuntu.sh
```

Edit `config.json` if your Signal K server is not on this machine:

```json
{
  "signalKUrl": "https://nemo3.local:3443"
}
```

Use the real Signal K port. If Signal K redirects HTTP to HTTPS, do not use the HTTP redirect port, because WebSocket subscriptions may fail with HTTP `302`. On many Signal K installs the HTTPS port is `3443`; on your local Mac test setup it has been `3444`.

If your Signal K server uses a self-signed certificate, leave this in `config.json`:

```json
{
  "rejectUnauthorized": false
}
```

If Signal K security requires an access token, add it:

```json
{
  "signalKToken": "paste-token-here"
}
```

Or use the web UI:

1. Open `http://localhost:3420`.
2. Press **Request Signal K Access**.
3. In Signal K Admin, approve the **AIS Plus Speaker** device access request.
4. Press **Check Access**, or wait a few seconds for the speaker to poll automatically.

The token is saved in `config.json` and sent as a WebSocket `Authorization: Bearer ...` header.

By default the speaker uses:

```json
{
  "signalKStream": "targeted"
}
```

That keeps the WebSocket traffic small by subscribing only to `vessels.self.notifications.collision` and `vessels.self.notifications.collision.*`. If you are debugging a difficult Signal K stream problem, you can temporarily set `"signalKStream": "all"` and the speaker will filter locally.

For normal use, keep:

```json
{
  "debug": false
}
```

Run it:

```bash
npm start
```

Open the control page:

```text
http://localhost:3420
```

## Optional systemd service

```bash
sudo cp systemd/signalk-ais-plus-speaker@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now signalk-ais-plus-speaker@$USER
```

If you installed somewhere other than `/home/$USER/signalk-ais-plus-speaker`, edit the service file first.

## Voices

The installer downloads these British Piper voices from the Rhasspy Piper voice repository:

- `en_GB-alan-medium`
- `en_GB-alan-low`
- `en_GB-northern_english_male-medium`
- `en_GB-semaine-medium`

The app discovers `.onnx` voice files in `voices/`. Select a voice in the web UI and press **Save**.

## Controls

- **Enabled**: turns speech output on/off.
- **Voice**: selects the Piper voice.
- **Sound Check**: speaks a local test message.
- **Repeat Last**: replays the last received AIS Plus message.

## Stereo Ping

The Lubuntu speaker can play a short stereo cue before each AIS Plus announcement:

```json
{
  "speechVolume": 0.65,
  "stereoPing": true,
  "pingSmallFrequencyHz": 1100,
  "pingMediumFrequencyHz": 760,
  "pingLargeFrequencyHz": 440,
  "pingSmallVolume": 1.3,
  "pingMediumVolume": 1.8,
  "pingLargeVolume": 2.4,
  "pingDurationMs": 180,
  "pingVolume": 1,
  "pingDoubleGapMs": 90,
  "pingSweepRatio": 0.72,
  "pingHarmonic": 0.18,
  "pingSpeechGapMs": 0
}
```

The app extracts the clock bearing from the spoken message, for example `at 9 o'clock`. A 9 o'clock target pings left, 3 o'clock pings right, 12 o'clock pings centre, and 1 o'clock pings slightly right.

It uses one ping for the forward sector, meaning 10, 11, 12, 1, and 2 o'clock. Other clock positions use a quick double ping at the same stereo position.

It also extracts the vessel size wording from AIS Plus messages. Large vessels use a lower tone, medium vessels use a mid tone, and small craft use a higher tone. This is local to the Lubuntu speaker app; it does not affect browser speech or the Pi announcer plugin.

The generated sound uses a short attack, decaying tail, slight downward frequency sweep, and a small harmonic to make it more like a sonar ping. `pingVolume` is independent of Piper speech volume; values above `1.0` add extra gain with clipping protection. Use `speechVolume` to reduce or boost the spoken announcement separately.

The web UI exposes the main announcement and ping volume controls plus an on/off checkbox for directional pings. Per-size ping volumes stay in `config.json` so you can compensate for high tones sounding louder than low tones.

## Signal K Source

AIS Plus publishes sound requests as Signal K notifications under:

```text
vessels.self.notifications.collision.*
```

This app speaks only notifications where:

- `method` includes `sound`
- `message` is present
- `data.announcement.shouldAnnounce` is not `false`

That means AIS Plus still owns alarm timing, repeats, muting, and false-alarm reduction.
