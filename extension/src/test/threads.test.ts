import assert from 'node:assert/strict';
import test from 'node:test';

test('Threads lifecycle stops hidden/disposed reads, avoids overlap and excludes halted observations', async () => {
  let message: (m:any)=>void = () => {}, visibility = () => {}, sessionChange = () => {}, stateChange: (e:any)=>void = () => {};
  const messages:any[] = [], requests:string[] = [];
  let running = true;
  const session = {id:'test',customRequest:async(command:string) => {
    requests.push(command);
    if(command==='cortexKit/getCatalog') return {variables:[]};
    if(command==='cortexKit/getRtosLayouts') return {layouts:[]};
    if(command==='cortexKit/getState') return {targetState:running?'running':{halted:{reason:'pause'}}};
    if(command==='readMemory') return {data:Buffer.alloc(4).toString('base64')};
    throw new Error(command);
  }};
  let currentReads = 0, snapshotReads = 0;
  class Inspector {
    constructor(_catalog:any,_types:any,private read:any) {}
    async current() {currentReads++;await this.read(0x20000000,4);return 0x20000100;}
    async snapshot() {snapshotReads++;await this.read(0x20000000,4);return {rtos:'ThreadX',threads:[{address:0x20000100,name:'task',state:'Ready',priority:1}],current:0,notes:[]};}
  }
  const disposable = {dispose(){}};
  const vscode = {Uri:{joinPath:(_base:any,...parts:string[])=>parts.join('/')},debug:{onDidReceiveDebugSessionCustomEvent:(fn:any)=>{stateChange=fn;return disposable;}}};
  const modules=require('node:module');const original=modules._load;
  modules._load=function(name:string,...args:any[]) {
    if(name==='vscode') return vscode;
    if(name==='./rtosModel') return {...original.call(this,name,...args),RtosInspector:Inspector};
    return original.call(this,name,...args);
  };
  let controller:any;
  try {
    const {ThreadsView}=require('../threads');
    const plots:any={session,onDidChangeSession:(fn:any)=>{sessionChange=fn;return disposable;}};
    controller=new ThreadsView({extensionUri:'extension'},plots);
    const view:any={visible:false,webview:{asWebviewUri:(v:any)=>v,postMessage:(m:any)=>{messages.push(m);return Promise.resolve(true);},onDidReceiveMessage:(fn:any)=>{message=fn;return disposable;}},onDidDispose:()=>disposable,onDidChangeVisibility:(fn:any)=>{visibility=fn;return disposable;}};
    controller.resolveWebviewView(view);
    assert.ok(!view.webview.html.includes('线程时间占比'));
    assert.ok(view.webview.html.includes('运行占比 · 抽样估算'));
    assert.equal(requests.length,0);
    const settled=async()=>{for(let i=0;i<100&&controller.busy;i++) await new Promise(setImmediate);controller.cancelTimer();assert.equal(controller.busy,false);};
    view.visible=true;visibility();await settled();
    assert.equal(currentReads,1);assert.equal(snapshotReads,1);assert.equal(messages.at(-1).rows[0].sampled,100);
    assert.equal(messages.at(-1).rows[0].runtime,undefined);
    assert.ok(!messages.at(-1).note.includes('execution profiling'));
    await Promise.all([controller.tick(true),controller.tick(true)]);controller.cancelTimer();
    assert.equal(currentReads,2);assert.equal(snapshotReads,2);
    running=false;stateChange({session,event:'cortexKit.state',body:{targetState:{halted:{reason:'pause'}}}});
    await controller.tick(true);controller.cancelTimer();assert.equal(currentReads,2);assert.equal(messages.at(-1).rows[0].sampled,undefined);
    view.visible=false;visibility();await controller.tick(true);assert.equal(snapshotReads,3);
    view.visible=true;message({command:'auto',value:false});await controller.tick();assert.equal(snapshotReads,3);
    await controller.tick(true);controller.cancelTimer();assert.equal(snapshotReads,4);
    plots.session=undefined;sessionChange();await settled();assert.deepEqual(messages.at(-1).rows,[]);
    controller.dispose();await controller.tick(true);assert.equal(snapshotReads,4);
    assert.ok(requests.every(c=>['cortexKit/getCatalog','cortexKit/getRtosLayouts','cortexKit/getState','readMemory'].includes(c)));
  } finally {controller?.dispose();modules._load=original;}
});
