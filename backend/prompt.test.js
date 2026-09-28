import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from './prompt.js';

test('generation prompt includes both character personalities and behavior guidance', () => {
  const { system, user } = buildPrompt('pair', {
    deadName: '서하', deadVoice: '도현아, 반말',
    deadPersonality: '무뚝뚝하지만 행동으로 챙김',
    livingName: '도현', livingVoice: '당신, 존댓말',
    livingPersonality: '다정하지만 속마음을 숨김',
    era: '현대', choices: {}, raw: {}, keyword: '', story: ''
  });
  assert.match(user, /떠난 사람\(故\): 서하 \/ 성격: 무뚝뚝하지만 행동으로 챙김/);
  assert.match(user, /남은 사람: 도현 \/ 성격: 다정하지만 속마음을 숨김/);
  assert.match(system, /선택과 행동, 문장 길이와 대답을 피하는 방식으로 드러낸다/);
});
