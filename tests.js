function testParseCaption() {
  const cases = [
    { input: 'RWA: 킥오프 회의',             expected: { category: 'RWA',        title: '킥오프 회의' } },
    { input: '스테이블코인: Q2 전략 미팅',    expected: { category: '스테이블코인', title: 'Q2 전략 미팅' } },
    { input: '킥오프 회의',                   expected: { category: '',            title: '킥오프 회의' } },
    { input: '',                              expected: { category: '',            title: '' } },
    { input: 'URL: https://a.com: extra',    expected: { category: 'URL',         title: 'https://a.com: extra' } },
  ];

  let passed = 0;
  cases.forEach(function(tc, i) {
    const result = parseCaption(tc.input);
    const ok = result.category === tc.expected.category && result.title === tc.expected.title;
    console.log(
      'Case ' + (i + 1) + ': ' + (ok ? '✅ PASS' : '❌ FAIL') +
      ' | input: ' + JSON.stringify(tc.input) +
      ' | expected: ' + JSON.stringify(tc.expected) +
      ' | got: ' + JSON.stringify(result)
    );
    if (ok) passed++;
  });
  console.log(passed + '/' + cases.length + ' passed');
}

function testDetectForwardedCategory() {
  // { text, chatTitle, expected } 형식
  var cases = [
    // 채널명 정확 매칭 — 디지털에셋사업팀
    { text: '',                        chatTitle: '디지털에셋사업팀', expected: '자산운용' },
    { text: '첨부파일입니다',           chatTitle: '디지털에셋사업팀', expected: '자산운용' },
    // 채널명/텍스트에 자산운용
    { text: ' 한화자산운용',            chatTitle: '',               expected: '자산운용' },
    { text: '자산운용 월간 뉴스레터',   chatTitle: '',               expected: '자산운용' },
    // 채널명/텍스트에 증권
    { text: ' 한화투자증권',            chatTitle: '',               expected: '투자증권' },
    { text: ' KB증권',                  chatTitle: '',               expected: '투자증권' },
    // 둘 다 없음
    { text: '기타 첨부파일',            chatTitle: '기획팀',          expected: '' },
    { text: '',                         chatTitle: '',               expected: '' },
  ];

  var passed = 0;
  cases.forEach(function(tc, i) {
    var result = detectForwardedCategory(tc.text, tc.chatTitle);
    var ok = result === tc.expected;
    console.log(
      'Case ' + (i + 1) + ': ' + (ok ? '✅ PASS' : '❌ FAIL') +
      ' | text: ' + JSON.stringify(tc.text) + ' chatTitle: ' + JSON.stringify(tc.chatTitle) +
      ' | expected: ' + JSON.stringify(tc.expected) +
      ' | got: ' + JSON.stringify(result)
    );
    if (ok) passed++;
  });
  console.log(passed + '/' + cases.length + ' passed');
}

function testSanitizeSelectName() {
  var cases = [
    { input: 'RWA',                          expected: 'RWA' },
    { input: '자산운용, 증권',                expected: '자산운용 증권' },      // 쉼표 → 공백
    { input: '오후 2',                        expected: '오후 2' },
    { input: '회의\n자료',                    expected: '회의 자료' },          // 줄바꿈 → 공백
    { input: '  앞뒤  공백  ',                expected: '앞뒤 공백' },
    { input: '',                              expected: '' },
    { input: null,                            expected: '' },
    { input: 'x'.repeat(150),                 expected: 'x'.repeat(100) },       // 길이 컷
  ];

  var passed = 0;
  cases.forEach(function(tc, i) {
    var result = sanitizeSelectName(tc.input);
    var ok = result === tc.expected;
    console.log(
      'Case ' + (i + 1) + ': ' + (ok ? '✅ PASS' : '❌ FAIL') +
      ' | input: ' + JSON.stringify(tc.input) +
      ' | expected: ' + JSON.stringify(tc.expected) +
      ' | got: ' + JSON.stringify(result)
    );
    if (ok) passed++;
  });
  console.log(passed + '/' + cases.length + ' passed');
}

