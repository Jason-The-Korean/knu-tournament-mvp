import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
// Test-only fixture adapter. No server authentication bypass or environment flag exists.
// Old domain fixtures predate ownership; assign explicit synthetic owners in temp DBs.
const pools=new Map();
export function testFetch(dbPath) {
 const key=!dbPath||dbPath===':memory:'?Symbol():dbPath;if(!pools.has(key))pools.set(key,{actors:new Map(),teams:new Map()});const pool=pools.get(key);
 async function createActor(base,key){
  if(pool.actors.has(key))return pool.actors.get(key);
  const username='u_'+randomBytes(10).toString('hex'),password=randomBytes(24).toString('base64url');
  const initial=await fetch(base+'/api/auth/session');let cookie=initial.headers.get('set-cookie').split(';')[0],csrf=(await initial.json()).csrfToken;
  async function post(path,data){return fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf},body:JSON.stringify(data)});}
  const registered=await post('/api/auth/register',{username,password,displayName:'테스트 계정'});if(registered.status!==201)throw new Error(await registered.text());const user=(await registered.json()).user;
  const login=await post('/api/auth/login',{username,password});if(login.status!==200)throw new Error(await login.text());cookie=login.headers.get('set-cookie').split(';')[0];csrf=(await login.json()).csrfToken;
  const result={cookie,csrf,user};pool.actors.set(key,result);return result;
 }
 function actor(base,key){
  if(pool.actors.has(key))return Promise.resolve(pool.actors.get(key));
  pool.tasks??=new Map(); if(pool.tasks.has(key))return pool.tasks.get(key);
  const task=(pool.pending??Promise.resolve()).then(()=>createActor(base,key)); pool.pending=task.catch(()=>{});pool.tasks.set(key,task);return task;
 }
 async function fixtures(base){
  if(!dbPath||dbPath===':memory:')return;
  const db=new DatabaseSync(dbPath);try{
   const owner=await actor(base,'owner');
   for(const row of db.prepare('SELECT id FROM tournaments').all())db.prepare('INSERT OR IGNORE INTO tournament_owners VALUES (?,?)').run(row.id,owner.user.id);
   for(const row of db.prepare('SELECT id,tournament_id FROM teams').all()){
    if(pool.teams.has(row.id))continue;
    const existing=db.prepare('SELECT user_id FROM team_owners WHERE team_id=?').get(row.id);
    if(existing){const value=[...pool.actors.values()].find(a=>a.user.id===existing.user_id);if(value)pool.teams.set(row.id,value);continue;}
    const representative=await actor(base,'seed:'+row.id);db.prepare('INSERT INTO team_owners VALUES (?,?,?)').run(row.id,row.tournament_id,representative.user.id);pool.teams.set(row.id,representative);
   }
  }finally{db.close();}
 }
 return async function(url,options={}){
  const base=new URL(url).origin,path=new URL(url).pathname;await fixtures(base);
  let data;try{data=JSON.parse(options.body)}catch{}
  let current=await actor(base,'owner');
  if(path.endsWith('/teams')&&data)current=await actor(base,'candidate:'+String(data.name));
  else if(data?.teamId&&pool.teams.has(data.teamId))current=pool.teams.get(data.teamId);
  else if(data?.proposer?.role==='team'&&pool.teams.has(data.proposer.teamId))current=pool.teams.get(data.proposer.teamId);
  const response=await fetch(url,{...options,headers:{...options.headers,Cookie:current.cookie,'X-CSRF-Token':current.csrf}});
  if(path.endsWith('/teams')&&response.status===201){const team=await response.clone().json();pool.teams.set(team.id,current);}
  return response;
 };
}
