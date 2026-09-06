// === 웹훅 진입점 (폴링 대체) ================================================
// Telegram이 업데이트를 이 웹앱으로 POST한다. 트리거 런타임을 전혀 쓰지 않으므로
// 무료 GAS 90분/일 트리거 쿼터 문제를 근본적으로 회피한다.
// 웹앱은 반드시 access=ANYONE_ANONYMOUS로 배포되어야 함(텔레그램은 구글 미로그인).
// 하나의 텔레그램 update를 처리한다. doPost(직접 POST)와 doGet(프록시 GET+쿼리) 공용.
function handleUpdateCore_(update, deps) {
  if (!update || !Number.isSafeInteger(update.update_id)) {
    return { ok: true, status: 'skipped', reason: 'invalid_update' };
  }

  if (deps.isCompleted(update.update_id)) {
    return { ok: true, status: 'duplicate' };
  }

  var msg = update.message || update.channel_post;
  var outcome = msg && msg.document
    ? deps.processMessage(msg, update)
    : { status: 'skipped', reason: 'not_document' };

  if (!outcome || outcome.status === 'retry') {
    return {
      ok: false,
      retry: true,
      status: 'retry',
      reason: outcome && outcome.reason ? outcome.reason : 'unknown_failure'
    };
  }

  if (outcome.status !== 'processed' && outcome.status !== 'skipped') {
    return { ok: false, retry: true, status: 'retry', reason: 'invalid_outcome' };
  }

  deps.markCompleted(update.update_id);
  return { ok: true, status: outcome.status, reason: outcome.reason || '' };
}

function handleUpdate_(update) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    return { ok: false, retry: true, status: 'retry', reason: 'busy' };
  }

  try {
    var cache = CacheService.getScriptCache();
    return handleUpdateCore_(update, {
      isCompleted: function (updateId) {
        return !!cache.get('tgupd_' + updateId);
      },
      markCompleted: function (updateId) {
        cache.put('tgupd_' + updateId, '1', 21600);
      },
      processMessage: processMessage
    });
  } finally {
    lock.releaseLock();
  }
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonOutput_({ ok: true, status: 'skipped', reason: 'empty_body' });
    }
    var payload = JSON.parse(e.postData.contents);
    if (payload && payload._admin) {
      return jsonOutput_(handleAdminRequest_(payload._admin));
    }
    return jsonOutput_(handleUpdate_(payload));
  } catch (err) {
    console.error('doPost error:', err && err.message);
    try { sendAdminError('❌ doPost 오류: ' + (err && err.message)); } catch (e2) {}
    return jsonOutput_({ ok: false, retry: true, status: 'retry', reason: 'doPost_error' });
  }
}

function secureEquals_(left, right) {
  var a = String(left || '');
  var b = String(right || '');
  var mismatch = a.length ^ b.length;
  var length = Math.max(a.length, b.length);
  for (var i = 0; i < length; i += 1) {
    mismatch |= (a.charCodeAt(i % (a.length || 1)) || 0) ^
      (b.charCodeAt(i % (b.length || 1)) || 0);
  }
  return mismatch === 0 && a.length > 0;
}

function getProxySharedSecret_() {
  return getConfig('GAS_PROXY_SECRET');
}

function isAdminAuthorized_(key) {
  var expected = PropertiesService.getScriptProperties().getProperty('WEBHOOK_ADMIN_KEY');
  return secureEquals_(key, expected);
}

function handleAdminRequest_(request) {
  request = request || {};
  if (!isAdminAuthorized_(request.key)) {
    return { ok: false, error: 'unauthorized' };
  }

  var action = request.action;
  if (action === 'status') return webhookStatus();
  if (action === 'disable') return disableWebhookMode();
  if (action === 'enable') {
    var props = PropertiesService.getScriptProperties();
    var workerUrl = request.url || props.getProperty('WORKER_WEBHOOK_URL');
    var telegramSecret = request.telegramSecret || props.getProperty('TG_WEBHOOK_SECRET');
    return enableWebhookMode(workerUrl, telegramSecret);
  }
  if (action === 'configure') {
    var allowed = ['WEBHOOK_ADMIN_KEY', 'GAS_PROXY_SECRET', 'TG_WEBHOOK_SECRET', 'WORKER_WEBHOOK_URL'];
    var incoming = request.properties || {};
    var updates = {};
    allowed.forEach(function(name) {
      var value = String(incoming[name] || '').trim();
      if (value) updates[name] = value;
    });
    if (updates.WORKER_WEBHOOK_URL) validateWebhookUrl_(updates.WORKER_WEBHOOK_URL);
    if (!Object.keys(updates).length) throw new Error('설정할 값이 없습니다.');
    PropertiesService.getScriptProperties().setProperties(updates, false);
    return { ok: true, configured: Object.keys(updates).sort() };
  }
  return { ok: false, error: 'unknown action: ' + action };
}

