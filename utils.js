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

