import {
  AudioTranscriptionConfigMode,
  GoogleGenAI,
  Modality,
  TurnCoverage,
  type LiveServerMessage,
  type Session,
} from '@google/genai';
import { config } from './config.js';

const RESPONSE_MODALITIES = {
  AUDIO: Modality.AUDIO,
  TEXT: Modality.TEXT,
} as const;

const TRANSCRIPTION_MODES = {
  VERBATIM: AudioTranscriptionConfigMode.VERBATIM,
  SMART: AudioTranscriptionConfigMode.SMART,
} as const;

export interface TranscriptWord {
  word: string;
  startOffset?: string;
  endOffset?: string;
}

/**
 * One transcription update from the engine.
 * `isCommitted: false` is a volatile preview that a later chunk may supersede;
 * `isCommitted: true` is an additive delta for the current segment.
 */
export interface TranscriptChunk {
  text: string;
  isCommitted: boolean;
  finished: boolean;
  words?: TranscriptWord[];
  speaker?: string;
}

export interface TranscriberCallbacks {
  onOpen: () => void;
  onChunk: (chunk: TranscriptChunk) => void;
  /** Server signalled end of the current spoken turn. */
  onTurnComplete: () => void;
  /** Upstream will drop the connection soon; `timeLeft` is the API's raw duration string. */
  onGoAway: (timeLeft: string | undefined) => void;
  /** A resumption handle valid for reconnecting without losing session state. */
  onResumptionHandle: (handle: string) => void;
  onError: (error: Error) => void;
  onClose: (reason: string) => void;
}

/** Engine-agnostic contract, so a different ASR backend is a one-file swap. */
export interface Transcriber {
  sendAudio(pcm: Buffer): void;
  /** Tell the engine the mic stopped, so it flushes any pending transcription. */
  endAudioStream(): void;
  close(): void;
}

export interface ConnectOptions {
  /** Handle from a previous session, to resume rather than start fresh. */
  resumeHandle?: string;
}

/**
 * Gemini Live adapter. We only consume the *input* transcription — the model's
 * own generated turns are discarded, since this is a transcription service and
 * not a chat. `responseModalities: [TEXT]` plus the system instruction keeps
 * that output minimal; it cannot be disabled outright.
 */
