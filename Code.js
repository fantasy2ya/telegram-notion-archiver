function pollUpdates() {
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
  if (updates.length === 0) return;

  updates.forEach(function(update) {
    const msg = update.message || update.channel_post;
    if (msg && msg.document) {
      try {
        processMessage(msg);
      } catch (err) {
        sendAdminError('❌ update ' + update.update_id + ' 처리 실패: ' + err.message);
      }
    }
  });

  const lastId = updates[updates.length - 1].update_id;
  props.setProperty('TG_OFFSET', String(lastId + 1));
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
    return;
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
    return;
  }

  try {
    const upload = createFileUpload(filename, mimeType);
    sendFileUpload(upload.id, blob);
    createNotionPage({ title, category, sender, dateIso, caption }, upload.id);
  } catch (err) {
    console.error('Notion FAIL:', err.message);
    notifyFailure(chatId, msgId, '❌ Notion 업로드 실패: ' + err.message);
    return;
  }

  try {
    sendReaction(chatId, msgId);
  } catch (err) {
    sendAdminError('⚠️ 리액션 추가 실패 (Notion 저장은 완료됨): ' + err.message);
  }
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
