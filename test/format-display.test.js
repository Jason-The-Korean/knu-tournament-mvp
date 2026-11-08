import test from 'node:test';
import assert from 'node:assert/strict';
import { finalFormatLabel, matchFormatLabel, matchFormat } from '../public/model.js';
test('Display missing final formats honestly; preserve saved bracket priority and processing fallback', () => {
  for (const value of [undefined, null, '', 'invalid']) {
    const t = { finalFormat: value, bracket: { rounds: [{}, {}] } };
    assert.equal(finalFormatLabel(t), '경기 방식 미설정');
    assert.equal(matchFormatLabel(t, { round: 2 }), '경기 방식 미설정');
    assert.equal(matchFormatLabel(t, { round: 1 }), 'Bo1');
  }
  const legacy = { bracket: { rounds: [{}] } };
  const before = JSON.stringify(legacy);
  assert.equal(matchFormat(legacy, { round: 1 }), 'Bo1');
  assert.equal(finalFormatLabel(legacy), '경기 방식 미설정');
  assert.equal(JSON.stringify(legacy), before);
  for (const format of ['Bo1', 'Bo3']) {
    assert.equal(finalFormatLabel({ finalFormat: format }), format);
    assert.equal(finalFormatLabel({ bracket: { finalFormat: format } }), format);
  }
  assert.equal(finalFormatLabel({ finalFormat: 'Bo1', bracket: { finalFormat: 'Bo3' } }), 'Bo3');
});
