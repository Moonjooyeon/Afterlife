# Afterlife API Contract

브라우저는 Gemini API 키도, 생성 프롬프트도 들고 있지 않습니다. 모든 모델 호출은 백엔드를 거칩니다.

인증은 두 가지 모드가 있고 `TOSS_LOGIN_ENABLED`로 고릅니다.

| 모드 | 조건 | 인증 방법 |
| --- | --- | --- |
| 기기 | `TOSS_LOGIN_ENABLED=false` (기본) | `X-Device-Id` 헤더. 프론트가 `localStorage`에 들고 있는 임의의 문자열이고 개인정보는 담지 않습니다 |
| 토스 로그인 | `TOSS_LOGIN_ENABLED=true` | `Authorization: Bearer <token>`. `X-Device-Id`는 무시되고, 없으면 401 |

토큰은 HMAC으로 서명한 payload 한 조각이라 서버에 세션 저장소가 없습니다. 유효기간은 `SESSION_TTL_DAYS`(기본 14일)입니다.

## GET `/questions.json`

문진 항목(`aiPick`, `pair`, `solo`)을 반환합니다. 프론트는 이걸로 접수 화면을 그립니다.

## GET `/api/v1/health`

```json
{ "status": "ok" }
```

## GET `/api/v1/config`

```json
{
  "title": "[배포물 이름]",
  "demoMode": false,
  "ticketEnabled": false,
  "passCredits": 11,
  "testPassEnabled": false,
  "loginEnabled": false,
  "iapEnabled": false,
  "passPriceKrw": 0
}
```

프론트는 이걸 보고 로그인·구매 버튼을 보일지 정합니다.

`demoMode`가 `true`면 서버에 Gemini 키가 없다는 뜻이고, 생성 요청은 예시 결과를 돌려줍니다.

## POST `/api/v1/toss/login`

Apps in Toss `appLogin()`이 준 `authorizationCode`와 `referrer`를 넘깁니다. 서버가 mTLS로 토스 파트너 API에 붙어 `userKey`를 확인하고 세션 토큰을 발급합니다.

### Request

```json
{ "authorizationCode": "code-from-appLogin", "referrer": "SANDBOX" }
```

### Response

```json
{
  "user": { "id": "uuid", "loginId": "toss:USERKEY", "displayName": "토스 사용자 1234" },
  "token": "세션 토큰",
  "ticketEnabled": true,
  "remaining": 0,
  "used": 0
}
```

### Errors

- `400` `authorizationCode` 또는 `referrer` 없음
- `403` `TOSS_LOGIN_ENABLED=false`
- `500` mTLS 인증서 경로가 비어 있음
- `502` 토스 파트너 API 호출 실패

## GET `/api/v1/me`

토큰이 아직 살아 있는지 확인하고 사용자와 잔여 이용권을 돌려줍니다.

## POST `/api/v1/iap/grant-pass`

Apps in Toss `IAP.createOneTimePurchaseOrder()`의 `processProductGrant`에서 받은 `orderId`를 넘깁니다. 서버가 `TICKET_PASS_CREDITS`회를 지급합니다.

### Request

```json
{ "orderId": "apps-in-toss-order-id", "sku": "afterlife-11", "displayName": "11회 이용권", "amount": 693 }
```

### Response

```json
{ "status": "captured", "credits": 11, "ticketEnabled": true, "remaining": 11, "used": 0 }
```

같은 `orderId`가 다시 오면 `status`가 `already_granted`가 되고 두 번 지급하지 않습니다. `purchase_orders.order_id`가 UNIQUE라 DB 수준에서 막힙니다.

### Errors

- `400` `orderId` 없음
- `401` 로그인 필요
- `403` `TOSS_IAP_ENABLED=false`

## GET `/api/v1/passes`

```json
{ "ticketEnabled": true, "remaining": 10, "used": 1 }
```

`ticketEnabled`가 `false`면 `remaining`은 `null`이고 무제한입니다.

## POST `/api/v1/passes/grant`

테스트 이용권 지급. `TICKET_TEST_PASS_ENABLED=true`일 때만 열립니다. 실제 결제를 붙일 때는 결제 검증 뒤에 `passes.grant()`를 호출하는 라우트를 따로 추가합니다.

### Request

```json
{ "credits": 11 }
```

## POST `/api/v1/afterlife`

접수 답변을 받아 결과 JSON을 만들어 돌려줍니다. 프롬프트 조립, 랜덤 시드 선택, Gemini 호출, 응답 검증, 재시도까지 서버가 합니다.

### Request

