import type { RawData, WebSocket } from 'ws';
import { config } from './config.js';
import {
  createGeminiLiveTranscriber,
  type Transcriber,
  type TranscriptChunk,
  type TranscriptWord,
} from './speech.js';

type ServerMessage =
  | { type: 'ready' }
  | {
      type: 'transcript';
      delta: string;
      text: string;
      isFinal: boolean;
      words?: TranscriptWord[];
      speaker?: string;
    }
  | { type: 'reconnecting'; reason: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'closed'; reason: string };

/**
 * Bridges one browser WebSocket to one upstream transcription session.
 *
 * The upstream session has a hard duration cap (~15 min for audio-only), so the
 * browser connection deliberately outlives it: on a `goAway` we reconnect
 * upstream using a resumption handle while buffering audio, and the client sees
 * only a `reconnecting` notice.
 */
export function handleSession(ws: WebSocket, sessionId: string): void {
  let transcriber: Transcriber | null = null;
  let connecting = false;
  let clientClosed = false;

  /** Audio that arrived before the upstream session was ready. */
  const pending: Buffer[] = [];
  let pendingBytes = 0;
  let droppedFrames = 0;

  /** Committed text for the current spoken segment. */
  let segment = '';
  let resumeHandle: string | undefined;
  /** Set once the client asked to stop; we linger briefly for trailing text. */
  let stopping = false;
  let stopTimer: NodeJS.Timeout | undefined;

  const log = (message: string, extra?: unknown): void => {
    if (extra === undefined) console.log(`[${sessionId}] ${message}`);
    else console.log(`[${sessionId}] ${message}`, extra);
  };

  const send = (message: ServerMessage): void => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(message));
  };

  const fail = (code: string, message: string): void => {
    send({ type: 'error', code, message });
  };

  const flushPending = (): void => {
    if (!transcriber) return;
    for (const chunk of pending) transcriber.sendAudio(chunk);
    pending.length = 0;
    pendingBytes = 0;
  };

  const onChunk = (chunk: TranscriptChunk): void => {
    if (chunk.isCommitted) {
      segment += chunk.text;
      send({
        type: 'transcript',
        delta: chunk.text,
        text: segment,
        isFinal: chunk.finished,
        ...(chunk.words ? { words: chunk.words } : {}),
        ...(chunk.speaker ? { speaker: chunk.speaker } : {}),
      });
      if (chunk.finished) segment = '';
      return;
    }

    // Volatile preview: show it appended to committed text, but don't retain it.
    send({
      type: 'transcript',
      delta: chunk.text,
      text: segment + chunk.text,
      isFinal: false,
      ...(chunk.words ? { words: chunk.words } : {}),
      ...(chunk.speaker ? { speaker: chunk.speaker } : {}),
    });
  };

  const onTurnComplete = (): void => {
    if (segment) {
      send({ type: 'transcript', delta: '', text: segment, isFinal: true });
      segment = '';
    }
    // The flush we were waiting for has landed; no need to sit out the rest of
    // the grace period.
    if (stopping) closeClient('client_stop');
  };

  /**
   * Ask the engine to flush, then close once it does or the grace period
   * expires, whichever comes first.
   */
  const beginStop = (): void => {
    if (stopping || clientClosed) return;
    stopping = true;
    if (!transcriber) {
      closeClient('client_stop');
      return;
    }
    transcriber.endAudioStream();
    stopTimer = setTimeout(() => closeClient('client_stop'), config.stopGraceMs);
  };

  async function connect(reason: string): Promise<void> {
    if (connecting || clientClosed) return;
    connecting = true;
    try {
      // Resolves only with a usable session; pre-setup failures and timeouts
      // are thrown, so there is no silent-hang case to guard against here.
      transcriber = await createGeminiLiveTranscriber(
        {
          onOpen: () => log('upstream open'),
          onChunk,
          onTurnComplete,
          onGoAway: (timeLeft) => {
            log(`upstream goAway, timeLeft=${timeLeft ?? 'unknown'}`);
            void reconnect('upstream session limit');
          },
          onResumptionHandle: (handle) => {
            resumeHandle = handle;
          },
          onError: (error) => {
            log('upstream error', error.message);
            fail('UPSTREAM_ERROR', error.message);
          },
          onClose: (closeReasonText) => {
            log(`upstream closed: ${closeReasonText}`);
            // A close we did not initiate is fatal for this session; surface it
            // rather than leaving the client streaming into a void. During a
            // deliberate reconnect, `transcriber` is already null.
            if (!clientClosed && transcriber) {
              fail('UPSTREAM_CLOSED', closeReasonText);
              closeClient('upstream_closed');
            }
          },
        },
        resumeHandle ? { resumeHandle } : {},
      );
      log(`upstream connected (${reason})`);
      send({ type: 'ready' });
      flushPending();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log('upstream connect failed', message);
      transcriber = null;
      fail('UPSTREAM_CONNECT_FAILED', message);
      closeClient('upstream_connect_failed');
    } finally {
      connecting = false;
    }
  }

  async function reconnect(reason: string): Promise<void> {
    if (clientClosed) return;
    send({ type: 'reconnecting', reason });
    const previous = transcriber;
    transcriber = null;
    previous?.close();
    await connect(reason);
  }

  function closeClient(reason: string): void {
    if (clientClosed) return;
    clientClosed = true;
    clearTimeout(stopTimer);
    // Emit whatever was committed but never terminated by a turnComplete.
    if (segment) {
      send({ type: 'transcript', delta: '', text: segment, isFinal: true });
      segment = '';
    }
    send({ type: 'closed', reason });
    transcriber?.close();
    transcriber = null;
    if (ws.readyState === ws.OPEN) ws.close();
  }

  const onAudio = (frame: Buffer): void => {
    if (frame.byteLength === 0) return;
    if (frame.byteLength > config.maxAudioFrameBytes) {
      fail(
        'FRAME_TOO_LARGE',
        `Audio frame of ${frame.byteLength} bytes exceeds the ${config.maxAudioFrameBytes} byte limit.`,
      );
      return;
    }
    // PCM16 means every sample is 2 bytes; an odd length is a client bug that
    // would otherwise silently misalign the whole stream.
    if (frame.byteLength % 2 !== 0) {
      fail('BAD_FRAME_ALIGNMENT', 'Audio frame length must be a multiple of 2 (16-bit samples).');
      return;
    }

    if (transcriber) {
      transcriber.sendAudio(frame);
      return;
    }

    if (pendingBytes + frame.byteLength > config.maxPendingAudioBytes) {
      droppedFrames += 1;
      if (droppedFrames === 1 || droppedFrames % 50 === 0) {
        log(`dropping audio while upstream unavailable (${droppedFrames} frames so far)`);
      }
      return;
    }
    pending.push(frame);
    pendingBytes += frame.byteLength;
    void connect('first audio frame');
  };

  const onControl = (raw: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      fail('BAD_CONTROL_MESSAGE', 'Control frames must be valid JSON.');
      return;
    }
    const type =
      parsed && typeof parsed === 'object' ? (parsed as { type?: unknown }).type : undefined;

    switch (type) {
      case 'start':
        void connect('client start');
        break;
      case 'stop':
        beginStop();
        break;
      default:
        fail('UNKNOWN_CONTROL_TYPE', `Unsupported control message type: ${String(type)}`);
    }
  };

  ws.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      onAudio(toBuffer(data));
      return;
    }
    onControl(toBuffer(data).toString('utf8'));
  });

  ws.on('close', () => {
    clientClosed = true;
    clearTimeout(stopTimer);
    transcriber?.close();
    transcriber = null;
    log('client disconnected');
  });

  ws.on('error', (error: Error) => {
    log('client socket error', error.message);
    clientClosed = true;
    clearTimeout(stopTimer);
    transcriber?.close();
    transcriber = null;
  });
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
