const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

// Notion 무료 플랜 파일 업로드 한도 (파일당 5 MiB). 초과 시 페이지 생성이 거부됨.
const NOTION_MAX_FILE_BYTES = 5 * 1024 * 1024;

function notionHeaders() {
  return {
    'Authorization': 'Bearer ' + getConfig('NOTION_TOKEN'),
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json'
  };
}

function parseNotionResponse_(response, operation) {
  const status = response.getResponseCode();
  const text = response.getContentText();
  let data;
  try {
    data = JSON.parse(text);
  } catch (parseError) {
    const error = makeApiError_('Notion ' + operation, status, text, getResponseHeader_(response, 'Retry-After'));
    if (status >= 200 && status < 300) error.retryable = true;
    throw error;
  }
  if (status < 200 || status >= 300 || data.object === 'error') {
    throw makeApiError_(
      'Notion ' + operation,
      status,
      data.message || text,
      getResponseHeader_(response, 'Retry-After')
    );
  }
  return data;
}

function createFileUpload(filename, mimeType) {
  const res = UrlFetchApp.fetch(NOTION_API + '/file_uploads', {
    method: 'post',
    headers: notionHeaders(),
    payload: JSON.stringify({ filename: filename, content_type: mimeType }),
    muteHttpExceptions: true
  });
  const data = parseNotionResponse_(res, 'createFileUpload');
  if (!data.id) throw makeApiError_('Notion createFileUpload', 0, 'missing upload id');
  return { id: data.id, uploadUrl: data.upload_url };
}

function sendFileUpload(fileUploadId, blob) {
  const sendUrl = NOTION_API + '/file_uploads/' + fileUploadId + '/send';
  const headers = notionHeaders();
  delete headers['Content-Type'];
  const res = UrlFetchApp.fetch(sendUrl, {
    method: 'post',
    headers: headers,
    payload: { 'file': blob },
    muteHttpExceptions: true
  });
  return parseNotionResponse_(res, 'sendFileUpload');
}

// DB의 실제 속성명→타입 맵을 반환. 존재하지 않는 속성에 쓰면 Notion이
// 페이지 생성 전체를 거부하므로, 전송 전 필터링에 사용한다.
function getNotionDbProperties(dbId) {
  const res = UrlFetchApp.fetch(NOTION_API + '/databases/' + dbId, {
    method: 'get',
    headers: notionHeaders(),
    muteHttpExceptions: true
  });
  const data = parseNotionResponse_(res, 'getNotionDbProperties');
  if (!data.properties) throw makeApiError_('Notion getNotionDbProperties', 0, 'missing properties');
  const map = {};
  Object.keys(data.properties).forEach(function(name) {
    map[name] = data.properties[name].type;
  });
  return map;
}

function createNotionPage(meta, fileUploadId) {
  // meta: { title, category, sender, dateIso, caption }
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

  const category = sanitizeSelectName(meta.category);
  if (category) {
    properties['카테고리'] = { select: { name: category } };
  }

  if (meta.caption) {
    properties['캡션'] = {
      rich_text: [{ text: { content: meta.caption.slice(0, 2000) } }]
    };
  }

  // DB에 실제로 존재하는 속성만 남긴다 (캡션/카테고리 컬럼이 없어도 업로드 보존).
  // 스키마 조회 실패 시에는 기존 동작대로 전부 전송 (가용성 우선).
  try {
    const dbProps = getNotionDbProperties(dbId);
    Object.keys(properties).forEach(function(name) {
      if (!(name in dbProps)) {
        delete properties[name];
        console.warn('Notion DB에 없는 속성 스킵: ' + name);
      }
    });
  } catch (e) {
    console.warn('DB 스키마 조회 실패, 전체 속성 전송 fallback: ' + e.message);
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

  const data = parseNotionResponse_(res, 'createNotionPage');
  if (!data.id) throw makeApiError_('Notion createNotionPage', 0, 'missing page id');
  return data;
}