```json
{
  "mode": "pair",
  "chargeKey": "AL-abc-123",
  "input": {
    "deadName": "서하",
    "deadVoice": "도현아, 반말",
    "livingName": "도현",
    "livingVoice": "당신, 존댓말",
    "era": "724년",
    "keyword": "귤",
    "story": "",
    "choices": { "관계의 온도": "순애", "떠난 방식": "사고" },
    "raw": { "temp": "순애", "tempDir": "", "relation": "" }
  }
}
```

- `mode`: `pair` 또는 `solo`
- `choices`: 문항 문구를 키로 한 선택값. 고르지 않은 항목은 프론트가 `캐해석에 맡김`으로 채웁니다.
- `raw`: 무너지는 방식(`COLLAPSE`)을 고르는 데만 쓰는 원본 값
- `chargeKey`: 같은 키로 두 번 들어오면 이용권은 한 번만 깎입니다

### Response

```json
{
  "result": { "years": "…", "cause": "…", "messages": [], "aftermath": [], "final": { "lines": [], "signature": "…" } },
  "pass": { "ticketEnabled": true, "remaining": 9, "used": 2 }
}
```

이미 차감이 끝난 `chargeKey`로 다시 요청하면 보관해 둔 결과를 그대로 돌려주고 `replayed: true`를 붙입니다. 이용권은 더 깎지 않고 Gemini도 다시 부르지 않습니다.

`result`의 모양은 모드별로 다릅니다.

- `pair`: `years`, `cause`, `news`, `messages`, `end_notice`, `aftermath`, `final`
- `solo`: `years`, `cause`, `death_type`, `logline`, `senses`, `drafts`, `last_draft`, `discovery`, `reply`, `final`

이용권은 결과가 정상 생성되고 검증을 통과한 뒤에만 깎입니다. 실패하면 깎지 않습니다.

### Errors

```json
{ "error": "message" }
```

- `400` 입력이 모자람 (`mode`, `deadName`, `livingName`)
- `401` 토스 로그인 모드인데 토큰이 없거나 만료됨
- `402` 남은 이용권 없음
- `409` 이미 차감이 끝난 `chargeKey`인데 보관된 결과가 없을 때 (`RESULT_RETENTION_DAYS=0`이거나 보관 기간이 지난 경우)
- `502` Gemini 호출 실패 또는 응답 검증 실패 (`GENERATE_MAX_RETRY`만큼 재시도한 뒤)

## Environment

- `GEMINI_API_KEY`: 서버에서만 쓰는 Gemini 키. 비어 있으면 데모 모드
- `GEMINI_API_KEYS`: 쉼표로 구분한 키 목록. 있으면 `GEMINI_API_KEY`보다 우선합니다
- `GEMINI_API_BASES`: `GEMINI_API_KEYS`와 같은 순서의 API base 목록
- `GEMINI_API_KEY_FORMATS`: `gemini`, `openai`, `monorouter` 중 하나를 키 순서대로 지정
- `GEMINI_API_MODELS`: 프로바이더별로 모델명을 강제할 때만 같은 순서로 지정
- `GEMINI_MODEL`: 기본값 `gemini-3.7-flash`
- `GEMINI_THINKING_LEVEL`: 기본값 `low`. 원가 핵심이라 낮게 고정합니다
- `GEMINI_MAX_OUTPUT_TOKENS`: 기본값 `8192`
- `GENERATE_MAX_RETRY`: 기본값 `3`
- `RESULT_RETENTION_DAYS`: 생성 결과 보관 기간(일). 기본값 `30`, `0`이면 저장하지 않음
- `APP_TITLE`: 배포물 이름. 프론트의 제목과 푸터에 그대로 들어갑니다
- `PORT`: 기본값 `3000`
- `HOST`: 기본값 `127.0.0.1`
- `RUNTIME_DIR`: DB와 런타임 데이터 디렉터리. 기본값 `runtime`
- `DATABASE_PATH`: SQLite 파일 경로. 비우면 `RUNTIME_DIR/afterlife.sqlite`
- `TICKET_ENABLED`: 기본값 `false`(무제한)
- `TICKET_FREE_CREDITS`: 새 기기에 주는 기본 횟수. 기본값 `0`
- `TICKET_PASS_CREDITS`: 이용권 1개당 횟수. 기본값 `11`
- `TICKET_TEST_PASS_ENABLED`: 기본값 `false`. 내부 테스트 때만 켭니다
- `TICKET_TEST_PASS_CREDITS`: 기본값 `100`
- `VITE_API_BASE_URL`: 프론트를 다른 도메인에 올릴 때만 채우는 프론트 빌드 변수

### 토스에서 받아와 채우는 값

