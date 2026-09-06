import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function loadGasFiles(files, globals = {}) {
  const context = vm.createContext({ console, ...globals });
  for (const file of files) {
    const source = await readFile(new URL('../' + file, import.meta.url), 'utf8');
    vm.runInContext(source, context, { filename: file });
  }
  return context;
}

function response(status, body, headers = {}) {
  return {
    getResponseCode() { return status; },
    getContentText() { return JSON.stringify(body); },
    getHeaders() { return headers; },
  };
}

function update(id, withDocument = true) {
  return {
    update_id: id,
    message: withDocument
      ? { message_id: id, document: { file_id: 'file-' + id } }
      : { message_id: id, text: 'hello' },
  };
}

test('retry outcome is not recorded as completed', async () => {
  const gas = await loadGasFiles(['Code.js']);
  const completed = [];

  const result = gas.handleUpdateCore_(update(101), {
    isCompleted() { return false; },
    markCompleted(id) { completed.push(id); },
    processMessage() { return { status: 'retry', reason: 'notion_503' }; },
  });

  assert.equal(result.ok, false);
  assert.equal(result.retry, true);
  assert.deepEqual(completed, []);
});

test('processed and permanently skipped outcomes are recorded as completed', async () => {
  const gas = await loadGasFiles(['Code.js']);
  const completed = [];
  const statuses = ['processed', 'skipped'];

  for (let index = 0; index < statuses.length; index += 1) {
    const id = 201 + index;
    const result = gas.handleUpdateCore_(update(id), {
      isCompleted() { return false; },
      markCompleted(doneId) { completed.push(doneId); },
      processMessage() { return { status: statuses[index] }; },
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, statuses[index]);
  }

  assert.deepEqual(completed, [201, 202]);
});

test('duplicate completed update does not process the message again', async () => {
  const gas = await loadGasFiles(['Code.js']);
  let calls = 0;

  const result = gas.handleUpdateCore_(update(301), {
    isCompleted() { return true; },
    markCompleted() { throw new Error('must not write duplicate'); },
    processMessage() { calls += 1; return { status: 'processed' }; },
  });

  assert.equal(result.status, 'duplicate');
  assert.equal(calls, 0);
});

test('polling commits each terminal update and stops before advancing past retry', async () => {
  const gas = await loadGasFiles(['Code.js']);
  const processed = [];
  const offsets = [];

  const result = gas.processPollingBatch_([update(401), update(402), update(403)], {
    processUpdate(item) {
      processed.push(item.update_id);
      return item.update_id === 402
        ? { ok: false, retry: true, status: 'retry' }
        : { ok: true, status: 'processed' };
    },
    commitOffset(nextOffset) { offsets.push(String(nextOffset)); },
  });

  assert.deepEqual(processed, [401, 402]);
  assert.deepEqual(offsets, ['402']);
  assert.equal(result.retry, true);
  assert.equal(result.failedUpdateId, 402);
});

test('polling advances across document-free updates as permanent skips', async () => {
  const gas = await loadGasFiles(['Code.js']);
  const offsets = [];

  const result = gas.processPollingBatch_([update(501, false), update(502)], {
    processUpdate(item) {
      return gas.handleUpdateCore_(item, {
        isCompleted() { return false; },
        markCompleted() {},
        processMessage() { return { status: 'processed' }; },
      });
    },
    commitOffset(nextOffset) { offsets.push(String(nextOffset)); },
  });

  assert.deepEqual(offsets, ['502', '503']);
  assert.equal(result.ok, true);
});

test('API error classification retries rate limits and server errors only', async () => {
  const gas = await loadGasFiles(['utils.js']);

  const rateLimit = gas.makeApiError_('Notion', 429, 'limited', '17');
  const serverError = gas.makeApiError_('Notion', 503, 'down');
  const badRequest = gas.makeApiError_('Notion', 400, 'bad request');

  assert.equal(gas.isRetryableError_(rateLimit), true);
  assert.equal(rateLimit.retryAfterSeconds, 17);
  assert.equal(gas.isRetryableError_(serverError), true);
  assert.equal(gas.isRetryableError_(badRequest), false);
  assert.equal(gas.isRetryableError_(new Error('network failure')), true);
});

test('message failure outcome skips permanent errors and retries transient errors', async () => {
  const gas = await loadGasFiles(['Code.js', 'utils.js']);

  const permanent = gas.failureOutcome_('notion_upload_failed', { retryable: false, status: 400 });
  const transient = gas.failureOutcome_('notion_upload_failed', { retryable: true, status: 503 });

  assert.equal(permanent.status, 'skipped');
  assert.equal(permanent.reason, 'notion_upload_failed_permanent');
  assert.equal(transient.status, 'retry');
  assert.equal(transient.reason, 'notion_upload_failed');
});

test('Notion rate limit errors preserve Retry-After metadata', async () => {
  const gas = await loadGasFiles(['utils.js', 'notion.js'], {
    PropertiesService: {
      getScriptProperties() {
        return { getProperty() { return 'notion-token'; } };
      },
    },
    UrlFetchApp: {
      fetch() {
        return response(429, { object: 'error', message: 'rate limited' }, { 'Retry-After': '9' });
      },
    },
  });

  assert.throws(
    () => gas.createFileUpload('meeting.pdf', 'application/pdf'),
    (error) => error.retryable === true && error.status === 429 && error.retryAfterSeconds === 9
  );
});

test('Telegram client errors are classified as permanent', async () => {
  const gas = await loadGasFiles(['utils.js', 'telegram.js'], {
    PropertiesService: {
      getScriptProperties() {
        return { getProperty() { return 'telegram-token'; } };
      },
    },
    UrlFetchApp: {
      fetch() {
        return response(400, { ok: false, description: 'bad file id' });
      },
    },
  });

  assert.throws(
    () => gas.downloadTelegramFile('invalid-file'),
    (error) => error.retryable === false && error.status === 400
  );
});

test('webhook URL validation accepts only an HTTPS non-GAS endpoint', async () => {
  const gas = await loadGasFiles(['utils.js', 'webhook.js']);

  assert.equal(
    gas.validateWebhookUrl_('https://telegram-notion-webhook.eyeom40.workers.dev'),
    'https://telegram-notion-webhook.eyeom40.workers.dev'
  );
  assert.throws(() => gas.validateWebhookUrl_(''), /Worker/);
  assert.throws(() => gas.validateWebhookUrl_('http://example.com/hook'), /HTTPS/);
  assert.throws(() => gas.validateWebhookUrl_('https://script.google.com/macros/s/abc/dev'), /GAS/);
  assert.throws(() => gas.validateWebhookUrl_('https://script.google.com/macros/s/abc/exec'), /GAS/);
});

test('webhook setup requires a secret, limits concurrency, and verifies Telegram state', async () => {
  const calls = [];
  const workerUrl = 'https://telegram-notion-webhook.eyeom40.workers.dev';
  const gas = await loadGasFiles(['utils.js', 'webhook.js'], {
    PropertiesService: {
      getScriptProperties() {
        return { getProperty() { return 'telegram-token'; } };
      },
    },
    ScriptApp: {
      getProjectTriggers() { return []; },
      deleteTrigger() {},
    },
    UrlFetchApp: {
      fetch(url, options) {
        calls.push({ url, options });
        if (url.includes('/setWebhook')) return response(200, { ok: true, result: true });
        if (url.includes('/getWebhookInfo')) {
          return response(200, { ok: true, result: { url: workerUrl } });
        }
        throw new Error('unexpected URL ' + url);
      },
    },
  });

  assert.throws(() => gas.enableWebhookMode(workerUrl, ''), /secret/i);
  const result = gas.enableWebhookMode(workerUrl, 'telegram-webhook-secret');
  const payload = JSON.parse(calls[0].options.payload);

  assert.equal(result.webhookUrl, workerUrl);
  assert.equal(payload.url, workerUrl);
  assert.equal(payload.max_connections, 1);
  assert.equal(payload.secret_token, 'telegram-webhook-secret');
  assert.equal(calls.length, 2);
});
