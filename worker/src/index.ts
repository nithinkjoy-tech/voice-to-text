/**
 * Cloudflare Worker: mints short-lived Gemini Live tokens for browser clients.
 *
 * The browser connects to the Live API directly, so audio never passes through
 * this Worker — it only hands out constrained, single-use credentials. That is
 * what makes this deployable on Workers at all: no long-lived WebSocket, no
 * Durable Object, just one stateless request per recording session.
 */

export interface Env {
  /** wrangler secret put GEMINI_API_KEY */
  GEMINI_API_KEY: string;
  GEMINI_LIVE_MODEL?: string;
  TRANSCRIPTION_MODE?: string;
  /** Comma-separated origins allowed to request tokens. "*" allows any. */
  ALLOWED_ORIGINS?: string;
  ASSETS: { fetch: (request: Request) => Promise<Response> };
}

const DEFAULT_MODEL = 'gemini-3.1-flash-live-preview';
const TOKEN_ENDPOINT = 'https://generativelanguage.googleapis.com/v1alpha/auth_tokens';

/** How long the token may hold an open session. */
const SESSION_TTL_MS = 30 * 60_000;
/** How long the client has to actually start connecting. */
const CONNECT_WINDOW_MS = 120_000;

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const allowed = (env.ALLOWED_ORIGINS ?? '*').split(',').map((value) => value.trim());
  const permit = allowed.includes('*') || (origin !== null && allowed.includes(origin));
  if (!permit) return {};
  return {
    'access-control-allow-origin': origin && !allowed.includes('*') ? origin : '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
  };
}

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra },
  });
}

/**
 * Everything the client is allowed to use is pinned here and locked with a
 * field mask, so a token cannot be replayed with a different model or a raised
 * output-token budget.
 */
function buildSetup(env: Env) {
  const model = env.GEMINI_LIVE_MODEL ?? DEFAULT_MODEL;
  const mode = env.TRANSCRIPTION_MODE ?? 'VERBATIM';
  return {
    setup: {
      model: `models/${model}`,
      generationConfig: {
        // Native-audio models reject TEXT. maxOutputTokens:1 suppresses the
        // model's spoken reply, which we never want and would otherwise pay for.
        responseModalities: ['AUDIO'],
        maxOutputTokens: 1,
      },
      inputAudioTranscription: { languageCodes: ['en-US'], mode },
      realtimeInputConfig: { turnCoverage: 'TURN_INCLUDES_ALL_INPUT' },
    },
    fieldMask: [
      'model',
      'generationConfig.responseModalities',
      'generationConfig.maxOutputTokens',
      'inputAudioTranscription.languageCodes',
      'inputAudioTranscription.mode',
      'realtimeInputConfig.turnCoverage',
    ].join(','),
  };
}

async function mintToken(env: Env): Promise<Response> {
  if (!env.GEMINI_API_KEY) {
    return json({ error: 'server_misconfigured', message: 'GEMINI_API_KEY is not set.' }, 500);
  }

  const now = Date.now();
  const { setup, fieldMask } = buildSetup(env);

  const upstream = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({
      uses: 1,
      expireTime: new Date(now + SESSION_TTL_MS).toISOString(),
      newSessionExpireTime: new Date(now + CONNECT_WINDOW_MS).toISOString(),
      bidiGenerateContentSetup: setup,
      fieldMask,
    }),
  });

  if (!upstream.ok) {
    const detail = await upstream.text();
    console.error('token mint failed', upstream.status, detail.slice(0, 500));
    // Don't leak upstream error bodies (they can echo request details) to callers.
    return json({ error: 'token_mint_failed', status: upstream.status }, 502);
  }

  const minted = (await upstream.json()) as { name?: string };
  if (!minted.name) {
    return json({ error: 'token_mint_failed', message: 'Upstream returned no token name.' }, 502);
  }

  return json(
    {
      token: minted.name,
      model: env.GEMINI_LIVE_MODEL ?? DEFAULT_MODEL,
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
      connectBefore: new Date(now + CONNECT_WINDOW_MS).toISOString(),
    },
    200,
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('origin');
    const cors = corsHeaders(origin, env);

    if (url.pathname === '/api/token') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: cors });
      }
      if (request.method !== 'POST') {
        return json({ error: 'method_not_allowed' }, 405, { allow: 'POST, OPTIONS' });
      }
      if (origin !== null && Object.keys(cors).length === 0) {
        return json({ error: 'origin_not_allowed' }, 403);
      }
      const response = await mintToken(env);
      for (const [key, value] of Object.entries(cors)) response.headers.set(key, value);
      return response;
    }

    if (url.pathname === '/api/health') {
      return json({ status: 'ok', model: env.GEMINI_LIVE_MODEL ?? DEFAULT_MODEL }, 200);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
