import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from '../server.js';
import { openStore } from '../store.js';
import { pointStorage } from '../points.js';
import { sessionClient } from '../test-support/session-client.js';

test('Own points API: sessions, pagination, no mutation and actual championship', async t => {
  const path=join(await mkdtemp(join(tmpdir(),'knu-points-api-')),'test.sqlite'),server=createServer({dbPath:path});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`,a=sessionClient(base),b=sessionClient(base),guest=sessionClient(base);for(const c of [a,b]){assert.equal((await c.signup()).status,201);await c.login();}
  const db=new DatabaseSync(path);db.exec('PRAGMA foreign_keys=ON');const store=openStore(path);
  try {
    await t.test('New member has 100P and one signup transaction with correct balance-after',async()=>{
      const r=await a.request('/api/me/points');assert.equal(r.status,200);assert.equal(r.body.balance,100);assert.equal(r.headers.get('cache-control'),'no-store');
      const h=await a.request('/api/me/point-transactions');assert.equal(h.body.transactions.length,1);assert.equal(h.body.transactions[0].balance_after,100);assert.equal(h.body.transactions[0].type,'SIGNUP_BONUS');assert.equal(h.body.hasMore,false);
    });
    await t.test('Unauthenticated requests rejected; user selectors and injection cannot access another user',async()=>{
      for(const endpoint of ['/api/me/points','/api/me/point-transactions']){assert.equal((await guest.request(endpoint)).status,401);for(const q of [`?userId=${b.user.id}`,`?user_id=${b.user.id}`,'?userId=%27%20OR%201%3D1'])assert.equal((await a.request(endpoint+q)).status,400);}
      assert.ok((await a.request('/api/me/point-transactions')).body.transactions.every(tx=>tx.user_id===a.user.id));
    });
    await t.test('Actual final confirmation yields 300P, two own transactions and valid tournament link',async()=>{
      const item=store.create({name:'API reward',date:'2099-11-14',startsAt:'2099-11-14T01:00:00Z',recruitEndAt:'2099-11-14T00:00:00Z',capacity:2,description:''},a.user.id);
      const teams=[a,b].map((c,n)=>store.register(item.id,{name:'T'+n,representativeName:'Test',members:Array.from({length:5},(_,i)=>`API${n}${i}#TEST`),representativeIndex:0},c.user.id));store.closeRegistration(item.id);const m=store.generateBracket(item.id).rounds[0].matches[0];
      const score=m.slots.map(s=>s.teamId===teams[0].id?1:0);for(const team of teams)store.submitResult(item.id,m.id,{teamId:team.id,winnerTeamId:teams[0].id,score});
      assert.equal((await a.request('/api/me/points')).body.balance,300);const rows=(await a.request('/api/me/point-transactions')).body.transactions;assert.deepEqual(rows.map(tx=>tx.balance_after),[300,100]);assert.equal(rows[0].tournamentExists,true);assert.equal(rows[0].tournament_id,item.id);assert.equal((await b.request('/api/me/points')).body.balance,100);
    });
    await t.test('Same-time transactions have deterministic newest insertion order and bounded pagination',async()=>{
      const p=pointStorage(db,{now:()=>Date.parse('2099-01-01T00:00:00Z')});for(let n=0;n<55;n++)p.change({userId:a.user.id,delta:1,type:'CREDIT',reason:'Tie '+n,policyVersion:'test',idempotencyKey:'tie:'+n});
      const first=(await a.request('/api/me/point-transactions?limit=20&offset=0')).body,second=(await a.request('/api/me/point-transactions?limit=20&offset=20')).body;assert.equal(first.transactions.length,20);assert.equal(first.nextOffset,20);assert.equal(first.hasMore,true);assert.equal(first.transactions[0].reason,'Tie 54');assert.equal(first.transactions[19].reason,'Tie 35');assert.equal(second.transactions[0].reason,'Tie 34');assert.equal(new Set([...first.transactions,...second.transactions].map(tx=>tx.id)).size,40);
      assert.equal((await a.request('/api/me/point-transactions?limit=50')).body.transactions.length,50);
      assert.deepEqual((await a.request('/api/me/point-transactions?offset=999')).body.transactions,[]);
    });
    await t.test('Malformed or excessive pagination input rejected',async()=>{
      for(const q of ['limit=0','limit=51','limit=-1','limit=1.5','limit=','limit=NaN','limit=1e1','limit=1&limit=2','offset=-1','offset=1000001','offset=9007199254740992','offset=0%20OR%201=1'])assert.equal((await a.request('/api/me/point-transactions?'+q)).status,400,q);
    });
    await t.test('Existing member zero/empty reads do not create account or ledger',async()=>{
      const {scryptSync}=await import('node:crypto'),salt='isolated',password='isolated-test-password';db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run('legacy','legacy_points','Legacy',salt,scryptSync(password,salt,64,{N:32768,r:8,p:3,maxmem:64*1024*1024}).toString('hex'),1);const c=sessionClient(base);await c.bootstrap();assert.equal((await c.request('/api/auth/login',{username:'legacy_points',password})).status,200);
      assert.equal((await c.request('/api/me/points')).body.balance,0);assert.deepEqual((await c.request('/api/me/point-transactions')).body.transactions,[]);assert.equal(db.prepare('SELECT count(*) AS n FROM point_accounts WHERE user_id=?').get('legacy').n,0);
    });
    await t.test('Cross-origin blocked, no write API, logout invalidates access and reads preserve ledger',async()=>{
      const before=JSON.stringify(db.prepare('SELECT * FROM point_transactions ORDER BY id').all());
      assert.equal((await a.request('/api/me/points',undefined,{Origin:'https://evil.invalid'})).status,403);
      assert.equal((await a.request('/api/me/points',{delta:999})).status,404);
      await a.request('/api/me/points');await a.request('/api/me/point-transactions');assert.equal(JSON.stringify(db.prepare('SELECT * FROM point_transactions ORDER BY id').all()),before);
      await a.request('/api/auth/logout',{});assert.equal((await a.request('/api/me/points')).status,401);
    });
  }finally{store.close();db.close();await new Promise(r=>server.close(r));}
});
