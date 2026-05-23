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
    sendFileUpload(upload.uploadUrl, blob);
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