function doGet(e) {
  var p = (e && e.parameter) || {};

  // Cloudflare Worker 프록시가 GET+쿼리로 넘긴 텔레그램 update 처리.
  // (GAS 웹앱은 POST에 302를 돌려줘 텔레그램이 직접 못 붙으므로 Worker가 GET으로 우회 전달)
  if (p.update) {
    try {
      if (!secureEquals_(p.ptoken, getProxySharedSecret_())) {
        return jsonOutput_({ ok: false, error: 'bad proxy token' });
      }
      return jsonOutput_(handleUpdate_(JSON.parse(p.update)));
    } catch (err) {
      console.error('proxy update 처리 오류:', err && err.message);
      try { sendAdminError('❌ proxy update 오류: ' + (err && err.message)); } catch (e2) {}
      return jsonOutput_({ ok: false, error: String(err && err.message) });
    }
  }

  return jsonOutput_({ ok: true, service: 'telegram-notion-archiver' });
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// 트리거가 호출하는 엔트리. 절대 uncaught 예외를 던지지 않는다 —
// GAS는 트리거 실행이 반복 실패하면 트리거를 자동 정지/비활성화하므로,
// 어떤 오류도 여기서 삼켜(로그+관리자 DM) 트리거 수명을 보호한다.
// (웹훅 모드에서는 이 트리거가 제거되며, 폴링 복구용으로만 남겨둔다.)
function pollUpdates() {
  try {
    pollUpdatesOnce();
  } catch (err) {
    console.error('pollUpdates fatal (삼킴):', err && err.message);
    try { sendAdminError('❌ pollUpdates 치명적 오류(트리거 보호용으로 삼킴): ' + (err && err.message)); } catch (e) {}
  }
}

function pollUpdatesOnce() {
  const token = getConfig('TELEGRAM_TOKEN');
  const props = PropertiesService.getScriptProperties();
  const offset = Number(props.getProperty('TG_OFFSET') || '0');

  const res = UrlFetchApp.fetch(
    'https://api.telegram.org/bot' + token +
    '/getUpdates?offset=' + offset + '&limit=100&timeout=0',
    { muteHttpExceptions: true }
  );
  const data = JSON.parse(res.getContentText());
  if (!data.ok) {
    console.error('getUpdates failed:', data.description);
    return;
  }

  const updates = data.result;
  if (updates.length === 0) return { ok: true, processed: 0 };

  return processPollingBatch_(updates, {
    processUpdate: handleUpdate_,
    commitOffset: function (nextOffset) {
      props.setProperty('TG_OFFSET', String(nextOffset));
    }
  });
}

function processPollingBatch_(updates, deps) {
  var processed = 0;
  for (var i = 0; i < updates.length; i++) {
    var update = updates[i];
    var result = deps.processUpdate(update);
    if (!result || result.retry === true || result.ok !== true) {
      return {
        ok: false,
        retry: true,
        status: 'retry',
        failedUpdateId: update.update_id,
        processed: processed
      };
    }
    deps.commitOffset(update.update_id + 1);
    processed++;
  }
  return { ok: true, processed: processed };
}

// === 트리거 자가복구 ==========================================================
// 최초 1회 GAS 편집기에서 installTriggers() 실행 → 1분 폴링 + 일일 watchdog 설치.
function installTriggers() {
  ensurePollTrigger();
  ensureWatchdogTrigger();
  console.log('✅ 트리거 설치 완료: ' + describeTriggers());
}

// pollUpdates용 1분 CLOCK 트리거가 정확히 1개 있도록 보장(없으면 생성, 중복이면 정리).
function ensurePollTrigger() {
  var existing = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'pollUpdates';
  });
  if (existing.length === 0) {
    ScriptApp.newTrigger('pollUpdates').timeBased().everyMinutes(1).create();
    console.log('🔧 pollUpdates 1분 트리거 생성');
    return;
  }
  // 중복 제거(1개만 유지) — 누적 시 쿼터/오류 위험.
  for (var i = 1; i < existing.length; i++) ScriptApp.deleteTrigger(existing[i]);
}

// pollUpdates 트리거가 사라져도 되살리는 감시 트리거. 거의 아무 일도 안 하므로
// 자체 오류가 쌓이지 않아 살아남고, 1분 트리거를 재생성한다.
function ensureWatchdogTrigger() {
  var has = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'triggerWatchdog';
  });
  if (!has) {
    ScriptApp.newTrigger('triggerWatchdog').timeBased().everyHours(1).create();
    console.log('🔧 watchdog 1시간 트리거 생성');
  }
}

function triggerWatchdog() {
  try {
    ensurePollTrigger();
  } catch (err) {
    console.error('watchdog 실패:', err && err.message);
  }
}

function describeTriggers() {
  return ScriptApp.getProjectTriggers().map(function (t) {
    return t.getHandlerFunction();
  }).join(', ') || '(none)';
}

