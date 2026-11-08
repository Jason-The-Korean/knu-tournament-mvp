import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { openStore } from '../store.js';
import { migrateChampionRewards } from '../champion-reward.js';
const input = { name: 'Reward fixture', date: '2099-11-14', startsAt: '2099-11-14T01:00:00Z', recruitEndAt: '2099-11-14T00:00:00Z', capacity: 2, description: '' };
async function fixture(fn) {
  const path = join(await mkdtemp(join(tmpdir(), 'knu-champion-')), 'test.sqlite'), store = openStore(path), db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON');
  for (let n = 0; n < 8; n++) db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run('u'+n, 'u'+n, 'Test', 'fixture-salt', 'fixture-hash', 1);
  const wins = () => db.prepare("SELECT * FROM point_transactions WHERE type='TOURNAMENT_WIN'").all();
  function make(count = 2, { legacy = false, format = 'Bo1' } = {}) {
    let item;
    if (legacy) { item = { ...input, id: randomUUID(), status: 'open', capacity: count, finalFormat: format }; db.prepare('INSERT INTO tournaments VALUES (?,?)').run(item.id, JSON.stringify(item)); }
    else item = store.create({ ...input, capacity: count, finalFormat: format }, 'u0');
    for (let n=0;n<count;n++) store.register(item.id, { name:'Team'+n, representativeName:'Rep', members:Array.from({length:5},(_,i)=>`Reward${n}${i}#TEST`), representativeIndex:0 }, 'u'+n);
    store.closeRegistration(item.id); store.generateBracket(item.id); return item.id;
  }
  const get = id => store.list().find(t => t.id===id);
  function result(id, match, slot = 0, winner = 0) {
    const score = [0,0]; score[winner] = match.nextMatchId ? 1 : get(id).bracket.finalFormat==='Bo3' ? 2 : 1;
    return store.submitResult(id, match.id, { teamId:match.slots[slot].teamId, winnerTeamId:match.slots[winner].teamId, score });
  }
  try { await fn({ path, store, db, make, get, result, wins }); } finally { db.close(); store.close(); }
}

