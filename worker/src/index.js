// Cloudflare Worker — Telegram webhook to GAS reliability proxy.

export function createWorker(fetchImpl) {
  return {
    async fetch(request, env) {
      if (request.method !== 'POST') {
        return json({ ok: true, service: 'tg-notion-webhook' });
      }

      if (!env.GAS_EXEC_URL || !env.GAS_PROXY_SECRET || !env.TG_WEBHOOK_SECRET) {
        return json({ ok: false, error: 'worker configuration missing' }, 500);
      }

      const got = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
      if (got !== env.TG_WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }

      let update;
      try {
        update = await request.json();
      } catch (_) {
        return json({ ok: false, error: 'invalid json' }, 400);
      }

      if (!Number.isSafeInteger(update && update.update_id)) {
        return json({ ok: false, error: 'missing update_id' }, 400);
      }

      const url = env.GAS_EXEC_URL +
        '?ptoken=' + encodeURIComponent(env.GAS_PROXY_SECRET) +
        '&update=' + encodeURIComponent(JSON.stringify(update));

      try {
        const gasResponse = await fetchImpl(url, { method: 'GET', redirect: 'follow' });
        if (!gasResponse.ok) {
          console.error('GAS delivery HTTP failure', { updateId: update.update_id, status: gasResponse.status });
          return json({ ok: false, retry: true }, 503);
        }

        const result = await gasResponse.json();
        if (!result || result.ok !== true || result.retry === true) {
          console.error('GAS requested retry', {
            updateId: update.update_id,
            reason: result && result.reason ? result.reason : 'invalid_response',
          });
          return json({ ok: false, retry: true }, 503);
        }

        console.log('Telegram update terminal', { updateId: update.update_id, status: result.status || 'processed' });
        return json({ ok: true, status: result.status || 'processed' });
      } catch (error) {
        console.error('GAS delivery exception', {
          updateId: update.update_id,
          message: error instanceof Error ? error.message : String(error),
        });
        return json({ ok: false, retry: true }, 503);
      }
    },
  };
}

export default createWorker(fetch);

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