export async function createGeminiLiveTranscriber(
  callbacks: TranscriberCallbacks,
  options: ConnectOptions = {},
): Promise<Transcriber> {
  const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

  let closed = false;
  /** True once connect() has produced a usable session (or definitively failed). */
  let settled = false;
  /** True when we gave up waiting, so a late-arriving session must be discarded. */
  let abandoned = false;

  // An invalid key closes the socket with 1007 and setup never completes, so
  // ai.live.connect() stays pending forever. Route pre-setup failures into a
  // rejection and impose a deadline, making this function's contract "resolves
  // only with a usable session, otherwise throws".
  let failAttempt: (error: Error) => void = () => {};
  const earlyFailure = new Promise<never>((_, reject) => {
    failAttempt = reject;
  });
  let deadlineTimer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(
      () => reject(new Error(`Upstream connect timed out after ${config.connectTimeoutMs}ms.`)),
      config.connectTimeoutMs,
    );
  });

  const handleMessage = (message: LiveServerMessage): void => {
    if (message.sessionResumptionUpdate?.resumable && message.sessionResumptionUpdate.newHandle) {
      callbacks.onResumptionHandle(message.sessionResumptionUpdate.newHandle);
    }
    if (message.goAway) {
      callbacks.onGoAway(message.goAway.timeLeft);
    }

    const content = message.serverContent;
    if (!content) return;

    // Low-latency preview while the user is still speaking.
    const interim = content.interimInputTranscription;
    if (interim?.text) {
      callbacks.onChunk({
        text: interim.text,
        isCommitted: false,
        finished: interim.finished ?? false,
        ...(interim.words ? { words: toWords(interim.words) } : {}),
        ...(interim.speakerLabel ? { speaker: interim.speakerLabel } : {}),
      });
    }

    // Committed transcription of the user's audio.
    const input = content.inputTranscription;
    if (input?.text) {
      callbacks.onChunk({
        text: input.text,
        isCommitted: true,
        finished: input.finished ?? false,
        ...(input.words ? { words: toWords(input.words) } : {}),
        ...(input.speakerLabel ? { speaker: input.speakerLabel } : {}),
      });
    }

    if (content.turnComplete) {
      callbacks.onTurnComplete();
    }
  };

  const attempt = ai.live.connect({
    model: config.liveModel,
    callbacks: {
      onopen: () => callbacks.onOpen(),
      onmessage: handleMessage,
      onerror: (event) => {
        const error = new Error(errorMessage(event));
        if (!settled) {
          failAttempt(error);
          return;
        }
        callbacks.onError(error);
      },
      onclose: (event) => {
        const reason = closeReason(event);
        if (!settled) {
          failAttempt(new Error(reason));
          return;
        }
        if (closed) return;
        closed = true;
        callbacks.onClose(reason);
      },
    },
    config: {
      responseModalities: [RESPONSE_MODALITIES[config.responseModality]],
      // Suppresses the model's spoken reply; we only consume input transcription.
      maxOutputTokens: config.maxOutputTokens,
      systemInstruction:
        'You are a silent transcription relay. Never reply, never comment, ' +
        'never acknowledge. Output nothing at all.',
      inputAudioTranscription: {
        languageCodes: [...config.languageCodes],
        wordTimestamp: config.wordTimestamps,
        diarization: config.diarization,
        mode: TRANSCRIPTION_MODES[config.mode],
        ...(config.customVocabulary.length
          ? { customVocabulary: [...config.customVocabulary] }
          : {}),
      },
      realtimeInputConfig: {
        // Default only transcribes detected speech activity; we want every
        // sample the client sends, including across pauses.
        turnCoverage: TurnCoverage.TURN_INCLUDES_ALL_INPUT,
      },
      // Ask for handles so a session nearing its duration cap can be resumed.
      sessionResumption: options.resumeHandle ? { handle: options.resumeHandle } : {},
      contextWindowCompression: { slidingWindow: {} },
    },
  });

  // A session that connects after we stopped waiting would otherwise stay open
  // upstream with nobody reading it.
  void attempt
    .then((late) => {
      if (abandoned) late.close();
    })
    .catch(() => {});

  let session: Session;
  try {
    session = await Promise.race([attempt, earlyFailure, deadline]);
    settled = true;
  } catch (error) {
    settled = true;
    abandoned = true;
    closed = true;
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
  }

  return {
    sendAudio(pcm: Buffer): void {
      if (closed) return;
      session.sendRealtimeInput({
        audio: {
          data: pcm.toString('base64'),
          mimeType: `audio/pcm;rate=${config.sampleRateHertz}`,
        },
      });
    },
    endAudioStream(): void {
      if (closed) return;
      session.sendRealtimeInput({ audioStreamEnd: true });
    },
    close(): void {
      if (closed) return;
      closed = true;
      session.close();
    },
  };
}

function toWords(words: { word?: string; startOffset?: string; endOffset?: string }[]): TranscriptWord[] {
  return words.flatMap((entry) =>
    entry.word
      ? [
          {
            word: entry.word,
            ...(entry.startOffset ? { startOffset: entry.startOffset } : {}),
            ...(entry.endOffset ? { endOffset: entry.endOffset } : {}),
          },
        ]
      : [],
  );
}

function errorMessage(event: unknown): string {
  if (event && typeof event === 'object' && 'message' in event) {
    const { message } = event as { message?: unknown };
    if (typeof message === 'string' && message) return message;
  }
  return 'Upstream Gemini Live error';
}

function closeReason(event: unknown): string {
  if (event && typeof event === 'object') {
    const { code, reason } = event as { code?: unknown; reason?: unknown };
    const parts = [
      typeof code === 'number' ? `code ${code}` : null,
      typeof reason === 'string' && reason ? reason : null,
    ].filter(Boolean);
    if (parts.length) return parts.join(': ');
  }
  return 'upstream closed';
}
