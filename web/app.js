import { GoogleGenAI, Modality } from '@google/genai';

const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const statusEl = document.getElementById('status');
const outEl = document.getElementById('out');
const logEl = document.getElementById('log');

/** Tokens are single-use, so a reconnect needs a fresh one. */
const TOKEN_URL = '/api/token';

let session = null;
let ctx = null;
let stream = null;
let node = null;
let source = null;
let recording = false;
let reconnecting = false;

let finalText = '';
let segment = '';

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = kind;
}

function log(line) {
  logEl.textContent += `${new Date().toLocaleTimeString()}  ${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function render(preview = '') {
  outEl.textContent = finalText;
  if (preview) {
    const span = document.createElement('span');
    span.className = 'interim';
    span.textContent = preview;
    outEl.appendChild(span);
  }
}

function commitSegment() {
  if (!segment) return;
  finalText = `${finalText}${segment} `.replace(/\s+/g, ' ');
  segment = '';
  render();
}

async function fetchToken() {
  const response = await fetch(TOKEN_URL, { method: 'POST' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(`token request failed (${response.status}) ${body.error ?? ''}`.trim());
  }
  return response.json();
}

/**
 * Opens a Live session using a freshly minted token. The model and all
 * transcription settings are pinned server-side by the token's field mask, so
 * nothing is configured here.
 */
async function openSession() {
  const { token, model } = await fetchToken();
  log(`token acquired, model=${model}`);

  const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } });

  return ai.live.connect({
    model,
    callbacks: {
      onopen: () => {
        log('live session open');
        if (recording) setStatus('listening', 'live');
      },
      onmessage: (message) => {
        const content = message.serverContent;
        if (!content) return;

        const text = content.inputTranscription?.text;
        if (text) {
          segment += text;
          render(segment);
        }
        // Utterance boundary: the server's voice-activity detection saw a pause.
        if (content.turnComplete) commitSegment();

        if (message.goAway) {
          log(`goAway (timeLeft=${message.goAway.timeLeft ?? 'unknown'}) — rotating session`);
          void rotate();
        }
      },
      onerror: (event) => {
        log(`live error: ${event?.message ?? 'unknown'}`);
        if (recording) setStatus('upstream error', 'error');
      },
      onclose: (event) => {
        log(`live closed: ${event?.code ?? ''} ${event?.reason ?? ''}`.trim());
        // A close while still recording means the session hit its cap or
        // dropped; get a new token and carry on rather than losing the mic.
        if (recording && !reconnecting) void rotate();
      },
    },
    config: {},
  });
}

/** Replace the upstream session without interrupting mic capture. */
async function rotate() {
  if (!recording || reconnecting) return;
  reconnecting = true;
  setStatus('reconnecting…');
  commitSegment();
  try {
    session?.close();
  } catch {
    /* already gone */
  }
  session = null;
  try {
    session = await openSession();
    setStatus('listening', 'live');
  } catch (error) {
    log(`reconnect failed: ${error.message}`);
    setStatus('reconnect failed', 'error');
    await stop();
  } finally {
    reconnecting = false;
  }
}

async function start() {
  startBtn.disabled = true;
  finalText = '';
  segment = '';
  render();
  setStatus('requesting mic…');

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch (error) {
    setStatus(`mic denied: ${error.message}`, 'error');
    startBtn.disabled = false;
    return;
  }

  setStatus('connecting…');
  recording = true;
  try {
    session = await openSession();
  } catch (error) {
    log(`connect failed: ${error.message}`);
    setStatus(`connect failed`, 'error');
    recording = false;
    stream.getTracks().forEach((track) => track.stop());
    startBtn.disabled = false;
    return;
  }

  ctx = new AudioContext({ sampleRate: 16000 });
  log(`AudioContext sampleRate=${ctx.sampleRate}`);
  await ctx.audioWorklet.addModule('/pcm-worklet.js');

  source = ctx.createMediaStreamSource(stream);
  node = new AudioWorkletNode(ctx, 'pcm-worklet');
  node.port.onmessage = (event) => {
    if (!session || reconnecting) return;
    // The Live API takes base64 PCM, not binary frames.
    const bytes = new Uint8Array(event.data.buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    try {
      session.sendRealtimeInput({
        audio: { data: btoa(binary), mimeType: 'audio/pcm;rate=16000' },
      });
    } catch (error) {
      log(`send failed: ${error.message}`);
    }
  };
  source.connect(node).connect(ctx.destination);

  stopBtn.disabled = false;
  setStatus('listening', 'live');
}

async function stop() {
  stopBtn.disabled = true;
  setStatus('stopping…');
  recording = false;

  // Cut the mic first: billing follows audio sent.
  stream?.getTracks().forEach((track) => track.stop());

  try {
    session?.sendRealtimeInput({ audioStreamEnd: true });
  } catch {
    /* session may already be closed */
  }

  // Give the server a moment to flush the tail of the last utterance.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  commitSegment();

  try {
    session?.close();
  } catch {
    /* already closed */
  }
  session = null;

  node?.disconnect();
  source?.disconnect();
  await ctx?.close();
  ctx = node = source = stream = null;

  startBtn.disabled = false;
  if (statusEl.className !== 'error') setStatus('idle');
  log('stopped');
}

startBtn.addEventListener('click', () => void start());
stopBtn.addEventListener('click', () => void stop());
