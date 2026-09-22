# Afterlife Frontend

Vite 기반 정적 프론트엔드입니다. 화면, 문진 렌더링, 결과 렌더링, 이미지 저장만 담당합니다.
프롬프트와 API 키는 들고 있지 않습니다.

```bash
npm install
npm run dev
```

개발 서버는 `/api/*`와 `/questions.json` 요청을 `http://127.0.0.1:3000` 백엔드로 프록시합니다.

## 파일

| 파일 | 역할 |
| --- | --- |
| `index.html` | 세 화면(접수 / 로딩 / 결과)의 뼈대 |
| `src/style.css` | 부고 스타일 전체 |
| `src/main.js` | 문진 렌더링, 상태, 결과 렌더링, `html2canvas` 저장 |

문진 항목은 코드에 박혀 있지 않고 백엔드가 주는 `/questions.json`을 읽어 그립니다. 항목을 바꿀 때는 `data/questions.json`만 고치면 됩니다.

`VITE_API_BASE_URL`은 프론트를 백엔드와 다른 도메인에 올릴 때만 채웁니다. 한 도메인에서 서빙하면 비워둡니다.
