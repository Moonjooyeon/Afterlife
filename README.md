# Afterlife

두 사람 중 한 사람이 먼저 떠난 뒤를 부고 형식으로 만들어 주는 웹앱입니다.
한 장짜리 HTML이던 것을 백엔드와 프론트엔드로 나눈 구조입니다.

## 로컬 실행

```bash
cp .env.example .env
```

`.env`에 `GEMINI_API_KEY`를 넣은 뒤 실행합니다. 키가 없으면 데모 모드로 뜨고 예시 결과를 보여줍니다.

```bash
npm install
npm run dev
```

기본 주소는 `http://127.0.0.1:3000`입니다. 이 명령은 백엔드가 프론트엔드 소스를 직접 서빙하므로 가장 간단한 로컬 실행 방식입니다.

프론트와 백엔드를 따로 띄우고 싶을 때:

```bash
npm run backend:dev
npm --prefix frontend install
npm run frontend:dev
```

Vite 프론트는 `http://127.0.0.1:5173`에서 열리고, `/api/*`와 `/questions.json`은 백엔드로 프록시됩니다.

## 구조

```txt
frontend/                Vite 프론트엔드
frontend/index.html      세 화면(접수 / 로딩 / 결과)의 뼈대
frontend/src/            화면 스크립트와 스타일
backend/                 Node API 서버와 정적 파일 서빙
backend/API_CONTRACT.md  API 계약
data/questions.json      문진 항목
runtime/                 SQLite DB와 런타임 데이터, Git 제외
docker/                  nginx 프록시 설정
Dockerfile.frontend      프론트 빌드 + nginx 이미지
Dockerfile.backend       백엔드 이미지
docker-compose.yml       web/backend 구성
```

## 어디까지가 프론트이고 어디부터 백엔드인가

프론트엔드는 화면만 그립니다. 접수 문진을 그리고, 답을 모아 보내고, 돌아온 JSON을 부고 형식으로 렌더링하고, `html2canvas`로 이미지를 만듭니다.

백엔드는 아래를 전부 가지고 있습니다.

- Gemini API 키 (`.env`, 브라우저 번들에 들어가지 않음)
- 생성 프롬프트 전문 (`backend/prompt.js`의 `COMMON_RULES`, `PAIR_SPEC`, `SOLO_SPEC`, `COLLAPSE`)
- 뽑기마다 결을 바꾸는 랜덤 시드 (`SEEDS`)
- 응답 JSON 검증과 재시도
- 이용권 발급과 차감
- SQLite 저장과 감사 로그

원본 HTML은 프롬프트를 브라우저에서 조립해 서버로 넘겼습니다. 프롬프트가 이 앱의 알맹이라 서버로 옮겼고, 프론트는 문진 답변만 보냅니다. 프롬프트를 고칠 때 프론트를 다시 빌드할 필요도 없습니다.

문진 항목도 코드에서 빼서 `data/questions.json`으로 옮겼습니다. 백엔드가 `/questions.json`으로 내려주고 프론트가 그걸 읽어 접수 화면을 그립니다.

## 이용권

기본값은 `TICKET_ENABLED=false`, 즉 무제한입니다. 원본 HTML의 `useTicket()` 자리에 해당합니다.

켜면 `X-Device-Id` 헤더 기준으로 남은 횟수를 세고, 결과가 정상 생성된 뒤에만 1회 깎습니다. 실패하면 깎지 않습니다. 실제 결제(토스 인앱결제 등)를 붙일 때는 결제 검증 뒤에 `backend/passes.js`의 `grant()`를 호출하는 라우트를 추가하면 됩니다.

## 데이터베이스

SQLite를 씁니다. Node 22 내장 `node:sqlite`라 의존성이 늘지 않고, 기본 경로는 `runtime/afterlife.sqlite`입니다.

| 테이블 | 뜻 |
| --- | --- |
| `app_users` | 사용자. 지금은 기기 하나가 사용자 한 명 |
| `purchase_orders` | 이용권을 준 근거 (무료 지급, 테스트 지급, 나중에 결제) |
| `access_passes` | 이용권 한 장과 잔여 횟수 |
| `usage_sessions` | 생성 시도 한 번 |
| `access_pass_charges` | 1회 차감. `charge_key` UNIQUE로 중복 차감을 DB가 막습니다 |
| `gemini_requests` | Gemini 호출 한 건. 재시도와 폴백이 각각 한 행 |
| `audit_logs` | 사용자 생성, 지급, 차감, 생성 성공·실패 기록 |
| `app_settings` | 운영 설정 키-값 |

자세한 컬럼과 감사 로그 action 목록은 `backend/API_CONTRACT.md`의 Database 절에 있습니다.

기존 `runtime/store.json`이 있으면 첫 부팅 때 자동으로 SQLite에 옮기고 `store.json.migrated`로 이름을 바꿉니다.

로그인과 결제는 아직 없습니다. 붙일 때 `app_users.login_id`를 `device:<uuid>`에서 `toss:<userKey>`로 바꾸고 `purchase_orders`에 실제 주문을 넣으면 나머지 테이블은 그대로 씁니다.

## 빌드

```bash
npm --prefix frontend install
npm run build
npm start
```

`frontend/dist/`가 있으면 백엔드는 빌드 결과물을 우선 서빙합니다.

## Docker 실행

```bash
cp .env.example .env
docker compose up --build
```

기본 주소:

```txt
http://127.0.0.1:8080
```

한 도메인 배포 기준:

```txt
https://example.com/            -> Vite 프론트
https://example.com/api/v1/*    -> Node 백엔드
```

## 키 보호

Gemini API 키는 서버 환경변수로만 사용합니다. 브라우저 번들에는 `GEMINI_API_KEY`가 포함되지 않습니다.
`.env`와 `runtime/`은 Git에 올리지 않습니다.
