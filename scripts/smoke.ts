/**
 * Step-zero check: does this @google/genai version actually deliver
 * inputTranscription messages for streamed PCM audio?
 *
 * Usage:
 *   npm run smoke                  # streams a synthetic tone (expects NO words)
 *   npm run smoke -- sample.wav    # streams a real 16kHz mono PCM WAV
 *
 * The tone run proves the transport works (setupComplete arrives, audio is
 * accepted, no 1007). A real WAV proves transcription itself works.
 */
import { readFileSync } from 'node:fs';
import { createGeminiLiveTranscriber } from '../src/speech.js';
import { config } from '../src/config.js';

const FRAME_MS = 100;
const SAMPLES_PER_FRAME = (config.sampleRateHertz * FRAME_MS) / 1000;

function syntheticTone(seconds: number): Buffer {
  const total = config.sampleRateHertz * seconds;
  const pcm = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i += 1) {
    const value = Math.sin((2 * Math.PI * 440 * i) / config.sampleRateHertz) * 0.3 * 32767;
    pcm.writeInt16LE(Math.round(value), i * 2);
  }
  return pcm;
}

/** Minimal WAV reader: finds the `data` chunk and validates the format we require. */
function readWav(file: string): Buffer {
  const buf = readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${file} is not a RIFF/WAVE file.`);
  }
  let offset = 12;
  let fmt: { channels: number; rate: number; bits: number } | null = null;
  while (offset + 8 <= buf.byteLength) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data chunk appeared before fmt chunk.');
      if (fmt.channels !== 1 || fmt.rate !== config.sampleRateHertz || fmt.bits !== 16) {
        throw new Error(
          `WAV must be mono 16-bit ${config.sampleRateHertz} Hz, got ` +
            `${fmt.channels}ch ${fmt.bits}-bit ${fmt.rate} Hz. Convert with:\n` +
            `  ffmpeg -i ${file} -ac 1 -ar ${config.sampleRateHertz} -sample_fmt s16 out.wav`,
        );
      }
      return buf.subarray(body, body + size);
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  throw new Error('No data chunk found in WAV file.');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const file = process.argv[2];
  const pcm = file ? readWav(file) : syntheticTone(4);
  const label = file ? file : 'synthetic 440Hz tone (4s)';

  console.log(`model:  ${config.liveModel}`);
  console.log(`audio:  ${label} — ${pcm.byteLength} bytes, ${(pcm.byteLength / 2 / config.sampleRateHertz).toFixed(1)}s`);
  console.log(`config: mode=${config.mode} wordTimestamps=${config.wordTimestamps} diarization=${config.diarization}\n`);

  let interimCount = 0;
  let committedCount = 0;
  let committed = '';
  let fatal: string | null = null;

  const transcriber = await createGeminiLiveTranscriber({
    onOpen: () => console.log('-- upstream open'),
    onChunk: (chunk) => {
      if (chunk.isCommitted) {
        committedCount += 1;
        committed += chunk.text;
        console.log(`[committed${chunk.finished ? ' final' : ''}] ${JSON.stringify(chunk.text)}`);
        if (chunk.words?.length) console.log('           words:', chunk.words);
      } else {
        interimCount += 1;
        console.log(`[interim  ] ${JSON.stringify(chunk.text)}`);
      }
    },
    onTurnComplete: () => console.log('-- turnComplete'),
    onGoAway: (timeLeft) => console.log(`-- goAway timeLeft=${timeLeft ?? 'unknown'}`),
    onResumptionHandle: () => console.log('-- resumption handle received'),
    onError: (error) => {
      fatal = error.message;
      console.error(`-- ERROR: ${error.message}`);
    },
    onClose: (reason) => console.log(`-- upstream closed: ${reason}`),
  });

  // Stream in real time; blasting it all at once is not a realistic test.
  const frameBytes = SAMPLES_PER_FRAME * 2;
  for (let offset = 0; offset < pcm.byteLength; offset += frameBytes) {
    transcriber.sendAudio(pcm.subarray(offset, Math.min(offset + frameBytes, pcm.byteLength)));
    await sleep(FRAME_MS);
  }
  transcriber.endAudioStream();
  console.log('-- audio sent, waiting 8s for trailing transcription');
  await sleep(8000);
  transcriber.close();

  console.log('\n=== result ===');
  console.log(`interim chunks:   ${interimCount}`);
  console.log(`committed chunks: ${committedCount}`);
  console.log(`transcript:       ${JSON.stringify(committed)}`);

  if (fatal) {
    console.error(`\nFAIL — upstream error: ${fatal}`);
    process.exit(1);
  }
  if (!file) {
    console.log('\nPASS (transport) — audio accepted without an upstream error.');
    console.log('A tone has no speech, so empty transcript output here is expected.');
    console.log(`Next: npm run smoke -- your-speech.wav`);
    return;
  }
  if (committedCount === 0 && interimCount === 0) {
    console.error('\nFAIL — no transcription messages arrived for real speech audio.');
    console.error('This is the known SDK/model gap; try another GEMINI_LIVE_MODEL.');
    process.exit(1);
  }
  console.log('\nPASS — transcription messages received.');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL — ${message}`);
  if (/api key/i.test(message)) {
    console.error('Check GEMINI_API_KEY in .env (https://aistudio.google.com/apikey).');
  } else if (/timed out/i.test(message)) {
    console.error('Upstream never completed setup. Try another GEMINI_LIVE_MODEL.');
  } else if (/not found|does not exist|unsupported/i.test(message)) {
    console.error(`Model "${config.liveModel}" may not support the Live API. See .env.example.`);
  }
  process.exit(1);
});
