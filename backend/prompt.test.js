import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from './prompt.js';

test('generation prompt includes both character personalities and behavior guidance', () => {
  const { system, user } = buildPrompt('pair', {
    deadName: '서하', deadVoice: '도현아, 반말',
    deadPersonality: '무뚝뚝하지만 행동으로 챙김',
    deadAttitude: '틱틱대지만 뒤에서 챙김', heirloom: '금이 간 머그잔',
    livingName: '도현', livingVoice: '당신, 존댓말',
    livingPersonality: '다정하지만 속마음을 숨김',
    livingCoping: '매일 2인분을 차림', inheritedHabit: '소매 끝을 접음',
    breakTrigger: '머그잔을 버리는 날', sceneAnchor: '주인이 사라진 방',
    era: '현대', choices: {}, raw: {}, keyword: '', story: ''
  });
  assert.match(user, /떠난 사람\(故\): 서하 \/ 성격: 무뚝뚝하지만 행동으로 챙김/);
  assert.match(user, /남은 사람: 도현 \/ 성격: 다정하지만 속마음을 숨김/);
  assert.match(user, /남기고 간 상흔·물건: 금이 간 머그잔/);
  assert.match(user, /떠난 사람에게서 전염된 습관: 소매 끝을 접음/);
  assert.match(user, /현재의 공간적 매개체: 주인이 사라진 방/);
  assert.match(system, /선택과 행동, 문장 길이와 대답을 피하는 방식으로 드러낸다/);
  assert.match(system, /성격 붕괴\(OOC\) 방어 및 입체적 붕괴/);
});
