// .env를 읽어 process.env에 채운다.
//
// 설정을 모듈 최상단에서 읽는 파일은 반드시 이 파일을 첫 import로 둬야 한다.
// ESM은 import된 모듈을 먼저 평가하므로, server.js 본문에서 .env를 읽으면
// 이미 평가가 끝난 passes.js/auth.js/toss.js는 빈 값을 본 뒤다.
// 그래서 여기서는 동기로 읽는다. 비동기로 읽으면 같은 문제가 되풀이된다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 실제 환경변수가 이미 있으면 그쪽이 이긴다. (Docker env_file, CI 등)
try {
  const raw = fs.readFileSync(path.join(rootDir, '.env'), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const value = match[2].replace(/^['"]|['"]$/g, '');
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
} catch {
  // .env가 없으면 실제 환경변수만 쓴다.
}
