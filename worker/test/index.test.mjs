import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorker } from '../src/index.js';

const env = {
  GAS_EXEC_URL: 'https://script.google.com/macros/s/example/exec',
  GAS_PROXY_SECRET: 'proxy-secret',
  TG_WEBHOOK_SECRET: 'telegram-secret',
};

function telegramRequest(body = { update_id: 123, message: { text: 'hello' } }, secret = 'telegram-secret') {
  return new Request('https://telegram-notion-webhook.example.workers.dev', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': secret,
    },
    body: JSON.stringify(body),
  });
}

test('returns 503 when GAS asks Telegram to retry the update', async () => {
  const worker = createWorker(async () => new Response(JSON.stringify({
    ok: false,
    retry: true,
    status: 'retry',
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));

  const response = await worker.fetch(telegramRequest(), env);

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, retry: true });
});

test('returns 200 only after GAS reports a terminal processed outcome', async () => {
  let forwarded = false;
  const worker = createWorker(async () => {
    forwarded = true;
    return new Response(JSON.stringify({ ok: true, status: 'processed' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  const response = await worker.fetch(telegramRequest(), env);

  assert.equal(forwarded, true);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, status: 'processed' });
});

test('returns 503 when the GAS request throws', async () => {
  const worker = createWorker(async () => {
    throw new Error('network unavailable');
  });

  const response = await worker.fetch(telegramRequest(), env);

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, retry: true });
});

test('returns 503 when GAS returns a non-2xx response', async () => {
  const worker = createWorker(async () => new Response('unavailable', { status: 500 }));

  const response = await worker.fetch(telegramRequest(), env);

  assert.equal(response.status, 503);
});

test('returns 503 when GAS returns malformed JSON', async () => {
  const worker = createWorker(async () => new Response('not-json', { status: 200 }));

  const response = await worker.fetch(telegramRequest(), env);

  assert.equal(response.status, 503);
});

test('rejects malformed Telegram JSON before forwarding', async () => {
  let calls = 0;
  const worker = createWorker(async () => {
    calls += 1;
    return new Response('{}');
  });
  const request = new Request('https://telegram-notion-webhook.example.workers.dev', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': 'telegram-secret',
    },
    body: '{broken',
  });

  const response = await worker.fetch(request, env);

  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});

test('rejects updates without an integer update_id before forwarding', async () => {
  let calls = 0;
  const worker = createWorker(async () => {
    calls += 1;
    return new Response('{}');
  });

  const response = await worker.fetch(telegramRequest({ message: { text: 'hello' } }), env);

  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});

test('rejects a mismatched Telegram webhook secret before reading the update', async () => {
  let calls = 0;
  const worker = createWorker(async () => {
    calls += 1;
    return new Response('{}');
  });

  const response = await worker.fetch(telegramRequest(undefined, 'wrong-secret'), env);

  assert.equal(response.status, 403);
  assert.equal(calls, 0);
});

test('fails closed when a required Worker secret is missing', async () => {
  let calls = 0;
  const worker = createWorker(async () => {
    calls += 1;
    return new Response('{}');
  });

  const response = await worker.fetch(telegramRequest(), {
    ...env,
    TG_WEBHOOK_SECRET: '',
  });

  assert.equal(response.status, 500);
  assert.equal(calls, 0);
});
