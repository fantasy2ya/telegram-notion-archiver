// 웹훅 모드 제어. 폴링(1분 트리거)과 웹훅은 동시 사용 불가(getUpdates가 409).
// 따라서 웹훅을 켤 때 폴링 트리거를 제거하고, 끌 때 폴링을 복구한다.

var TG_BASE_ = 'https://api.telegram.org';

function validateWebhookUrl_(url) {
  var normalized = String(url || '').trim().replace(/\/+$/, '');
  if (!normalized) {
    throw new Error('Worker 웹훅 URL이 필요합니다.');
  }
  var match = normalized.match(/^https:\/\/([^\/?#]+)(?:[\/?#]|$)/i);
  if (!match) {
    throw new Error('웹훅 URL은 HTTPS여야 합니다.');
  }
  var hostname = match[1].split(':')[0].toLowerCase();
  if (hostname === 'script.google.com' || /\.script\.google\.com$/.test(hostname)) {
    throw new Error('GAS URL은 Telegram 웹훅으로 등록할 수 없습니다. Worker URL을 사용하세요.');
  }
  return normalized;
}

function parseTelegramResponse_(response, operation) {
  var status = response.getResponseCode();
  var text = response.getContentText();
  var data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw makeApiError_('Telegram ' + operation, status, text, getResponseHeader_(response, 'Retry-After'));
  }
  if (status < 200 || status >= 300 || !data.ok) {
    throw makeApiError_(
      'Telegram ' + operation,
      status,
      data.description || text,
      getResponseHeader_(response, 'Retry-After')
    );
  }
  return data;
}

// 웹훅 켜기: 검증된 Worker URL로 setWebhook한 뒤 Telegram 상태를 재확인한다.
function enableWebhookMode(urlOverride, secretToken) {
  var url = validateWebhookUrl_(urlOverride);
  if (!secretToken) throw new Error('Telegram webhook secret이 필요합니다.');

  var token = getConfig('TELEGRAM_TOKEN');
  var res = UrlFetchApp.fetch(TG_BASE_ + '/bot' + token + '/setWebhook', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      url: url,
      secret_token: secretToken,
      max_connections: 1,
      allowed_updates: ['message', 'channel_post']
    }),
    muteHttpExceptions: true
  });
  parseTelegramResponse_(res, 'setWebhook');

  var infoRes = UrlFetchApp.fetch(TG_BASE_ + '/bot' + token + '/getWebhookInfo', {
    muteHttpExceptions: true
  });
  var info = parseTelegramResponse_(infoRes, 'getWebhookInfo').result || {};
  if (info.url !== url) {
    throw new Error('Telegram 웹훅 검증 실패: 등록 URL이 요청 URL과 다릅니다.');
  }

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
  parseTelegramResponse_(res, 'deleteWebhook');

  installTriggers(); // pollUpdates 1분 + watchdog 1시간 재설치
  return { ok: true, mode: 'polling', triggers: describeTriggers() };
}

// 현재 상태 조회(읽기 전용): 웹훅 등록 여부/대기수/마지막 오류 + 트리거 + offset.
function webhookStatus() {
  var token = getConfig('TELEGRAM_TOKEN');
  var wh = parseTelegramResponse_(
    UrlFetchApp.fetch(TG_BASE_ + '/bot' + token + '/getWebhookInfo', { muteHttpExceptions: true }),
    'getWebhookInfo'
  );
  return {
    ok: true,
    webhook: wh.result,
    triggers: ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }),
    offset: PropertiesService.getScriptProperties().getProperty('TG_OFFSET'),
    webAppUrl: ScriptApp.getService().getUrl()
  };
}
