import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {agentTurn,streamChat} from '../dist/api.js';
import {executeTool,toolDefinitions} from '../dist/tools.js';
const event=(delta,finish_reason=null)=>'data: '+JSON.stringify({choices:[{delta,finish_reason}]});
async function fixture(run,respond){
 const requests=[];const server=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;requests.push(JSON.parse(raw));res.writeHead(200,{'content-type':'text/event-stream'});respond(res,requests.length);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{return await run(`http://127.0.0.1:${server.address().port}`,requests);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
}
test('EOF preserves fragmented tool names, arguments and UTF8',async()=>{
 await fixture(async base=>{let text='';const result=await streamChat(base,'fake','glm-5.3',[],{onToken:t=>text+=t},new AbortController().signal);assert.equal(text,'✓');assert.equal(result.toolCalls[0].name,'write_file');assert.deepEqual(JSON.parse(result.toolCalls[0].args),{path:'a',content:'ok'});},res=>{res.write(event({content:'✓',tool_calls:[{index:0,id:'a',function:{name:'write_',arguments:'{"path":"a",'}}]})+'\n\n');res.end(event({tool_calls:[{index:0,function:{name:'file',arguments:'"content":"ok"}'}}]},'tool_calls'));});
});
test('announced fix continues to real tool execution; malformed JSON never executes',async()=>{
 let executed=0;let recovery=0;let output='';
 await fixture(async(base,requests)=>{
 const history=[{role:'user',content:'Fix the broken code'}];
 await agentTurn(base,'fake','glm-5.3',history,{onToken:t=>output+=t,onRecovery:()=>recovery++},new AbortController().signal,{tools:toolDefinitions('cmds'),execute:async(name,args)=>{executed++;assert.equal(name,'edit_file');assert.equal(args.path,'a');return{ok:true,output:'Edited and verified'};}});
 assert.equal(recovery,1);assert.equal(executed,1);assert.equal(requests.length,4);assert.match(history.find(m=>m.role==='tool').content,/Invalid/);assert.match(output,/Finished/);
 },(res,n)=>res.end(event(n===1?{content:'Let me start wiring in the fix immediately:'}:n===2?{tool_calls:[{id:'bad',function:{name:'edit_file',arguments:'{"path":'}}]}:n===3?{tool_calls:[{id:'good',function:{name:'edit_file',arguments:'{"path":"a"}'}}]}:{content:'Finished and verified.'},n===2||n===3?'tool_calls':'stop')+'\n\n'));
});
test('persistent promises stop visibly after two recoveries',async()=>{await fixture(async(base,requests)=>{let output='';await agentTurn(base,'fake','m',[{role:'user',content:'Create a script'}],{onToken:t=>output+=t},new AbortController().signal,{tools:toolDefinitions('cmds'),execute:async()=>{throw Error('must not execute');}});assert.equal(requests.length,3);assert.match(output,/no success is implied/);},res=>res.end(event({content:"I'll now create the script:"},'stop')+'\n\n'));});
test('completed prose, questions and denied permissions do not force actions',async()=>{for(const content of ['Finished the changes.','Would you like me to fix this?','I cannot edit without permission.'])await fixture(async(base,requests)=>{await agentTurn(base,'fake','m',[{role:'user',content:'Fix code'}],{onToken(){}},new AbortController().signal,{tools:toolDefinitions('cmds'),execute:async()=>{throw Error('must not execute');}});assert.equal(requests.length,1);},res=>res.end(event({content},'stop')+'\n\n'));});
test('reasoning heartbeat cannot evade deadline; productive answer clears it',async()=>{
 await fixture(async base=>{await assert.rejects(streamChat(base,'fake','m',[],{onToken(){},onReasoning(){}},new AbortController().signal,{reasoningTimeoutMs:50}),/reasoning deadline/);},res=>{const timer=setInterval(()=>res.write(event({reasoning_content:'thinking'})+'\n\n'),5);res.on('close',()=>clearInterval(timer));});
 await fixture(async base=>{let output='';await streamChat(base,'fake','m',[],{onToken:t=>output+=t},new AbortController().signal,{reasoningTimeoutMs:60});assert.equal(output,'workingdone');},res=>{res.write(event({content:'working'})+'\n\n');setTimeout(()=>res.end(event({content:'done'},'stop')+'\n\n'),90);});
});
test('Windows CRLF and dollar literals survive exact edits; ambiguous anchors refuse',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'uj-edit-'));try{
 const original='before\r\nconst x = 1;\r\nconst y = 2;\r\nafter\r\n';fs.writeFileSync(path.join(dir,'a.js'),original);
 const result=await executeTool('edit_file',{path:'a.js',old_text:'const x = 1;\nconst y = 2;',new_text:"const dollars = \"$& $$ $` $'\";\nconst y = 3;"},dir,async()=>true,{mode:'cmds'});assert.equal(result.ok,true);assert.equal(fs.readFileSync(path.join(dir,'a.js'),'utf8'),"before\r\nconst dollars = \"$& $$ $` $'\";\r\nconst y = 3;\r\nafter\r\n");
 fs.writeFileSync(path.join(dir,'a.js'),'x\r\ny\r\nx\r\ny\r\n');const r=await executeTool('edit_file',{path:'a.js',old_text:'x\ny',new_text:'z'},dir,async()=>true,{mode:'cmds'});assert.equal(r.ok,false);assert.equal(fs.readFileSync(path.join(dir,'a.js'),'utf8'),'x\r\ny\r\nx\r\ny\r\n');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('large files can be read and targeted near end without overwriting prefix; denial leaves bytes intact',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'uj-large-'));try{const prefix='// preserved\n'.repeat(20000);const source=prefix+'const tail = 1;\n';fs.writeFileSync(path.join(dir,'big.js'),source);
 const read=await executeTool('read_file',{path:'big.js',start_line:20001,max_lines:1},dir);assert.equal(read.ok,true);assert.match(read.output,/const tail = 1/);
 const args={path:'big.js',old_text:'const tail = 1;',new_text:'const tail = 2;'};assert.equal((await executeTool('edit_file',args,dir,async()=>false,{mode:'cmds'})).ok,false);assert.equal(fs.readFileSync(path.join(dir,'big.js'),'utf8'),source);
 assert.equal((await executeTool('edit_file',args,dir,async()=>true,{mode:'cmds'})).ok,true);assert.equal(fs.readFileSync(path.join(dir,'big.js'),'utf8'),prefix+'const tail = 2;\n');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('a denied tool cannot trigger automatic promise recovery',async()=>{
 let executions=0;
 await fixture(async(base,requests)=>{await agentTurn(base,'fake','m',[{role:'user',content:'Create a file'}],{onToken(){}},new AbortController().signal,{tools:toolDefinitions('cmds'),execute:async()=>{executions++;return{ok:false,output:'The user declined or approval is unavailable. Nothing executed.'};}});assert.equal(executions,1);assert.equal(requests.length,2);},(res,n)=>res.end(event(n===1?{tool_calls:[{id:'denied',function:{name:'write_file',arguments:'{"path":"a","content":"x"}'}}]}:{content:"I'll now create the file:"},n===1?'tool_calls':'stop')+'\n\n'));
});
