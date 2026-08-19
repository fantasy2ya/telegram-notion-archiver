// Cloudflare Worker — 텔레그램 웹훅 프록시.
//
// 왜 필요한가: Google Apps Script 웹앱은 POST 요청에 무조건 302 리다이렉트를 돌려주는데,
// 텔레그램 웹훅은 302를 실패로 처리한다("Wrong response from the webhook: 302 Found").
// 그래서 GAS에 직접 웹훅을 붙일 수 없다. 이 Worker가 텔레그램의 POST를 받아 즉시 200을
// 돌려주고, update JSON을 GET+쿼리로 GAS에 전달한다(GAS의 302는 GET 쿼리는 보존한다).
//
// 환경변수:
//   GAS_EXEC_URL       (vars)   GAS 웹앱 /exec URL
//   GAS_PROXY_SECRET   (secret) GAS가 ?ptoken= 로 검증하는 공유 시크릿
//   TG_WEBHOOK_SECRET  (secret) 텔레그램 setWebhook secret_token — 헤더로 검증

export default {
  async fetch(request, env, ctx) {
    // 헬스체크/브라우저 GET.
    if (request.method !== 'POST') {
      return json({ ok: true, service: 'tg-notion-webhook' });
    }

    // 텔레그램 → Worker 인증: setWebhook 시 등록한 secret_token 헤더 검증.
    if (env.TG_WEBHOOK_SECRET) {
      const got = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
      if (got !== env.TG_WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
    }

    let body = '';
    try { body = await request.text(); } catch (_) { body = ''; }

    // GAS로 GET+쿼리 전달. 302 리다이렉트가 POST body는 버리지만 GET 쿼리는 보존한다.
    // 회의록 update(문서 메타데이터)는 보통 1~2KB라 URL 길이에 문제없다.
    const url = env.GAS_EXEC_URL +
      '?ptoken=' + encodeURIComponent(env.GAS_PROXY_SECRET) +
      '&update=' + encodeURIComponent(body);

    // 텔레그램에는 즉시 200. GAS 처리(다운로드+Notion 업로드, 수 초)는 백그라운드로 마무리.
    ctx.waitUntil(
      fetch(url, { method: 'GET', redirect: 'follow' }).catch(function () {})
    );

    return json({ ok: true });
  },
};

function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { 'content-type': 'application/json' },
  });
}
