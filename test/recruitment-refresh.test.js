import test from 'node:test';
import assert from 'node:assert/strict';
import { recruitmentRefresh } from '../public/recruitment-refresh.js';
function fixture() {
  let visible = true, job = null, calls = [], applied = [], errors = [];
  const controller = recruitmentRefresh({ fetchState: (id, signal) => new Promise((resolve, reject) => calls.push({ id, signal, resolve, reject })), apply: item => applied.push(item), onError: e => errors.push(e), visible: () => visible, schedule: (fn, ms) => { assert.equal(ms, 12000); job = fn; return fn; }, cancel: () => { job = null; } });
  return { controller, calls, applied, errors, setVisible: value => { visible = value; controller.visibilityChanged(); }, scheduled: () => job };
}
test('Live recruitment: one timer/request, latest route only, stop after closing', async () => {
  const f=fixture(); f.controller.start('one'); assert.ok(f.scheduled());
  const running=f.controller.refresh(); assert.equal(f.calls.length,1); await f.controller.refresh(); assert.equal(f.calls.length,1);
  f.controller.start('two'); assert.equal(f.calls[0].signal.aborted,true); f.calls[0].resolve({id:'one',status:'open'}); await running; assert.deepEqual(f.applied,[]);
  const next=f.controller.refresh();f.calls[1].resolve({id:'two',status:'closed'});await next;assert.equal(f.applied.length,1);assert.equal(f.scheduled(),null);await f.controller.refresh();assert.equal(f.calls.length,2);
});
test('Hidden tabs abort and pause; visibility resumes; errors keep polling; leaving stops', async () => {
  const f=fixture();f.controller.start('one');const first=f.controller.refresh();f.setVisible(false);assert.equal(f.scheduled(),null);assert.equal(f.calls[0].signal.aborted,true);f.calls[0].resolve({id:'one',status:'open'});await first;assert.deepEqual(f.applied,[]);
  f.setVisible(true);assert.equal(f.calls.length,2);f.calls[1].reject(new Error('network'));await new Promise(resolve=>setImmediate(resolve));assert.equal(f.errors.length,1);assert.ok(f.scheduled());
  f.controller.stop();assert.equal(f.scheduled(),null);await f.controller.refresh();assert.equal(f.calls.length,2);
});
