# Afterlife Backend

Node 내장 HTTP 서버입니다. 외부 프레임워크 없이 `node:http`만 씁니다.

- 정적 프론트엔드 서빙 (`frontend/dist`가 있으면 우선, 없으면 `frontend/` 소스)
- `data/questions.json` 제공
- 프롬프트 조립 (`prompt.js`) — 브라우저 번들에 들어가지 않습니다
- Gemini 호출과 응답 JSON 검증 (`gemini.js`)
- 이용권 발급·차감 (`passes.js`)
- SQLite 저장과 감사 로그 (`db.js`)

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
| `passes.js` | 이용권 업무 로직 |
| `db.js` | SQLite 스키마, 이용권·세션·호출·감사 로그 저장, store.json 이관 |
| `demo.js` | 키 없을 때 돌려주는 예시 결과 |

프로덕션에서는 `GEMINI_API_KEY`와 `RUNTIME_DIR`을 반드시 설정합니다. DB는 기본으로 `RUNTIME_DIR/afterlife.sqlite`에 만들어지고, `DATABASE_PATH`로 경로를 바꿀 수 있습니다. `runtime/`은 Git에 올리지 않습니다.

테이블 구성은 `API_CONTRACT.md`의 Database 절에 있습니다. SQLite는 Node 22 내장 `node:sqlite`라 의존성이 늘지 않습니다.
