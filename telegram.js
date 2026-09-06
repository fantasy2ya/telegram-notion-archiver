const TELEGRAM_BASE = 'https://api.telegram.org';
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50MB

function parseTelegramApiResponse_(response, operation) {
  const status = response.getResponseCode();
  const text = response.getContentText();
  let data;
  try {
    data = JSON.parse(text);
  } catch (parseError) {
    const error = makeApiError_('Telegram ' + operation, status, text, getResponseHeader_(response, 'Retry-After'));
    if (status >= 200 && status < 300) error.retryable = true;
    throw error;
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

function downloadTelegramFile(fileId) {
  const token = getConfig('TELEGRAM_TOKEN');

  // 1단계: getFile로 file_path 획득
  const getFileRes = UrlFetchApp.fetch(
    TELEGRAM_BASE + '/bot' + token + '/getFile?file_id=' + fileId,
    { muteHttpExceptions: true }
  );
  const getFileData = parseTelegramApiResponse_(getFileRes, 'getFile');

  const file = getFileData.result;
  if (file.file_size && file.file_size > MAX_FILE_BYTES) {
    const error = new Error('FILE_TOO_LARGE:' + file.file_name);
    error.status = 413;
    error.retryable = false;
    throw error;
  }

  // 2단계: 파일 바이트 다운로드
  const fileUrl = TELEGRAM_BASE + '/file/bot' + token + '/' + file.file_path;
  const fileRes = UrlFetchApp.fetch(fileUrl, { muteHttpExceptions: true });
  if (fileRes.getResponseCode() !== 200) {
    throw makeApiError_(
      'Telegram file download',
      fileRes.getResponseCode(),
      fileRes.getContentText(),
      getResponseHeader_(fileRes, 'Retry-After')
    );
  }
  return fileRes.getBlob();
}

function sendReaction(chatId, messageId) {
  const token = getConfig('TELEGRAM_TOKEN');
  const res = UrlFetchApp.fetch(
    TELEGRAM_BASE + '/bot' + token + '/setMessageReaction',
    {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: 'emoji', emoji: '👍' }]
      }),
      muteHttpExceptions: true
    }
  );
  parseTelegramApiResponse_(res, 'setMessageReaction');
}

function sendThumbsDown(chatId, messageId) {
  try {
    const token = getConfig('TELEGRAM_TOKEN');
    UrlFetchApp.fetch(
      TELEGRAM_BASE + '/bot' + token + '/setMessageReaction',
      {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          reaction: [{ type: 'emoji', emoji: '👎' }]
        }),
        muteHttpExceptions: true
      }
    );
  } catch (e) {
    console.error('sendThumbsDown failed:', e.message);
  }
}

// 관리자 DM 전송. 성공 true / 실패 false 반환 + 실패 사유 로깅.
function sendAdminError(text) {
  try {
    const token = getConfig('TELEGRAM_TOKEN');
    const adminChatId = getConfig('ADMIN_CHAT_ID');
    const res = UrlFetchApp.fetch(
      TELEGRAM_BASE + '/bot' + token + '/sendMessage',
      {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({
          chat_id: adminChatId,
          text: text
        }),
        muteHttpExceptions: true
      }
    );
    const data = JSON.parse(res.getContentText());
    if (!data.ok) {
      console.error('sendAdminError failed (Telegram ' + data.error_code + '):', data.description);
      return false;
    }
    return true;
  } catch (e) {
    console.error('sendAdminError itself failed:', e.message);
    return false;
  }
}

// 특정 채팅에 메시지 전송(선택적으로 답글). DM이 막힐 때의 fallback 경로.
function sendChatMessage(chatId, text, replyToMsgId) {
  try {
    const token = getConfig('TELEGRAM_TOKEN');
    const payload = { chat_id: chatId, text: text };
    if (replyToMsgId) payload.reply_to_message_id = replyToMsgId;
    const res = UrlFetchApp.fetch(
      TELEGRAM_BASE + '/bot' + token + '/sendMessage',
      {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      }
    );
    const data = JSON.parse(res.getContentText());
    if (!data.ok) {
      console.error('sendChatMessage failed (Telegram ' + data.error_code + '):', data.description);
      return false;
    }
    return true;
  } catch (e) {
    console.error('sendChatMessage failed:', e.message);
    return false;
  }
}
