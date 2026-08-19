// 웹훅 모드 제어. 폴링(1분 트리거)과 웹훅은 동시 사용 불가(getUpdates가 409).
// 따라서 웹훅을 켤 때 폴링 트리거를 제거하고, 끌 때 폴링을 복구한다.

var TG_BASE_ = 'https://api.telegram.org';

// 웹훅 켜기: 이 웹앱의 /exec URL로 setWebhook + 폴링 트리거 제거.
// ScriptApp.getService().getUrl()이 배포된 웹앱 URL을 돌려주므로 URL을 하드코딩하지 않는다.
function enableWebhookMode(urlOverride, secretToken) {
  // url은 웹훅을 붙일 대상. Cloudflare Worker 프록시 URL을 넘긴다(GAS 직접 URL은 302로 불가).
  // secretToken을 주면 텔레그램이 X-Telegram-Bot-Api-Secret-Token 헤더로 실어 보내 Worker가 검증한다.
  var url = urlOverride || ScriptApp.getService().getUrl();
  if (!url) {
    throw new Error('웹훅 URL 없음 — Worker URL을 url 파라미터로 전달 필요');
  }
  var token = getConfig('TELEGRAM_TOKEN');
  var api = TG_BASE_ + '/bot' + token + '/setWebhook' +
    '?url=' + encodeURIComponent(url) +
    '&max_connections=5' +
    '&allowed_updates=' + encodeURIComponent('["message","channel_post"]');
  if (secretToken) api += '&secret_token=' + encodeURIComponent(secretToken);
  var res = UrlFetchApp.fetch(api, { muteHttpExceptions: true });
  var data = JSON.parse(res.getContentText());
  if (!data.ok) throw new Error('setWebhook 실패: ' + data.description);

  var removed = [];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction();
    if (f === 'pollUpdates' || f === 'triggerWatchdog') {
      ScriptApp.deleteTrigger(t);
      removed.push(f);
    }
  });

  return { ok: true, mode: 'webhook', webhookUrl: url, triggersRemoved: removed };
}

// 웹훅 끄기: deleteWebhook + 폴링(1분 트리거 + watchdog) 복구.
function disableWebhookMode() {
  var token = getConfig('TELEGRAM_TOKEN');
  var res = UrlFetchApp.fetch(TG_BASE_ + '/bot' + token + '/deleteWebhook', { muteHttpExceptions: true });
  var data = JSON.parse(res.getContentText());
  if (!data.ok) throw new Error('deleteWebhook 실패: ' + data.description);

  installTriggers(); // pollUpdates 1분 + watchdog 1시간 재설치
  return { ok: true, mode: 'polling', triggers: describeTriggers() };
}

// 현재 상태 조회(읽기 전용): 웹훅 등록 여부/대기수/마지막 오류 + 트리거 + offset.
function webhookStatus() {
  var token = getConfig('TELEGRAM_TOKEN');
  var wh = JSON.parse(
    UrlFetchApp.fetch(TG_BASE_ + '/bot' + token + '/getWebhookInfo', { muteHttpExceptions: true }).getContentText()
  );
  return {
    ok: true,
    webhook: wh.result,
    triggers: ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }),
    offset: PropertiesService.getScriptProperties().getProperty('TG_OFFSET'),
    webAppUrl: ScriptApp.getService().getUrl()
  };
}
