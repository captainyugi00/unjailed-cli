import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'unjailed-memory-'));
process.env.UNJAILED_HOME = home;
const { prepareRequestHistory, agentTurn } = await import('../dist/api.js');
const { identifyHistory, protectWorkingContext, searchHistory, workingContext } = await import('../dist/context.js');
const { appendSession, saveSession, loadSession, newSession, listSessions, deleteSession, sessionsDir } = await import('../dist/sessions.js');
test.after(() => fs.rmSync(home, { recursive:true, force:true }));

test('older requirements and middle facts survive the request window; source IDs recover exact text', () => {
  const original = [{role:'user',content:'Start the project.'}];
  const facts = 'noise '.repeat(600) + '\nDatabase port for ProjectQuartz: 6432, deployment region: eu-west-3.\n' + 'tail '.repeat(600);
  for (let i=0;i<500;i++) original.push({role:i%2?'assistant':'user',content:i===14?'Always preserve the marble invoices. Never delete customer records.':i===70?facts:`ordinary turn ${i}`});
  original.push({role:'user',content:'What was the ProjectQuartz database port and deployment region?'});
  identifyHistory(original);
  const source = [{role:'system',content:'Agent instructions'}, ...original];
  const before = JSON.stringify(source);
  const prepared = prepareRequestHistory(source);
  const memory = prepared.messages.find(m => m.content.startsWith('Earlier conversation excerpts'))?.content;
  assert.match(memory, /Never delete customer records/);
  assert.match(memory, /ProjectQuartz: 6432, deployment region: eu-west-3/);
  assert.match(memory, /message:72/);
  assert.deepEqual(prepared.messages.at(-1), original.at(-1));
  assert.equal(JSON.stringify(source),before);
  assert.ok(prepared.messages.length <= 162);
  assert.ok(prepared.messages.reduce((n,m)=>n+m.content.length,0) <= 96_000);
  const exact = JSON.parse(searchHistory(original,[],{entry:'message:72',offset:0,length:12000}).output);
  assert.equal(exact.content,facts);
  const matches = JSON.parse(searchHistory(original,[],{query:'ProjectQuartz database port'}).output).matches;
  assert.ok(matches.some(m=>m.entry==='message:72'));
});

test('one enormous current prompt stays last and original remains exact', () => {
  const input = [{role:'system',content:'Rules'}, {role:'user',content:'Must use purple borders.\n'+'x'.repeat(100_000)}];
  const result = prepareRequestHistory(input);
  assert.equal(result.messages.at(-1).role,'user');
  assert.ok(result.messages.at(-1).content.startsWith('Must use purple borders.'));
  assert.equal(input[1].content.length,100_025);
});

test('tool evidence reports denial accurately, retains exact output and cannot execute paths', () => {
  const events = [{id:'success',name:'read_file',args:{path:'project/config.txt'},ok:true,output:'abc'.repeat(6000),at:1}, {id:'denied',name:'write_file',args:{path:'private.txt',content:'secret'},ok:false,output:'Skipped by user',at:2}];
  const context = workingContext(events,['Keep the purple theme']);
  assert.match(context,/write_file \(failed\/skipped\)/);
  assert.match(context,/Keep the purple theme/);
  assert.ok(!context.includes('"secret"'));
  const data = JSON.parse(searchHistory([],events,{entry:'tool:success',offset:12000,length:12000}).output);
  const exact = JSON.stringify({name:events[0].name,args:events[0].args,ok:true,output:events[0].output});
  assert.equal(data.content,exact.slice(12000,24000));
  assert.equal(searchHistory([],events,{entry:'../../etc/passwd'}).ok,false);
  assert.match(searchHistory([],events,{query:'private.txt'}).output,/Skipped by user/);
});

