const TELEGRAM_BASE = 'https://api.telegram.org';
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50MB

function downloadTelegramFile(fileId) {
  const token = getConfig('TELEGRAM_TOKEN');

  // 1단계: getFile로 file_path 획득
  const getFileRes = UrlFetchApp.fetch(
    TELEGRAM_BASE + '/bot' + token + '/getFile?file_id=' + fileId,
    { muteHttpExceptions: true }
  );
  const getFileData = JSON.parse(getFileRes.getContentText());
  if (!getFileData.ok) {
    throw new Error('getFile failed: ' + getFileData.description);
  }

  const file = getFileData.result;
  if (file.file_size && file.file_size > MAX_FILE_BYTES) {
    throw new Error('FILE_TOO_LARGE:' + file.file_name);
  }

  // 2단계: 파일 바이트 다운로드
  const fileUrl = TELEGRAM_BASE + '/file/bot' + token + '/' + file.file_path;
  const fileRes = UrlFetchApp.fetch(fileUrl, { muteHttpExceptions: true });
  return fileRes.getBlob();
}

function sendReaction(chatId, messageId) {
  const token = getConfig('TELEGRAM_TOKEN');
  UrlFetchApp.fetch(
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
}

function sendAdminError(text) {
  try {
    const token = getConfig('TELEGRAM_TOKEN');
    const adminChatId = getConfig('ADMIN_CHAT_ID');
    UrlFetchApp.fetch(
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
  } catch (e) {
    console.error('sendAdminError itself failed:', e.message);
  }
}
