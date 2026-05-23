const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

function notionHeaders() {
  return {
    'Authorization': 'Bearer ' + getConfig('NOTION_TOKEN'),
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json'
  };
}

function createFileUpload(filename, mimeType) {
  const res = UrlFetchApp.fetch(NOTION_API + '/file_uploads', {
    method: 'post',
    headers: notionHeaders(),
    payload: JSON.stringify({ filename: filename, content_type: mimeType }),
    muteHttpExceptions: true
  });
  const data = JSON.parse(res.getContentText());
  if (!data.id) {
    throw new Error('createFileUpload failed: ' + res.getContentText());
  }
  return { id: data.id, uploadUrl: data.upload_url };
}

function sendFileUpload(uploadUrl, blob) {
  const token = getConfig('NOTION_TOKEN');
  const res = UrlFetchApp.fetch(uploadUrl + '/send', {
    method: 'post',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Notion-Version': NOTION_VERSION
    },
    payload: { 'file': blob },  // Blob을 payload에 넣으면 GAS가 자동으로 multipart/form-data 처리
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('sendFileUpload failed (' + res.getResponseCode() + '): ' + res.getContentText());
  }
  return JSON.parse(res.getContentText());
}

function createNotionPage(meta, fileUploadId) {
  // meta: { title, category, sender, dateIso }
  const dbId = getConfig('NOTION_DB_ID');

  const properties = {
    '회의명': {
      title: [{ text: { content: meta.title } }]
    },
    '날짜': {
      date: { start: meta.dateIso }
    },
    '보낸사람': {
      rich_text: [{ text: { content: meta.sender } }]
    },
    '원본파일': {
      files: [{
        type: 'file_upload',
        file_upload: { id: fileUploadId }
      }]
    }
  };

  if (meta.category) {
    properties['카테고리'] = { select: { name: meta.category } };
  }

  const res = UrlFetchApp.fetch(NOTION_API + '/pages', {
    method: 'post',
    headers: notionHeaders(),
    payload: JSON.stringify({
      parent: { database_id: dbId },
      properties: properties
    }),
    muteHttpExceptions: true
  });

  const data = JSON.parse(res.getContentText());
  if (!data.id) {
    throw new Error('createNotionPage failed: ' + res.getContentText());
  }
  return data;
}