test('full pinned notes survive long active tool groups and character compression', () => {
  const notes = workingContext([], ['left '.repeat(650) + 'PINNED-MIDDLE-MUST-SURVIVE' + ' right'.repeat(650)]);
  const protectedMessage = protectWorkingContext({role:'assistant',content:notes});
  const history = [{role:'system',content:'Current permission rules'}, {role:'user',content:'Original task'}, protectedMessage, {role:'user',content:'Current active task'}];
  for(let i=0;i<100;i++) history.push({role:'assistant',content:'Older tool round '+ 'verbose '.repeat(1200),tool_calls:[{id:'c'+i,type:'function',function:{name:'read_file',arguments:'{}'}}]},{role:'tool',tool_call_id:'c'+i,content:'raw result '.repeat(1500)});
  const wire = prepareRequestHistory(history).messages;
  assert.ok(wire.some(m=>m.content===notes),'generated working context remains exact after selection and trimming');
  assert.ok(wire.some(m=>m.content.includes('PINNED-MIDDLE-MUST-SURVIVE')));
  assert.ok(wire.every(m=>!Object.keys(m).some(key=>key.includes('protected'))),'no internal marker leaks into API protocol');
});

test('async sessions migrate legacy history once and append only new turns with private permissions', async () => {
  const s = newSession('/project','test');
  for (let i=0;i<1000;i++) s.messages.push({role:i%2?'assistant':'user',content:`${i}:`+'x'.repeat(2000)});
  s.notes=['Remember the exact region'];
  saveSession(s);
  const saved = structuredClone(s.messages);
  s.messages.push({role:'user',content:'new task'}, {role:'assistant',content:'done'});
  s.toolHistory=[{id:'read',name:'read_file',args:{path:'config'},ok:true,output:'complete raw result',at:1}];
  await appendSession(s);
  const file=path.join(sessionsDir(),s.id+'.json'), journal=path.join(sessionsDir(),s.id+'.jsonl');
  const size=fs.statSync(journal).size;
  assert.ok(fs.statSync(file).size < 1000,'manifest does not rewrite the full conversation');
  s.messages.push({role:'user',content:'next'}, {role:'assistant',content:'next result'});
  await appendSession(s);
  assert.ok(fs.statSync(journal).size-size < 400,'next turn serializes/writes only its new entries');
  assert.deepEqual(loadSession(s.id).messages.slice(0,1000),saved);
  assert.deepEqual(loadSession(s.id).messages,s.messages);
  assert.deepEqual(loadSession(s.id).toolHistory,s.toolHistory);
  assert.deepEqual(loadSession(s.id).notes,s.notes);
  assert.equal(listSessions().find(e=>e.id===s.id).count,502);
  if(process.platform!=='win32') for(const filePath of [file,journal]) assert.equal(fs.statSync(filePath).mode&0o777,0o600);
  const unchanged=fs.statSync(journal).size;
  await appendSession(s);
  assert.equal(fs.statSync(journal).size,unchanged,'retry cannot duplicate a turn');
});

test('queued saves stay ordered and stale writers cannot overwrite completed history', async () => {
  const s = newSession('/project','test');
  s.messages=[{role:'user',content:'one'}, {role:'assistant',content:'first'}];
  const first=appendSession(s);
  const stale=structuredClone(s);
  s.messages.push({role:'user',content:'two'}, {role:'assistant',content:'second'});
  const second=appendSession(s);
  await Promise.all([first,second]);
  assert.deepEqual(loadSession(s.id).messages,s.messages);
  await assert.rejects(appendSession(stale),/history|another terminal|revision/);
  assert.deepEqual(loadSession(s.id).messages,s.messages);
});

test('stale notes-only updates reject old revisions and preserve first writer notes', async () => {
  const initial = newSession('/project','test'); initial.notes=['Original pinned note'];
  await appendSession(initial);
  assert.ok(listSessions().some(s=>s.id===initial.id),'notes-only sessions are discoverable');
  const left=loadSession(initial.id), right=loadSession(initial.id);
  assert.equal(left.messages.length,0);
  left.notes.push('Left writer note'); await appendSession(left);
  right.notes.push('Right stale writer note');
  await assert.rejects(appendSession(right),/revision.*another terminal/);
  assert.deepEqual(loadSession(initial.id).notes,left.notes);
});