| 변수 | 어디서 | 없으면 |
| --- | --- | --- |
| `TOSS_MTLS_CERT_PATH` | 앱인토스 콘솔에서 신청 → 토스 인증 부서가 발급 | 로그인이 500 |
| `TOSS_MTLS_KEY_PATH` | 위와 같이 발급 | 로그인이 500 |
| `TOSS_MTLS_KEY_PASSWORD` | 개인키에 비밀번호가 걸려 있을 때만 | 비워둡니다 |
| `TOSS_IAP_AMOUNT_KRW` | 콘솔 상품 가격과 맞춥니다 | 화면에 가격이 안 보입니다 |
| `VITE_TOSS_IAP_SKU` | 콘솔에서 만든 IAP 상품의 SKU | 상품 목록에서 이용권 횟수가 이름에 든 상품을 자동 선택 |
| `SESSION_SECRET` | 직접 생성: `openssl rand -hex 32` | 부팅마다 새로 만들어져 재시작하면 전원 재로그인 |

### 그 밖의 토스 변수

- `TOSS_LOGIN_ENABLED`: 기본값 `false`
- `TOSS_API_BASE`: 기본값 `https://apps-in-toss-api.toss.im`
- `SESSION_TTL_DAYS`: 세션 토큰 유효기간. 기본값 `14`
- `TOSS_IAP_ENABLED`: 기본값 `false`

## Database

SQLite(`node:sqlite`, Node 22 내장)를 씁니다. 별도 의존성은 없습니다. 테이블 이름은 StarSign과 맞춰 두었습니다.

| 테이블 | 한 행이 뜻하는 것 | 지금 쓰이는 곳 |
| --- | --- | --- |
| `app_users` | 사용자 한 명 | `login_id`가 기기 모드면 `device:<uuid>`, 토스 로그인이면 `toss:<userKey>` |
| `purchase_orders` | 이용권을 준 근거 | `provider`는 `free`, `test`, `migrated`, `toss`. `order_id`가 UNIQUE라 중복 지급이 막힙니다 |
| `access_passes` | 이용권 한 장 | `usage_limit` / `used_count`, 다 쓰면 `status`가 `exhausted` |
| `usage_sessions` | 생성 시도 한 번 | `charge_key`가 UNIQUE. `started` → `completed` / `failed` / `demo`. 성공한 결과를 `result`에 보관 |
| `access_pass_charges` | 1회 차감 | `charge_key`가 UNIQUE라 중복 차감이 DB에서 막힙니다 |
| `gemini_requests` | Gemini 호출 한 건 | 재시도와 프로바이더 폴백이 각각 한 행 |
| `audit_logs` | 감사 기록 | 아래 참고 |
| `app_settings` | 운영 설정 키-값 | 지금은 `audit_salt` 하나 |

### 이용권 계산

`remaining`은 활성 `access_passes`의 `usage_limit - used_count` 합입니다. 차감은 가장 오래된 활성 이용권부터 씁니다. 차감과 소진 처리는 `BEGIN IMMEDIATE` 트랜잭션 한 번에 묶여 있습니다.

### 결과 보관

성공한 결과는 `usage_sessions.result`에 JSON 문자열로 들어갑니다. **차감보다 먼저 저장**하므로, 차감 직후 응답이 끊겨도 같은 `chargeKey`로 다시 요청하면 되찾을 수 있습니다.

`RESULT_RETENTION_DAYS`(기본 30일)가 지난 결과는 `result`만 `NULL`로 비우고 세션 행은 통계용으로 남깁니다. 정리는 부팅할 때 한 번, 그 뒤로는 6시간마다 돕니다.

결과에는 사용자가 적은 캐릭터 이름과 설정이 들어갑니다. 보관하고 싶지 않으면 `RESULT_RETENTION_DAYS=0`으로 두면 저장하지 않고, 이 경우 재요청은 409가 됩니다.

### 감사 로그 action

`user.created`, `user.login`, `user.login_failed`, `pass.granted`, `pass.grant_duplicated`, `pass.grant_blocked`, `pass.charged`, `pass.rejected`, `generation.completed`, `generation.replayed`, `generation.invalid`, `generation.failed`, `generation.rejected`, `generation.demo`, `store.migrated`

IP와 User-Agent는 원본을 남기지 않고 `app_settings.audit_salt`를 섞은 SHA-256 앞 32자만 남깁니다. 같은 기기인지는 비교할 수 있고 원본은 복원할 수 없습니다.

### 이관

이전 `runtime/store.json`이 있으면 첫 부팅 때 한 번 SQLite로 옮기고 `store.json.migrated`로 이름을 바꿉니다. 기기 하나가 `app_users` 한 행 + `purchase_orders`(`provider=migrated`) 한 행 + `access_passes` 한 행이 되고, 기록된 `charges`가 `access_pass_charges` 행으로 들어갑니다.
