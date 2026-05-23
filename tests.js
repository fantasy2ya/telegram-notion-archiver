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
