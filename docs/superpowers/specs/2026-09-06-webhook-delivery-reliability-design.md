# Telegram → Notion 웹훅 전달 신뢰성 설계

**날짜:** 2026-09-06
**대상:** `telegram-notion-archiver`의 GAS 웹앱, Cloudflare Worker, 배포 흐름

## 문제와 확인된 원인

운영 중인 Telegram 웹훅은 Cloudflare Worker가 아니라 인증이 필요한 Google Apps Script `/dev` URL을 가리킨다. 2026-09-06 23:22:32 KST 기준 Telegram `getWebhookInfo`는 `401 Unauthorized`와 대기 업데이트 1건을 보고했다. Worker 자체의 헬스체크는 정상이지만 Telegram 트래픽이 Worker에 도달하지 않는다.

이 잘못된 설정은 `enableWebhookMode()`가 URL 없이 호출될 때 `ScriptApp.getService().getUrl()`을 기본값으로 사용하기 때문에 발생한다. 편집기에서 실행하면 이 값이 `/dev` URL일 수 있다.

현재 전달 경로에는 별도의 유실 조건도 있다.

- Worker가 GAS 처리 결과를 기다리지 않고 Telegram에 즉시 200을 반환한다.
- Worker의 백그라운드 GAS 호출 오류가 빈 `catch`에서 사라진다.
- GAS가 처리 시작 전에 6시간 중복 캐시를 기록한다.
- `processMessage()`가 다운로드·Notion 실패를 정상 반환으로 바꿔 상위 호출자가 실패를 구분할 수 없다.
- 폴링 폴백은 개별 처리 결과와 상관없이 배치의 마지막 `update_id`까지 offset을 전진시킨다.
- `clasp push`만 수행하는 GitHub Actions는 버전 고정 Web App 배포를 새 버전으로 갱신하지 않는다.

## 목표

1. Telegram 웹훅이 항상 `telegram-notion-webhook` Worker를 가리키게 한다.
2. 일시적인 Telegram 다운로드·GAS·Notion 오류가 Telegram의 재시도로 이어지게 한다.
3. 처리 실패 업데이트를 완료 또는 중복으로 표시하지 않는다.
4. 폴링 폴백에서도 실패한 업데이트 이후의 offset을 확인 처리하지 않는다.
5. 코드, GAS HEAD, GAS Web App 배포, Worker 배포, GitHub가 서로 다른 버전에 머무르지 않게 한다.
6. 인증용 비밀값을 소스 코드에서 제거하고 교체한다.

## 범위

### GAS

- `webhook.js`
  - Worker URL과 웹훅 secret이 없으면 등록을 거부한다.
  - `script.google.com` 및 `/dev` URL을 웹훅 대상으로 거부한다.
  - `max_connections=1`로 같은 봇 업데이트의 동시 처리를 제한한다.
  - `setWebhook` 후 `getWebhookInfo`를 조회해 실제 URL을 검증한다.
- `Code.js`
  - 업데이트 처리 결과를 `processed`, `skipped`, `retry`로 명시한다.
  - 성공 또는 영구적으로 무시할 업데이트만 중복 완료 상태로 기록한다.
  - 일시적 실패는 `ok:false`, `retry:true`로 Worker에 반환한다.
  - `LockService`로 웹훅과 폴링의 중복 처리를 직렬화한다.
  - 폴링 offset은 업데이트별 성공 또는 영구 스킵 직후에만 증가시키며, 재시도 가능한 실패에서 중단한다.
- `notion.js`, `telegram.js`
  - 외부 API 오류에 HTTP 상태와 재시도 가능 여부를 보존한다.
  - Notion 429는 `Retry-After`를 따르고, 429·5xx·네트워크 오류는 재시도 대상으로 분류한다.
- `tests.js`
  - 실패 업데이트가 완료 캐시나 offset을 전진시키지 않는 회귀 테스트를 추가한다.

### Cloudflare Worker

- `worker/src/index.js`
  - `waitUntil()`의 fire-and-forget 전달을 제거한다.
  - GAS 응답을 기다리고 JSON 결과를 검증한다.
  - GAS가 재시도를 요청하거나 호출이 실패하면 Telegram에 503을 반환한다.
  - 성공 또는 영구 스킵만 200으로 확인한다.
  - 잘못된 JSON과 누락된 `update_id`를 명확히 거부한다.
