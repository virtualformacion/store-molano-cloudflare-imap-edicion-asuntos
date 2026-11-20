import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {onRequest} from '../functions/api/updateusers.js';
import {parseUsers,encode64,decode64} from '../lib/users.js';
const old=await readFile(new URL('./fixtures/original-updateusers.cjs',import.meta.url),'utf8');
const script=await readFile(new URL('../script.js',import.meta.url),'utf8');
const fixed=/const FIXED_ADMIN = (\{[\s\S]*?\});/.exec(old)[1];
const admin=vm.runInNewContext('('+fixed+')');
const env={GITHUB_TOKEN:'fake',GITHUB_REPO:'virtualformacion/store-molano',GITHUB_FILE_PATH:'script.js',GITHUB_BRANCH:'main',REPO_OWNER:'virtualformacion',REPO_NAME:'store-molano'};
function normalized(users){return users.map(u=>({...u,expiresAt:new Date(u.expiresAt).toISOString().slice(0,10)}));}
async function scenario(legacy){
 let content=script,writes=0,conflict=false;
 const realFetch=globalThis.fetch;
 const mock=async(url,options)=>{
  assert.match(url,/repos\/virtualformacion\/store-molano\/contents\/script.js/);assert.equal(options.headers.Authorization,'Bearer fake');
  if(options.method==='PUT'){
   if(conflict)return new Response('conflict',{status:409});
   const body=JSON.parse(options.body);assert.equal(body.sha,'oldsha');assert.equal(body.branch,'main');
   content=decode64(body.content);writes++;return Response.json({commit:{sha:'newsha'}});
  }
  return Response.json({content:encode64(content),sha:'oldsha'});
 };
 const context={exports:{},process:{env},Buffer,fetch:mock,console:{error(){}}};
 if(legacy)vm.runInNewContext(old,context);
 const call=async(action,payload,pass=admin.password,method='POST')=>{
  const body=JSON.stringify({action,payload,adminUser:admin.username,adminPass:pass});
  if(legacy){const r=await context.exports.handler({httpMethod:method,body});return {status:r.statusCode,data:JSON.parse(r.body)};}
  const r=await onRequest({env,request:new Request('https://example.com/api/updateusers',{method,body:method==='POST'?body:undefined})});return {status:r.status,data:await r.json()};
 };
 globalThis.fetch=mock;
 try{
  const initial=await call('list');assert.equal(initial.status,200);assert.equal(initial.data.users.length,6);
  assert.equal((await call('list',null,'wrong')).status,401);assert.equal(writes,0);
  assert.equal((await call('list',null,admin.password,'GET')).status,405);
  const user={username:'nuevo',password:'contraseña',expiresAt:'2027-11-10'};
  assert.equal((await call('create',user)).status,200);assert.equal((await call('create',user)).status,409);
  assert.equal((await call('edit',{username:'nuevo',newUsername:'renombrado',password:'otra',expiresAt:'2027-12-12'})).status,200);
  const listed=await call('list');assert.equal(listed.data.users.at(-1).username,'renombrado');
  assert.equal((await call('delete',{username:'admin'})).status,403);
  conflict=true;assert.equal((await call('delete',{username:'renombrado'})).status,500);conflict=false;
  assert.equal((await call('delete',{username:'renombrado'})).status,200);
  const final=await call('list');assert.deepEqual(normalized(final.data.users),normalized(initial.data.users));assert.equal(writes,3);
  return {content,users:normalized(final.data.users),writes};
 }finally{globalThis.fetch=realFetch;}
}
test('Same GitHub CRUD output as original STORE MOLANO; six existing users preserved',async()=>{
 const actual=await scenario(false);const expected=await scenario(true);assert.deepEqual(actual,expected);assert.equal(parseUsers(actual.content).users.length,6);
});
test('Keep original administrator and expiration in source',async()=>{
 const source=await readFile(new URL('../functions/api/updateusers.js',import.meta.url),'utf8');assert.ok(source.includes('const FIXED_ADMIN = '+fixed+';'));
});
