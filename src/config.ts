import 'dotenv/config';

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Env var ${name} must be a positive integer, got "${raw}".`);
  }
  return parsed;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`Env var ${name} must be true or false, got "${raw}".`);
}

function modalityEnv(): 'AUDIO' | 'TEXT' {
  const raw = process.env.RESPONSE_MODALITY?.trim().toUpperCase() ?? 'AUDIO';
  if (raw !== 'AUDIO' && raw !== 'TEXT') {
    throw new Error(`RESPONSE_MODALITY must be AUDIO or TEXT, got "${raw}".`);
  }
  return raw;
}

function modeEnv(): 'VERBATIM' | 'SMART' {
  const raw = process.env.TRANSCRIPTION_MODE?.trim().toUpperCase() ?? 'VERBATIM';
  if (raw !== 'VERBATIM' && raw !== 'SMART') {
    throw new Error(`TRANSCRIPTION_MODE must be VERBATIM or SMART, got "${raw}".`);
  }
  return raw;
}

const wordTimestamps = boolEnv('WORD_TIMESTAMPS', false);
const diarization = boolEnv('DIARIZATION', false);
const mode = modeEnv();

// The API rejects timestamps/diarization combined with SMART mode, so catch it
// at boot rather than as an opaque 1007 close mid-session.
if (mode === 'SMART' && (wordTimestamps || diarization)) {
  throw new Error(
    'TRANSCRIPTION_MODE=SMART is incompatible with WORD_TIMESTAMPS or DIARIZATION. ' +
      'Use VERBATIM, or disable both.',
  );
}

export const config = {
  port: intEnv('PORT', 8080),
  geminiApiKey: requireEnv('GEMINI_API_KEY'),
  liveModel: process.env.GEMINI_LIVE_MODEL?.trim() || 'gemini-3.1-flash-live-preview',

  /** Fixed: the client contract is raw little-endian 16-bit PCM, mono. */
  sampleRateHertz: 16000,
  languageCodes: ['en-US'],

  wordTimestamps,
  diarization,
  mode,

  /**
   * Native-audio Live models reject TEXT output, so AUDIO is the safe default
   * even though we discard whatever the model generates. Only set TEXT for a
   * model known to support it (e.g. gemini-2.0-flash-live-001).
   */
  responseModality: modalityEnv(),

  /**
   * Gemini Live is conversational and generates a spoken reply to everything it
   * hears; a system instruction does not stop it (measured: 32 generated audio
   * turns for a 13s clip). Capping output tokens suppresses generation entirely
   * without affecting input transcription. Raise only if a model rejects it.
   */
  maxOutputTokens: intEnv('MAX_OUTPUT_TOKENS', 1),

  /** Comma-separated terms to bias the recognizer toward (names, jargon). */
  customVocabulary:
    process.env.CUSTOM_VOCABULARY?.split(',')
      .map((term) => term.trim())
      .filter(Boolean) ?? [],

  /** Reject absurd frames early; 64 KiB is ~2s of 16kHz PCM16. */
  maxAudioFrameBytes: intEnv('MAX_AUDIO_FRAME_BYTES', 64 * 1024),
  /** Cap on audio buffered while the upstream session is reconnecting. */
  maxPendingAudioBytes: intEnv('MAX_PENDING_AUDIO_BYTES', 2 * 1024 * 1024),
  /**
   * Upstream connect deadline. The SDK's connect() waits for setup to complete,
   * which never arrives on auth failure, so without this a bad key leaves the
   * client waiting in silence forever.
   */
  connectTimeoutMs: intEnv('CONNECT_TIMEOUT_MS', 15000),
  /**
   * After the client says stop we ask the engine to flush, then wait this long
   * for trailing transcription before closing. Closing immediately would throw
   * away the tail of the last utterance.
   */
  stopGraceMs: intEnv('STOP_GRACE_MS', 3000),
} as const;

export type Config = typeof config;
