function getConfig(key) {
  const val = PropertiesService.getScriptProperties().getProperty(key);
  if (!val) throw new Error('Missing script property: ' + key);
  return val;
}

function parseCaption(text) {
  if (!text || text.trim() === '') return { category: '', title: '' };
  const idx = text.indexOf(':');
  if (idx === -1) return { category: '', title: text.trim() };
  return {
    category: text.slice(0, idx).trim(),
    title: text.slice(idx + 1).trim()
  };
}
