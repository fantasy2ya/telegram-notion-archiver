// 대기 중인 업데이트의 처리 파이프라인을 한 단계씩 재현하며 전부 로깅한다.
// offset은 건드리지 않음. 성공하면 밀린 파일이 실제로 Notion에 올라간다.
function diagReplay() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('TELEGRAM_TOKEN');
  var offset = Number(props.getProperty('TG_OFFSET') || '0');

  var res = UrlFetchApp.fetch(
    'https://api.telegram.org/bot' + token +
    '/getUpdates?offset=' + offset + '&limit=1&timeout=0',
    { muteHttpExceptions: true });
  var data = JSON.parse(res.getContentText());
  console.log('STEP getUpdates: ok=' + data.ok + ' count=' + (data.result ? data.result.length : 'n/a'));
  if (!data.result || !data.result.length) { console.log('대기 업데이트 없음 — 종료'); return; }

  var update = data.result[0];
  var msg = update.message || update.channel_post;
  console.log('UPDATE update_id=' + update.update_id + ' hasMsg=' + !!msg + ' hasDoc=' + !!(msg && msg.document));
  if (!msg || !msg.document) { console.log('문서 없음 — pollUpdates도 이 업데이트는 스킵함'); return; }

  var doc = msg.document;
  console.log('DOC name=' + doc.file_name + ' size=' + doc.file_size + ' mime=' + doc.mime_type);

  var fileSize = doc.file_size || 0;
  if (fileSize > NOTION_MAX_FILE_BYTES) {
    console.log('→ SIZE 차단됨 (' + (fileSize/1024/1024).toFixed(2) + 'MB > 5MB). 정상 return 경로.');
    return;
  }

  var blob;
  try {
    blob = downloadTelegramFile(doc.file_id).setName(doc.file_name).setContentType(doc.mime_type || 'application/octet-stream');
    console.log('STEP download OK bytes=' + blob.getBytes().length);
  } catch (e) { console.error('STEP download THREW: ' + e.message); return; }

  var upload;
  try {
    upload = createFileUpload(doc.file_name, doc.mime_type || 'application/octet-stream');
    console.log('STEP createFileUpload OK id=' + upload.id);
  } catch (e) { console.error('STEP createFileUpload THREW: ' + e.message); return; }

  try {
    sendFileUpload(upload.id, blob);
    console.log('STEP sendFileUpload OK');
  } catch (e) { console.error('STEP sendFileUpload THREW: ' + e.message); return; }

  try {
    var page = createNotionPage({
      title: doc.file_name, category: '', sender: buildSender(msg.from || msg.forward_from),
      dateIso: new Date(msg.date * 1000).toISOString().split('T')[0], caption: msg.caption || ''
    }, upload.id);
    console.log('STEP createNotionPage OK page_id=' + page.id);
    console.log('✅ 전체 파이프라인 성공 — Notion에 페이지 생성됨');
  } catch (e) { console.error('STEP createNotionPage THREW: ' + e.message); return; }
}

// 진단 전용. GAS 편집기에서 diagnose() 실행 → 실행 로그를 복사해 공유.
// 이 함수는 라이브 상태만 읽고 아무것도 바꾸지 않는다(읽기 전용).
function diagnose() {
  var props = PropertiesService.getScriptProperties();

  // 1) 설정값 존재 여부 (값 자체는 노출하지 않음)
  ['TELEGRAM_TOKEN', 'NOTION_TOKEN', 'NOTION_DB_ID', 'ADMIN_CHAT_ID'].forEach(function (k) {
    var v = props.getProperty(k);
    console.log('CONFIG ' + k + ': ' + (v ? 'SET(len=' + v.length + ')' : 'MISSING'));
  });
  console.log('TG_OFFSET: ' + props.getProperty('TG_OFFSET'));

  // 2) 트리거 살아있는지 — pollUpdates 시간 트리거가 있어야 자동 폴링됨
  var triggers = ScriptApp.getProjectTriggers();
  console.log('TRIGGER COUNT: ' + triggers.length);
  triggers.forEach(function (t) {
    console.log('  TRIGGER handler=' + t.getHandlerFunction() +
      ' type=' + t.getEventType() + ' source=' + t.getTriggerSource());
  });

  var token = props.getProperty('TELEGRAM_TOKEN');
  if (!token) { console.error('토큰 없음 — 여기서 중단'); return; }

  // 3) 웹훅 충돌 여부 — url이 비어있어야 폴링 정상. 차있으면 getUpdates가 409로 실패함.
  try {
    var wh = JSON.parse(UrlFetchApp.fetch(
      'https://api.telegram.org/bot' + token + '/getWebhookInfo',
      { muteHttpExceptions: true }).getContentText());
    console.log('WEBHOOK url="' + (wh.result && wh.result.url) + '"' +
      ' pending=' + (wh.result && wh.result.pending_update_count) +
      ' last_error=' + (wh.result && wh.result.last_error_message));
  } catch (e) { console.error('getWebhookInfo 실패: ' + e.message); }

  // 4) 실제 getUpdates 호출 (offset 변경 없이 그대로 읽기만)
  var offset = Number(props.getProperty('TG_OFFSET') || '0');
  try {
    var res = UrlFetchApp.fetch(
      'https://api.telegram.org/bot' + token +
      '/getUpdates?offset=' + offset + '&limit=100&timeout=0',
      { muteHttpExceptions: true });
    var data = JSON.parse(res.getContentText());
    console.log('getUpdates ok=' + data.ok +
      ' code=' + res.getResponseCode() +
      ' desc=' + data.description +
      ' count=' + (data.result ? data.result.length : 'n/a'));
    if (data.result && data.result.length) {
      var first = data.result[0];
      var m = first.message || first.channel_post;
      console.log('  첫 업데이트 update_id=' + first.update_id +
        ' hasDocument=' + !!(m && m.document) +
        ' fileName=' + (m && m.document && m.document.file_name));
    }
  } catch (e) { console.error('getUpdates 실패: ' + e.message); }
}