test('New tournament policy snapshot, repeated migration and legacy absence', () => fixture(({store,db,make,wins}) => {
  const id=make(), legacy=make(2,{legacy:true});
  assert.equal(store.rewardPolicy(id).win_amount,200); assert.equal(store.rewardPolicy(id).participation_amount,0); assert.equal(store.rewardPolicy(id).policy_version,'demo-v0.1');
  assert.equal(store.rewardPolicy(legacy),null); migrateChampionRewards(db); assert.equal(store.rewardPolicy(legacy),null); assert.equal(wins().length,0);
}));
test('Policy registration failure rolls back tournament and organizer link', () => fixture(({store,db}) => {
  db.exec("CREATE TRIGGER fail_policy BEFORE INSERT ON point_reward_eligibility BEGIN SELECT RAISE(ABORT,'injected failure'); END;");
  assert.throws(()=>store.create(input,'u0'));
  for(const table of ['tournaments','tournament_owners','point_reward_eligibility']) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,0);
}));
test('Single submission and dispute never pay; matching final pays only representative once', () => fixture(({store,make,get,result,wins,db}) => {
  const id=make(), match=get(id).bracket.rounds[0].matches[0];
  result(id,match,0); assert.equal(wins().length,0); result(id,match,1,1); assert.equal(get(id).bracket.rounds[0].matches[0].resultStatus,'DISPUTED'); assert.equal(wins().length,0);
  result(id,match,1,0); const tx=wins()[0], owner=store.auth.teamOwner(match.slots[0].teamId);
  assert.equal(tx.user_id,owner); assert.equal(tx.delta,200); assert.equal(tx.balance_after,200); assert.equal(tx.match_id,match.id); assert.equal(tx.team_id,match.slots[0].teamId); assert.equal(tx.policy_version,'demo-v0.1'); assert.equal(tx.idempotency_key,`tournament-win:${id}`);
  assert.equal(store.points.balance(owner),200); assert.equal(db.prepare('SELECT sum(delta) AS n FROM point_transactions WHERE user_id=?').get(owner).n,200);
  assert.throws(()=>result(id,match,1),{status:409}); assert.equal(wins().length,1);
}));
test('BYE and semifinals never pay; Bo3 final pays recorded policy amount', () => fixture(({store,db,make,get,result,wins}) => {
  const id=make(3,{format:'Bo3'}); db.prepare('UPDATE point_reward_eligibility SET win_amount=250 WHERE tournament_id=?').run(id); // Simulated earlier policy, isolated DB only.
  for(const match of get(id).bracket.rounds[0].matches){if(match.status==='bye'){assert.throws(()=>result(id,match));continue;}result(id,match,0);result(id,match,1);}
  assert.equal(wins().length,0); const final=get(id).bracket.rounds.at(-1).matches[0]; result(id,final,0); result(id,final,1);
  assert.equal(wins()[0].delta,250); assert.equal(store.rewardPolicy(id).win_amount,250);
}));
test('Legacy final confirms without reward even with missing representative link', () => fixture(({db,make,get,result,wins}) => {
  const id=make(2,{legacy:true}),m=get(id).bracket.rounds[0].matches[0];db.prepare('DELETE FROM team_owners WHERE tournament_id=?').run(id);
  result(id,m,0);result(id,m,1);assert.equal(get(id).bracket.championTeamId,m.slots[0].teamId);assert.equal(wins().length,0);
}));
test('Ledger INSERT error rolls back final, champion, timestamp, account and reward', () => fixture(({db,make,get,result,wins}) => {
  const id=make(),m=get(id).bracket.rounds[0].matches[0];result(id,m,0);const before=JSON.stringify(get(id).bracket);
  db.exec("CREATE TRIGGER fail_reward BEFORE INSERT ON point_transactions WHEN NEW.type='TOURNAMENT_WIN' BEGIN SELECT RAISE(ABORT,'injected failure'); END;");
  assert.throws(()=>result(id,m,1));assert.equal(JSON.stringify(get(id).bracket),before);assert.equal(wins().length,0);assert.equal(db.prepare('SELECT count(*) AS n FROM point_accounts').get().n,0);
  db.exec('DROP TRIGGER fail_reward');result(id,m,1);assert.equal(wins().length,1);
}));
test('Missing or cross-tournament representative link rolls back instead of guessing', () => fixture(({store,db,make,get,result,wins}) => {
  const id=make(),other=store.create(input,'u0').id,m=get(id).bracket.rounds[0].matches[0];result(id,m,0);const before=JSON.stringify(get(id).bracket);
  const owner=store.auth.teamOwner(m.slots[0].teamId);db.prepare('DELETE FROM team_owners WHERE team_id=?').run(m.slots[0].teamId);
  assert.throws(()=>result(id,m,1),{status:409});assert.equal(JSON.stringify(get(id).bracket),before);
  db.prepare('INSERT INTO team_owners VALUES (?,?,?)').run(m.slots[0].teamId,other,owner);
  assert.throws(()=>result(id,m,1),{status:409}); assert.equal(JSON.stringify(get(id).bracket),before);assert.equal(wins().length,0);
}));
test('Cancelled tournament result requests are rejected without reward', () => fixture(({db,make,get,result,wins}) => {
  const id=make(),m=get(id).bracket.rounds[0].matches[0],item=get(id);const {teams,bracket,...payload}=item;payload.status='CANCELLED';db.prepare('UPDATE tournaments SET payload=? WHERE id=?').run(JSON.stringify(payload),id);
  assert.throws(()=>result(id,m,0),{status:409});assert.equal(wins().length,0);
}));
test('Conflicting preexisting reward key prevents final confirmation and overwrites nothing', () => fixture(({store,make,get,result,wins}) => {
  const id=make(),m=get(id).bracket.rounds[0].matches[0];result(id,m,0);
  store.points.change({userId:'u7',delta:1,type:'TOURNAMENT_WIN',reason:'Conflicting fixture',policyVersion:'test',tournamentId:id,idempotencyKey:`tournament-win:${id}`});const before=JSON.stringify(get(id).bracket);
  assert.throws(()=>result(id,m,1),{status:409});assert.equal(JSON.stringify(get(id).bracket),before);assert.equal(wins()[0].delta,1);
}));
test('Concurrent independent connections and restart preserve one winner reward', () => fixture(async({path,store,make,get,result,wins}) => {
  const id=make(),m=get(id).bracket.rounds[0].matches[0];result(id,m,0);
  const code=`const{parentPort,workerData:d}=require('node:worker_threads');(async()=>{const{openStore}=await import(d.module);const s=openStore(d.path);try{s.submitResult(d.id,d.match,d.data);parentPort.postMessage(200);}catch(e){parentPort.postMessage(e.status||500);}finally{s.close();}})();`;
  const statuses=await Promise.all([0,1].map(()=>new Promise((resolve,reject)=>{const w=new Worker(code,{eval:true,workerData:{module:new URL('../store.js',import.meta.url).href,path,id,match:m.id,data:{teamId:m.slots[1].teamId,winnerTeamId:m.slots[0].teamId,score:[1,0]}}});w.once('message',resolve);w.once('error',reject);})));assert.deepEqual(statuses.sort(),[200,409]);assert.equal(wins().length,1);
  const reopened=openStore(path);assert.equal(reopened.points.history(store.auth.teamOwner(m.slots[0].teamId)).length,1);assert.equal(reopened.list().find(x=>x.id===id).bracket.championTeamId,m.slots[0].teamId);reopened.close();
}));
