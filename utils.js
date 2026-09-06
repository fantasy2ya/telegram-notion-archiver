function getConfig(key) {
  const val = PropertiesService.getScriptProperties().getProperty(key);
  if (!val) throw new Error('Missing script property: ' + key);
  return val;
}

function parseCaption(text) {
  if (!text || text.trim() === '') return { category: '', title: '' };
  const idx = text.indexOf(':');
  if (idx === -1 || idx > 20) return { category: '', title: text.trim() };
  return {
    category: text.slice(0, idx).trim(),
    title: text.slice(idx + 1).trim()
  };
}

// Notion select 옵션 이름 제약 대응: 쉼표 금지 + 줄바꿈 제거 + 길이 제한(100자).
// 위반 값이면 Notion이 페이지 생성 전체를 거부하므로 반드시 정규화한다.
function sanitizeSelectName(name) {
  if (!name) return '';
  return String(name)
    .replace(/[\r\n]+/g, ' ')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

// 외부 API 실패를 재시도 가능 여부와 함께 전달한다.
// HTTP 응답이 없는 일반 예외(네트워크/실행 환경 오류)는 호출부에서 재시도 대상으로 본다.
function makeApiError_(service, status, body, retryAfter) {
  var code = Number(status) || 0;
  var detail = String(body || '').slice(0, 1000);
  var error = new Error(service + ' failed (' + code + '): ' + detail);
  error.status = code;
  error.retryAfterSeconds = Number(retryAfter) || 0;
  error.retryable = code === 0 || code === 429 || code >= 500;
  return error;
}

function isRetryableError_(error) {
  return !error || error.retryable !== false;
}

function getResponseHeader_(response, name) {
  if (!response || typeof response.getHeaders !== 'function') return '';
  var headers = response.getHeaders() || {};
  var wanted = String(name).toLowerCase();
  var found = '';
  Object.keys(headers).some(function(key) {
    if (String(key).toLowerCase() === wanted) {
      found = headers[key];
      return true;
    }
    return false;
  });
  return found;
}

