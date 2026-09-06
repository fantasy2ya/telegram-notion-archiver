import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function loadGasFiles(files) {
  const context = vm.createContext({ console });
  for (const file of files) {
    const source = await readFile(new URL('../' + file, import.meta.url), 'utf8');
    vm.runInContext(source, context, { filename: file });
  }
  return context;
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
