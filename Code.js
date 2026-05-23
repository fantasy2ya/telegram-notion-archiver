function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const msg = body.message || body.channel_post;

    // document 없는 메시지(텍스트만, 사진 등)는 조용히 무시
    if (!msg || !msg.document) {
      return ContentService.createTextOutput('ok');
    }

    const doc      = msg.document;
    const chatId   = msg.chat.id;
    const msgId    = msg.message_id;
    const caption  = msg.caption || '';
    const sender   = buildSender(msg.from);
    const dateIso  = new Date(msg.date * 1000).toISOString().split('T')[0];
    const filename = doc.file_name || 'untitled';
    const mimeType = doc.mime_type || 'application/octet-stream';

    const parsed   = parseCaption(caption);
    const title    = parsed.title || filename;
    const category = parsed.category;

    // Telegram 파일 다운로드
    let blob;
    try {
      blob = downloadTelegramFile(doc.file_id);
      blob = blob.setName(filename).setContentType(mimeType);
    } catch (err) {
      if (err.message.startsWith('FILE_TOO_LARGE:')) {
        sendAdminError('❌ 파일이 너무 큽니다 (50MB 제한): ' + err.message.replace('FILE_TOO_LARGE:', ''));
      } else {
        sendAdminError('❌ Telegram 파일 다운로드 실패: ' + err.message);
      }
      return ContentService.createTextOutput('ok');
    }

    // Notion 업로드
    try {
      const upload = createFileUpload(filename, mimeType);
      sendFileUpload(upload.uploadUrl, blob);
      createNotionPage({ title, category, sender, dateIso }, upload.id);
    } catch (err) {
      sendAdminError('❌ Notion 업로드 실패: ' + err.message);
      return ContentService.createTextOutput('ok');
    }

    // 성공 👍 리액션 (실패해도 Notion 저장은 완료됐으므로 admin에게 경고만)
    try {
      sendReaction(chatId, msgId);
    } catch (err) {
      sendAdminError('⚠️ 리액션 추가 실패 (Notion 저장은 완료됨): ' + err.message);
    }

  } catch (err) {
    sendAdminError('❌ 알 수 없는 오류: ' + err.message);
  }

  return ContentService.createTextOutput('ok');
}

function buildSender(from) {
  if (!from) return '알 수 없음';
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ');
  return name || from.username || '알 수 없음';
}