function testSendAdminError() {
  // 실제로 관리자 채팅에 테스트 메시지가 전송됨
  sendAdminError('🧪 테스트: sendAdminError 정상 작동 확인');
  console.log('메시지 전송 완료 — 관리자 텔레그램 앱에서 확인하세요');
}

function testNotionFullUpload() {
  // 더미 텍스트 파일로 Notion 3-step 업로드 전체 흐름 테스트
  const dummyContent = 'Notion 업로드 테스트 파일 - ' + new Date().toISOString();
  const blob = Utilities.newBlob(dummyContent, 'text/plain', 'test-upload.txt');

  try {
    console.log('1단계: createFileUpload 호출...');
    const upload = createFileUpload('test-upload.txt', 'text/plain');
    console.log('✅ upload.id:', upload.id);

    console.log('2단계: sendFileUpload 호출...');
    sendFileUpload(upload.id, blob);
    console.log('✅ 파일 업로드 완료');

    console.log('3단계: createNotionPage 호출...');
    const page = createNotionPage(
      {
        title: 'GAS 테스트 업로드',
        category: 'RWA',
        sender: '테스트 유저',
        dateIso: new Date().toISOString().split('T')[0]
      },
      upload.id
    );
    console.log('✅ Notion 페이지 생성:', page.id);
    console.log('Notion에서 "회의록 아카이브" DB를 열어 행 생성 확인.');
  } catch (e) {
    console.error('❌ FAIL:', e.message);
  }
}

function resetOffset() {
  const token = getConfig('TELEGRAM_TOKEN');
  // 현재 pending 업데이트를 모두 consume해서 offset을 최신으로 이동
  const res = UrlFetchApp.fetch(
    'https://api.telegram.org/bot' + token + '/getUpdates?limit=100&timeout=0',
    { muteHttpExceptions: true }
  );
  const data = JSON.parse(res.getContentText());
  const updates = data.result;
  if (updates.length === 0) {
    console.log('✅ 대기 중인 업데이트 없음, offset 유지');
    return;
  }
  const newOffset = updates[updates.length - 1].update_id + 1;
  PropertiesService.getScriptProperties().setProperty('TG_OFFSET', String(newOffset));
  console.log('✅ TG_OFFSET 초기화 완료:', newOffset, '(', updates.length, '개 업데이트 스킵)');
}

function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'pollUpdates') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('pollUpdates').timeBased().everyMinutes(1).create();
  console.log('✅ 1분마다 pollUpdates 트리거 설정 완료');
}

function deleteTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'pollUpdates') ScriptApp.deleteTrigger(t);
  });
  console.log('✅ pollUpdates 트리거 삭제 완료');
}

function testDoPostMock() {
  // 실제 파일 전송 없이 doPost 흐름을 테스트하려면
  // 실제 텔레그램 bot에서 파일을 보낸 뒤 getUpdates로 file_id를 얻어 아래에 입력.
  // file_id는 텔레그램 서버에 24시간 캐시되므로 신선한 값 사용.
  const REAL_FILE_ID = 'REPLACE_ME'; // 실제 file_id로 교체

  const mockEvent = {
    postData: {
      contents: JSON.stringify({
        message: {
          message_id: 999,
          from: { first_name: '테스트', last_name: '유저' },
          chat: { id: Number(getConfig('ADMIN_CHAT_ID')) },
          date: Math.floor(Date.now() / 1000),
          caption: 'RWA: 모의 테스트 회의',
          document: {
            file_id: REAL_FILE_ID,
            file_name: 'mock-test.pdf',
            mime_type: 'application/pdf',
            file_size: 1024
          }
        }
      })
    }
  };

  const result = doPost(mockEvent);
  console.log('doPost result:', result.getContent());
  console.log('Notion DB와 텔레그램 관리자 채팅에서 결과 확인.');
}
