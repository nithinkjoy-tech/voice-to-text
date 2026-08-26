import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { handleSession } from './session.js';

const WS_PATH = '/ws/transcribe';

const app = express();

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', model: config.liveModel, wsPath: WS_PATH });
});

// The browser test client lives here. Resolved from the working directory so
// the path is the same under `tsx` (src/) and compiled output (dist/src/).
app.use(express.static(path.resolve(process.cwd(), 'public')));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: WS_PATH });

wss.on('connection', (ws) => {
  const sessionId = randomUUID().slice(0, 8);
  console.log(`[${sessionId}] client connected`);
  handleSession(ws, sessionId);
});

server.listen(config.port, () => {
  console.log(`voice-to-text listening on http://localhost:${config.port}`);
  console.log(`  websocket: ws://localhost:${config.port}${WS_PATH}`);
  console.log(`  model:     ${config.liveModel}`);
  console.log(`  audio in:  PCM16 ${config.sampleRateHertz} Hz mono, ${config.languageCodes.join(', ')}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n${signal} received, shutting down`);
    for (const client of wss.clients) client.close();
    server.close(() => process.exit(0));
  });
}
