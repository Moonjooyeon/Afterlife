# Afterlife Backend

Node 내장 HTTP 서버입니다. 외부 프레임워크 없이 `node:http`만 씁니다.

- 정적 프론트엔드 서빙 (`frontend/dist`가 있으면 우선, 없으면 `frontend/` 소스)
- `data/questions.json` 제공
- 프롬프트 조립 (`prompt.js`) — 브라우저 번들에 들어가지 않습니다
- Gemini 호출과 응답 JSON 검증 (`gemini.js`)
- 이용권 발급·차감 (`passes.js`)

```bash
npm run backend:dev
```

`GEMINI_API_KEY`가 없으면 데모 모드로 뜨고, `demo.js`의 예시 결과를 돌려줍니다. 이용권도 깎지 않습니다.

## 파일

| 파일 | 역할 |
| --- | --- |
| `server.js` | 라우팅, 정적 서빙, `.env` 로딩 |
| `prompt.js` | `COMMON_RULES` / `PAIR_SPEC` / `SOLO_SPEC` / `COLLAPSE` / 랜덤 시드 |
| `gemini.js` | 프로바이더 구성, 요청 포맷 변환, JSON 복구 파싱, 순차 폴백 |
| `passes.js` | `runtime/store.json` 기반 이용권 저장소 |
| `demo.js` | 키 없을 때 돌려주는 예시 결과 |

프로덕션에서는 `GEMINI_API_KEY`와 `RUNTIME_DIR`을 반드시 설정합니다. 이용권 기록은 `RUNTIME_DIR`의 `store.json`에 저장되고 Git에는 올리지 않습니다.