test('atomic locks reject live owners and recover dead owners without ownerless files', async () => {
  const s=newSession('/project','test');s.notes=['Private pinned note'];
  const lock=path.join(sessionsDir(),s.id+'.json.lock');
  fs.mkdirSync(sessionsDir(),{recursive:true});
  fs.writeFileSync(lock,String(process.pid));
  await assert.rejects(appendSession(s),/another CLI/);
  assert.equal(fs.readFileSync(lock,'utf8'),String(process.pid),'live lock untouched');
  fs.writeFileSync(lock,'2147483647');
  await appendSession(s);
  assert.deepEqual(loadSession(s.id).notes,s.notes);
  assert.equal(fs.existsSync(lock),false);
  assert.equal(fs.readdirSync(sessionsDir()).some(name=>name.includes(s.id+'.json.lock')),false,'owner candidates/recovery guards removed');
});

test('truncated final journal entry recovers; corrupt complete record never silently disappears', async () => {
  const s = newSession('/project','test');
  s.messages=[{role:'user',content:'initial'}, {role:'assistant',content:'kept'}];
  await appendSession(s);
  const journal=path.join(sessionsDir(),s.id+'.jsonl');
  fs.appendFileSync(journal,'{"start":2,"messages":[');
  assert.deepEqual(loadSession(s.id).messages,s.messages);
  // Force a fresh writer cursor, just like starting a new process.
  const manifest=path.join(sessionsDir(),s.id+'.json');
  const meta=JSON.parse(fs.readFileSync(manifest));meta.messageCount=0;fs.writeFileSync(manifest,JSON.stringify(meta));
  s.messages.push({role:'user',content:'after crash'},{role:'assistant',content:'recovered'});
  await appendSession(s);
  assert.deepEqual(loadSession(s.id).messages,s.messages);
  fs.appendFileSync(journal,'{"start":999,"messages":[],"toolStart":0,"tools":[]}\n');
  assert.equal(loadSession(s.id),null);
  deleteSession(s.id);
  assert.equal(fs.existsSync(journal),false);
});


test('compacted live tool results carry a real archive reference, never a scratch message index', async () => {
  const messages=[{role:'user',content:'Read gamma artifact'}];identifyHistory(messages);
  const history=[{role:'system',content:'Rules'},...messages];
  const event={id:'exact-gamma',name:'read_file',args:{path:'gamma.txt'},ok:true,output:'gamma artifact detail '+ 'raw '.repeat(25000),at:1};
  const requests=[];const oldFetch=globalThis.fetch;
  globalThis.fetch=async (_url,init)=>{
    requests.push(JSON.parse(init.body));
    if(requests.length===1)return Response.json({choices:[{message:{tool_calls:[{id:'gamma-read',function:{name:'read_file',arguments:'{"path":"gamma.txt"}'}}]}}]});
    return Response.json({choices:[{message:{content:'Done'}}]});
  };
  try {
    await agentTurn('http://local.test/v1','test','test',history,{onToken(){}},new AbortController().signal,{tools:[{}],execute:async()=>({ok:true,output:event.output,historyEntry:'tool:'+event.id})});
    const archive=requests[1].messages.find(m=>m.content.startsWith('Earlier conversation excerpts')).content;
    assert.match(archive,/tool:exact-gamma/);
    assert.ok(requests[1].messages.every(m=>!Object.hasOwn(m,'historyEntry')),'archive identity is internal, not provider protocol metadata');
    const recovered=JSON.parse(searchHistory(messages,[event],{entry:'tool:exact-gamma',length:12000}).output);
    assert.match(recovered.content,/gamma artifact detail/);
    assert.ok(history.find(m=>m.role==='tool').content===event.output,'live source stays exact');
  } finally { globalThis.fetch=oldFetch; }
});
