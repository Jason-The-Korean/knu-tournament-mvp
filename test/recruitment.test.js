import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from '../server.js';
import { sessionClient } from '../test-support/session-client.js';
import { registrationReason, closeReason, kstInputToIso } from '../public/model.js';

test('Recruitment deadline: real protected API, injected clock, legacy preservation', async t => {
  const directory=await mkdtemp(join(tmpdir(),'knu-deadline-')),dbPath=join(directory,'test.sqlite');
  let current=Date.parse('2099-11-13T00:00:00Z');
  const server=createServer({dbPath,now:()=>current});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`,owner=sessionClient(base),a=sessionClient(base),b=sessionClient(base);
  for(const user of [owner,a,b]){await user.signup();await user.login();}
  const data={name:'Deadline API',date:'2099-11-14',startsAt:'2099-11-14T01:00:00Z',recruitEndAt:'2099-11-14T00:00:00Z',capacity:4,description:''};
  const team=n=>({name:'Team '+n,representativeName:'Representative',members:Array.from({length:5},(_,i)=>`Player${n}${i}#TEST`),representativeIndex:0});let id;
  try {
    await t.test('Missing, past, exact-now, timezone-free, start/date and schedule mismatch rejected',async()=>{
      for(const patch of [{recruitEndAt:undefined},{recruitEndAt:null},{startsAt:undefined},{recruitEndAt:'2099-11-12T00:00:00Z'},{recruitEndAt:new Date(current).toISOString()},{recruitEndAt:'2099-11-14T02:00:00Z'},{recruitEndAt:'2099-11-14T00:00'},{startsAt:'2099-11-15T00:00:00Z'},{scheduling:{startsAt:'2099-11-14T02:00:00Z',endsAt:'2099-11-15T00:00:00Z',maxConcurrent:1,rounds:{2:{startsAt:'2099-11-14T02:00:00Z',endsAt:'2099-11-15T00:00:00Z'},4:{startsAt:'2099-11-14T02:00:00Z',endsAt:'2099-11-15T00:00:00Z'}}}}])assert.equal((await owner.request('/api/tournaments',{...data,...patch})).status,400);
    });
    await t.test('Valid KST offsets canonicalized; no schema migration',async()=>{const r=await owner.request('/api/tournaments',{...data,startsAt:'2099-11-14T10:00:00+09:00',recruitEndAt:'2099-11-14T09:00:00+09:00'});assert.equal(r.status,201);id=r.body.id;assert.equal(r.body.startsAt,new Date(data.startsAt).toISOString());assert.equal(r.body.recruitEndAt,new Date(data.recruitEndAt).toISOString());});
    await t.test('One millisecond before succeeds; exact deadline and after rejected, no automatic close/draw',async()=>{current=Date.parse(data.recruitEndAt)-1;assert.equal((await a.request(`/api/tournaments/${id}/teams`,team(1))).status,201);current++;assert.equal((await b.request(`/api/tournaments/${id}/teams`,team(2))).status,409);current++;assert.equal((await b.request(`/api/tournaments/${id}/teams`,team(2))).status,409);const item=(await owner.request('/api/tournaments')).body.find(x=>x.id===id);assert.equal(item.teams.length,1);assert.equal(item.status,'open');assert.equal(item.bracket,null);assert.equal((await owner.request(`/api/tournaments/${id}/close`,{})).status,409);});
    await t.test('Legacy missing field remains writable under old policy and is not backfilled',async()=>{const db=new DatabaseSync(dbPath);const legacy={id:'legacy-deadline',name:'Legacy',date:'2099-11-14',capacity:4,description:'',status:'open'};db.prepare('INSERT INTO tournaments VALUES (?,?)').run(legacy.id,JSON.stringify(legacy));db.prepare('INSERT INTO tournament_owners VALUES (?,?)').run(legacy.id,owner.user.id);const original=db.prepare('SELECT payload FROM tournaments WHERE id=?').get(legacy.id).payload;assert.equal((await b.request('/api/tournaments/legacy-deadline/teams',team(3))).status,201);assert.equal(db.prepare('SELECT payload FROM tournaments WHERE id=?').get(legacy.id).payload,original);db.close();});
    await t.test('Early-close rule unchanged; elapsed deadline allows manual close only with 2+ teams',async()=>{const item={...data,status:'open',teams:[{},{}],kind:'friendly',earlyCloseMinTeams:2};assert.equal(closeReason(item,Date.parse(data.recruitEndAt)-1),'');assert.notEqual(closeReason({...item,kind:'standard'},Date.parse(data.recruitEndAt)-1),'');assert.equal(closeReason({...item,kind:'standard'},Date.parse(data.recruitEndAt)),'');assert.notEqual(closeReason({...item,teams:[{}]},Date.parse(data.recruitEndAt)),'');assert.notEqual(registrationReason(item,Date.parse(data.recruitEndAt)),'');});
    await t.test('Deadline equal to start is allowed; later initial schedule setting must agree',async()=>{
      const r=await owner.request('/api/tournaments',{...data,date:'2099-11-15',startsAt:'2099-11-15T01:00:00Z',recruitEndAt:'2099-11-15T01:00:00Z'});assert.equal(r.status,201);
      const rules=start=>({startsAt:start,endsAt:'2099-11-15T23:00:00Z',maxConcurrent:1,rounds:{2:{startsAt:start,endsAt:'2099-11-15T23:00:00Z'},4:{startsAt:start,endsAt:'2099-11-15T23:00:00Z'}}});
      assert.equal((await owner.request(`/api/tournaments/${r.body.id}/schedule-rules`,rules('2099-11-15T02:00:00Z'))).status,400);
      assert.equal((await owner.request(`/api/tournaments/${r.body.id}/schedule-rules`,rules('2099-11-15T01:00:00Z'))).status,200);
    });
    await t.test('KST conversion independent of host timezone and invalid calendar rejected',()=>{assert.equal(kstInputToIso('2099-11-14T09:00'),'2099-11-14T00:00:00.000Z');assert.throws(()=>kstInputToIso('2099-02-30T09:00'));assert.throws(()=>kstInputToIso('2099-11-14T25:00'));});
  } finally {await new Promise(r=>server.close(r));}
});
