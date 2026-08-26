/**
 * Converts the graph's Float32 mono audio to 16-bit PCM at TARGET_RATE and
 * posts ~100ms buffers to the main thread.
 *
 * AudioContext is created at 16kHz where the browser allows it, but Safari and
 * some devices ignore that and run at 44.1/48kHz, so we resample here rather
 * than trusting sampleRate to match.
 */
const TARGET_RATE = 16000;
const FRAME_MS = 100;

class PcmWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.framesPerChunk = (TARGET_RATE * FRAME_MS) / 1000;
    this.buffer = new Int16Array(this.framesPerChunk);
    this.filled = 0;
    // Fractional read position into the incoming block, carried across blocks.
    this.cursor = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    while (this.cursor < channel.length) {
      const index = Math.floor(this.cursor);
      const sample = Math.max(-1, Math.min(1, channel[index]));
      this.buffer[this.filled++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;

      if (this.filled === this.framesPerChunk) {
        // Copy: the buffer is reused immediately after transfer.
        this.port.postMessage(this.buffer.slice());
        this.filled = 0;
      }
      this.cursor += this.ratio;
    }
    this.cursor -= channel.length;
    return true;
  }
}

registerProcessor('pcm-worklet', PcmWorklet);
