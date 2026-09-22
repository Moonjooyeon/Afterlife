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
- `RUNTIME_DIR`: 이용권 기록 저장 디렉터리. 기본값 `runtime`
- `TICKET_ENABLED`: 기본값 `false`(무제한)
- `TICKET_FREE_CREDITS`: 새 기기에 주는 기본 횟수. 기본값 `0`
- `TICKET_PASS_CREDITS`: 이용권 1개당 횟수. 기본값 `11`
- `TICKET_TEST_PASS_ENABLED`: 기본값 `false`. 내부 테스트 때만 켭니다
- `TICKET_TEST_PASS_CREDITS`: 기본값 `100`
- `VITE_API_BASE_URL`: 프론트를 다른 도메인에 올릴 때만 채우는 프론트 빌드 변수
