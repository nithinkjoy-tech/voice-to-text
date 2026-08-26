# voice-to-text

Real-time English speech-to-text backend. Browser streams mic audio over a
WebSocket; the server relays it to the **Gemini Live API** and pushes transcripts
back as they arrive.

Node 24 · TypeScript · Express 5 · `ws` · `@google/genai`

## Setup

```bash
npm install
cp .env.example .env      # paste your AI Studio key into GEMINI_API_KEY
```

Get a key at <https://aistudio.google.com/apikey>. No GCP project, service
account, or billing setup is required.

## Verify the SDK first

The Live API's input-transcription support has had rough edges across SDK
versions, so check it before trusting the service:

```bash
npm run smoke                       # transport check: streams a synthetic tone
npm run smoke -- sample.wav         # real check: streams 16kHz mono 16-bit WAV
```

The tone run confirms audio is accepted without an upstream error (a tone has no
speech, so an empty transcript is the expected result). The WAV run confirms
transcription itself works. To make a suitable WAV:

```bash
ffmpeg -i anything.m4a -ac 1 -ar 16000 -sample_fmt s16 sample.wav
```

## Run

```bash
npm run dev                         # tsx watch
npm run build && npm start          # compiled
```

Open <http://localhost:8080>, click **Start recording**, speak. Interim text
appears greyed and italic, then firms up into committed text.

## API

### `GET /health`
```json
{ "status": "ok", "model": "gemini-3.1-flash-live-preview", "wsPath": "/ws/transcribe" }
```

### `WS /ws/transcribe`

**Audio format is fixed: raw little-endian 16-bit PCM, 16 kHz, mono.**

Client → server:

| Frame | Payload |
|---|---|
| binary | PCM16 audio chunk (~100 ms / 3200 bytes recommended) |
| text | `{"type":"start"}` — optional; the first audio frame also opens the session |
| text | `{"type":"stop"}` — flush, emit trailing transcript, then close |

Server → client (all JSON text frames):

```jsonc
{ "type": "ready" }

// isFinal:false is a volatile preview — replace whatever you last rendered.
// isFinal:true is committed — append it and clear the preview.
{ "type": "transcript", "delta": "hello ", "text": "hello ",       "isFinal": false }
{ "type": "transcript", "delta": "world.", "text": "hello world.", "isFinal": true,
  "words": [{ "word": "hello", "startOffset": "0.1s", "endOffset": "0.4s" }],
  "speaker": "spk_1" }

// Upstream session hit its duration cap; audio is buffered and it resumes.
{ "type": "reconnecting", "reason": "upstream session limit" }

{ "type": "error",  "code": "FRAME_TOO_LARGE", "message": "…" }
{ "type": "closed", "reason": "client_stop" }
```

`words` appears only with `WORD_TIMESTAMPS=true`, `speaker` only with
`DIARIZATION=true`.

Error codes: `FRAME_TOO_LARGE`, `BAD_FRAME_ALIGNMENT`, `BAD_CONTROL_MESSAGE`,
`UNKNOWN_CONTROL_TYPE`, `UPSTREAM_ERROR`, `UPSTREAM_CLOSED`,
`UPSTREAM_CONNECT_FAILED`.

## Configuration

| Var | Default | Notes |
|---|---|---|
| `GEMINI_API_KEY` | — | **required** |
| `PORT` | `8080` | |
| `GEMINI_LIVE_MODEL` | `gemini-3.1-flash-live-preview` | |
| `RESPONSE_MODALITY` | `AUDIO` | native-audio models reject `TEXT` |
| `MAX_OUTPUT_TOKENS` | `1` | suppresses the model's spoken reply |
| `TRANSCRIPTION_MODE` | `VERBATIM` | `SMART` strips filler words and auto-formats |
| `WORD_TIMESTAMPS` | `false` | incompatible with `SMART` |
| `DIARIZATION` | `false` | incompatible with `SMART` |
| `CUSTOM_VOCABULARY` | — | comma-separated bias terms |
| `CONNECT_TIMEOUT_MS` | `15000` | upstream connect deadline |
| `STOP_GRACE_MS` | `3000` | wait for trailing text after `stop` |
| `MAX_AUDIO_FRAME_BYTES` | `65536` | per-frame limit |
| `MAX_PENDING_AUDIO_BYTES` | `2097152` | buffered while reconnecting |

Invalid combinations fail at boot rather than as an opaque WebSocket 1007
mid-session.

## Measured behaviour

Verified against the live API with a 13s three-sentence clip:

- **Transcription is utterance-granular, not word-by-word.** Text arrives when
  the server's voice-activity detection sees you pause — roughly 1s after the
  end of each sentence. It is not a word-level live caption.
- **`interimInputTranscription` is never emitted** by either model tested, so
  the volatile-preview path exists in code but is currently unused. Each
  committed utterance is sent once as a preview and immediately again as final
  when `turnComplete` follows.
- **The model talks unless you stop it.** With only a system instruction telling
  it to stay silent, a 13s clip still produced 32 generated audio turns — all
  billed, all discarded. `MAX_OUTPUT_TOKENS=1` reduces that to zero with no
  effect on transcription accuracy or latency.
- **Model trade-off.** `gemini-3.1-flash-live-preview` returns clean, complete
  sentences. `gemini-2.5-flash-native-audio-preview-12-2025` streams sub-word
  fragments (lower perceived latency) but fires `turnComplete` mid-sentence,
  splitting one utterance across several final segments.

## Design notes

- **One browser WS = one upstream Live session.** No queue, no persistence;
  transcripts are relayed, never stored.
- **Session cap.** Audio-only Live sessions are capped (~15 min). On the
  server's `goAway` warning the upstream session is reconnected using a
  resumption handle while audio buffers, so the browser connection survives.
- **The model is told to stay silent.** Gemini Live is conversational, so
  `responseModalities: [TEXT]` plus a system instruction suppresses replies and
  any `modelTurn` output is discarded — only `inputTranscription` is consumed.
  Output cannot be disabled outright, so a small amount of generation may still
  be billed.
- **`turnCoverage: TURN_INCLUDES_ALL_INPUT`** so silences don't cause audio to
  be excluded from transcription.
- **Swapping engines** means implementing the `Transcriber` interface in
  `src/speech.ts`; nothing else depends on Gemini.

## Scope

Deliberately minimal: no tests, Docker, auth, or rate limiting. The browser test
client is the acceptance check. Before exposing this publicly you'd want auth on
the WS upgrade, a per-connection audio budget, and — for browser-side use of the
key — [ephemeral tokens](https://ai.google.dev/gemini-api/docs/live-guide)
rather than the raw API key.