function processMessage(msg) {
  const doc      = msg.document;
  const chatId   = msg.chat.id;
  const msgId    = msg.message_id;
  const caption  = msg.caption || '';
  const sender   = buildSender(msg.from || msg.forward_from);
  const dateIso  = new Date(msg.date * 1000).toISOString().split('T')[0];
  const filename = doc.file_name || 'untitled';
  const mimeType = doc.mime_type || 'application/octet-stream';

  const isForwarded = !!(msg.forward_origin || msg.forward_from || msg.forward_from_chat);
  const parsed   = parseCaption(caption);
  const title    = filename;
  const forwardChatTitle = buildForwardChatTitle(msg);
  const category = isForwarded ? detectForwardedCategory(buildForwardText(msg, caption), forwardChatTitle) : parsed.category;

  // Notion 무료 플랜 5MB 한도 사전 차단 — 다운로드/업로드 헛수고 없이 명확히 거부.
  const fileSize = doc.file_size || 0;
  if (fileSize > NOTION_MAX_FILE_BYTES) {
    const mb = (fileSize / 1024 / 1024).toFixed(2);
    console.error('SIZE LIMIT:', filename, mb + 'MB');
    notifyFailure(chatId, msgId, '❌ Notion 무료 플랜 5MB 초과로 업로드 불가 (' + mb + 'MB): ' + filename);
    return { status: 'skipped', reason: 'notion_size_limit' };
  }

  let blob;
  try {
    blob = downloadTelegramFile(doc.file_id);
    blob = blob.setName(filename).setContentType(mimeType);
  } catch (err) {
    console.error('Download FAIL:', err.message);
    const msgText = err.message.startsWith('FILE_TOO_LARGE:')
      ? '❌ 파일이 너무 큽니다: ' + err.message.replace('FILE_TOO_LARGE:', '')
      : '❌ Telegram 파일 다운로드 실패: ' + err.message;
    notifyFailure(chatId, msgId, msgText);
    return failureOutcome_('telegram_download_failed', err);
  }

  try {
    const upload = createFileUpload(filename, mimeType);
    sendFileUpload(upload.id, blob);
    createNotionPage({ title, category, sender, dateIso, caption }, upload.id);
  } catch (err) {
    console.error('Notion FAIL:', err.message);
    notifyFailure(chatId, msgId, '❌ Notion 업로드 실패: ' + err.message);
    return failureOutcome_('notion_upload_failed', err);
  }

  try {
    sendReaction(chatId, msgId);
  } catch (err) {
    sendAdminError('⚠️ 리액션 추가 실패 (Notion 저장은 완료됨): ' + err.message);
  }
  return { status: 'processed' };
}

function failureOutcome_(reason, error) {
  if (isRetryableError_(error)) {
    return { status: 'retry', reason: reason };
  }
  return { status: 'skipped', reason: reason + '_permanent' };
}

function buildSender(from) {
  if (!from) return '알 수 없음';
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ');
  return name || from.username || '알 수 없음';
}

// 실패 알림: 👎 리액션 + 관리자 DM 시도. DM이 막히면(미설정/未 /start 등)
// 파일을 보낸 그 채팅에 답글로 fallback 하여 사용자가 반드시 사유를 보게 한다.
function notifyFailure(chatId, msgId, text) {
  sendThumbsDown(chatId, msgId);
  const dmOk = sendAdminError(text);
  if (!dmOk) {
    console.warn('관리자 DM 실패 → 원본 채팅에 답글로 알림');
    sendChatMessage(chatId, text, msgId);
  }
}

function buildForwardChatTitle(msg) {
  if (msg.forward_from_chat) return msg.forward_from_chat.title || '';
  var o = msg.forward_origin;
  if (o) {
    if (o.chat)        return o.chat.title || '';
    if (o.sender_chat) return o.sender_chat.title || '';
  }
  return '';
}

function buildForwardText(msg, caption) {
  var parts = [caption];
  if (msg.forward_from_chat) parts.push(msg.forward_from_chat.title || '');
  if (msg.forward_from) {
    parts.push([msg.forward_from.first_name, msg.forward_from.last_name].filter(Boolean).join(' '));
  }
  var o = msg.forward_origin;
  if (o) {
    if (o.chat)        parts.push(o.chat.title || '');
    if (o.sender_chat) parts.push(o.sender_chat.title || '');
    if (o.sender_user) {
      parts.push([o.sender_user.first_name, o.sender_user.last_name].filter(Boolean).join(' '));
    }
  }
  return parts.join(' ');
}

function detectForwardedCategory(text, chatTitle) {
  if (chatTitle === '디지털에셋사업팀') return '자산운용';
  if (text.indexOf('자산운용') !== -1) return '자산운용';
  if (text.indexOf('증권') !== -1)    return '투자증권';
  return '';
}
