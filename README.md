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
runtime/                 이용권 기록, Git 제외
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

원본 HTML은 프롬프트를 브라우저에서 조립해 서버로 넘겼습니다. 프롬프트가 이 앱의 알맹이라 서버로 옮겼고, 프론트는 문진 답변만 보냅니다. 프롬프트를 고칠 때 프론트를 다시 빌드할 필요도 없습니다.

문진 항목도 코드에서 빼서 `data/questions.json`으로 옮겼습니다. 백엔드가 `/questions.json`으로 내려주고 프론트가 그걸 읽어 접수 화면을 그립니다.

## 이용권

기본값은 `TICKET_ENABLED=false`, 즉 무제한입니다. 원본 HTML의 `useTicket()` 자리에 해당합니다.

켜면 `X-Device-Id` 헤더 기준으로 남은 횟수를 세고, 결과가 정상 생성된 뒤에만 1회 깎습니다. 실패하면 깎지 않습니다. 실제 결제(토스 인앱결제 등)를 붙일 때는 결제 검증 뒤에 `backend/passes.js`의 `grant()`를 호출하는 라우트를 추가하면 됩니다.

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
