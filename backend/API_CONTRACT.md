# Afterlife API Contract

브라우저는 Gemini API 키도, 생성 프롬프트도 들고 있지 않습니다. 모든 모델 호출은 백엔드를 거칩니다.

모든 `/api/v1/*` 요청에는 `X-Device-Id` 헤더가 필요합니다. 프론트가 `localStorage`에 들고 있는 임의의 문자열이고, 개인정보는 담지 않습니다. 로그인을 붙일 때는 이 자리를 세션 토큰으로 바꾸면 됩니다.

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
  "testPassEnabled": false
}
```

`demoMode`가 `true`면 서버에 Gemini 키가 없다는 뜻이고, 생성 요청은 예시 결과를 돌려줍니다.

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

`result`의 모양은 모드별로 다릅니다.

- `pair`: `years`, `cause`, `news`, `messages`, `end_notice`, `aftermath`, `final`
- `solo`: `years`, `cause`, `death_type`, `logline`, `senses`, `drafts`, `last_draft`, `discovery`, `reply`, `final`

이용권은 결과가 정상 생성되고 검증을 통과한 뒤에만 깎입니다. 실패하면 깎지 않습니다.

### Errors

```json
{ "error": "message" }
```

- `400` 입력이 모자람 (`mode`, `deadName`, `livingName`)
- `402` 남은 이용권 없음
- `409` 이미 차감이 끝난 `chargeKey`로 다시 요청 (이용권을 켰을 때만)
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

## Database

SQLite(`node:sqlite`, Node 22 내장)를 씁니다. 별도 의존성은 없습니다. 테이블 이름은 StarSign과 맞춰 두었습니다.

| 테이블 | 한 행이 뜻하는 것 | 지금 쓰이는 곳 |
| --- | --- | --- |
| `app_users` | 사용자 한 명 | `login_id`가 `device:<uuid>`. 로그인을 붙이면 `toss:<userKey>`가 같은 자리에 들어갑니다 |
| `purchase_orders` | 이용권을 준 근거 | `provider`는 `free`, `test`, `migrated`. 결제를 붙이면 `toss`가 늘어납니다 |
| `access_passes` | 이용권 한 장 | `usage_limit` / `used_count`, 다 쓰면 `status`가 `exhausted` |
| `usage_sessions` | 생성 시도 한 번 | `charge_key`가 UNIQUE. `started` → `completed` / `failed` / `demo` |
| `access_pass_charges` | 1회 차감 | `charge_key`가 UNIQUE라 중복 차감이 DB에서 막힙니다 |
| `gemini_requests` | Gemini 호출 한 건 | 재시도와 프로바이더 폴백이 각각 한 행 |
| `audit_logs` | 감사 기록 | 아래 참고 |
| `app_settings` | 운영 설정 키-값 | 지금은 `audit_salt` 하나 |

### 이용권 계산

`remaining`은 활성 `access_passes`의 `usage_limit - used_count` 합입니다. 차감은 가장 오래된 활성 이용권부터 씁니다. 차감과 소진 처리는 `BEGIN IMMEDIATE` 트랜잭션 한 번에 묶여 있습니다.

### 감사 로그 action

`user.created`, `pass.granted`, `pass.charged`, `pass.rejected`, `generation.completed`, `generation.invalid`, `generation.failed`, `generation.rejected`, `generation.demo`, `store.migrated`

IP와 User-Agent는 원본을 남기지 않고 `app_settings.audit_salt`를 섞은 SHA-256 앞 32자만 남깁니다. 같은 기기인지는 비교할 수 있고 원본은 복원할 수 없습니다.

### 이관

이전 `runtime/store.json`이 있으면 첫 부팅 때 한 번 SQLite로 옮기고 `store.json.migrated`로 이름을 바꿉니다. 기기 하나가 `app_users` 한 행 + `purchase_orders`(`provider=migrated`) 한 행 + `access_passes` 한 행이 되고, 기록된 `charges`가 `access_pass_charges` 행으로 들어갑니다.