- `worker/wrangler.toml`
  - 현재 Worker 이름과 GAS 배포 URL을 유지한다.
  - 배포 기준일을 현재 런타임에 맞춰 갱신한다.
- Node 내장 테스트 러너로 Worker 응답 계약을 자동 검증한다.

### 배포

- `.github/workflows/deploy.yml`
  - `clasp push --force` 뒤 새 GAS 버전을 만든다.
  - 고정 Web App deployment ID를 해당 버전으로 갱신한다.
  - 수동 재실행을 위한 `workflow_dispatch`를 제공한다.
- 로컬 변경을 테스트하고 명시적으로 커밋한 뒤 `origin/main`에 푸시한다.
- GAS Web App과 Worker를 각각 갱신한다.
- 새 랜덤 웹훅 secret과 Worker↔GAS 공유 secret을 양쪽에 설정한다. 값은 로그와 Git에 남기지 않는다.
- Telegram 웹훅을 Worker URL로 재등록한 뒤 `getWebhookInfo`에서 URL, 오류, 대기 건수를 확인한다.

## 처리 계약

GAS 처리 결과는 다음 세 가지다.

- `processed`: Notion 페이지 저장 완료. 중복 완료 기록 후 200.
- `skipped`: 문서가 아니거나 크기 제한처럼 재시도로 해결되지 않는 입력. 사용자에게 사유를 알리고 완료 기록 후 200.
- `retry`: 네트워크 오류, Telegram/Notion 429 또는 5xx, GAS 잠금 충돌 등 일시적 실패. 완료 기록을 남기지 않고 Worker가 503을 반환한다.

Worker는 GAS 결과가 `processed`, `skipped`, `duplicate`인 경우에만 Telegram에 200을 반환한다. 그 외 결과와 파싱 오류, 타임아웃은 503으로 반환해 Telegram의 재전송을 유도한다.

## 보안 마이그레이션

현재 소스에 포함된 관리자 키와 Worker↔GAS 공유 secret은 노출된 것으로 간주한다. 새 값을 생성하고 Cloudflare secret 및 GAS Script Properties에 저장한 뒤 소스의 기존 값을 제거한다. Telegram webhook secret도 함께 교체한다.

마이그레이션 중 서비스 단절을 피하기 위해 새 코드는 Script Properties를 우선 읽고, 한 번의 제한된 전환 단계에서만 기존 배포의 관리 엔드포인트를 사용한다. 전환과 검증이 끝나면 레거시 상수와 전환 경로를 제거한 최종 버전을 다시 배포한다.

## 테스트 및 완료 조건

1. Worker 단위 테스트에서 GAS 성공은 200, 재시도 결과·네트워크 실패·잘못된 응답은 503이어야 한다.
2. GAS 회귀 테스트에서 처리 실패 시 완료 캐시와 offset이 전진하지 않아야 한다.
3. GAS v11과 동일한 기존 동작 테스트가 모두 통과해야 한다.
4. 배포 후 Worker GET 헬스체크가 200이어야 한다.
5. Telegram `getWebhookInfo.url`이 Worker의 `workers.dev` URL과 정확히 같아야 한다.
6. `last_error_message`가 비어 있고 `pending_update_count`가 0이 되어야 한다.
7. 실제 소형 테스트 문서가 Notion에 한 번만 생성되고 Telegram 메시지에 성공 반응이 추가되어야 한다.
8. 의도적으로 GAS 전달을 실패시킨 Worker 테스트에서 503과 재시도가 확인되어야 한다.
9. `git status -sb`에서 로컬 `main`과 `origin/main`이 동기화되어야 한다.

## 비목표

- Notion 데이터베이스 스키마 개편
- 5 MiB를 넘는 파일의 멀티파트 업로드 지원
- Cloudflare Queue/D1 도입
- 기존 문서 분류 규칙 변경

이번 변경은 현재 장애를 복구하고 동일한 오구성 및 조용한 전달 실패를 막는 데 집중한다. 장기 장애가 24시간을 넘겨도 보존해야 하는 요구가 생기면 Queue/D1 기반 영속 수신함을 별도 단계로 추가한다.
