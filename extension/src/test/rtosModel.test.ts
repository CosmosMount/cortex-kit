import assert from 'node:assert/strict';
import test from 'node:test';
import { RtosInspector, OccupancySamples, RuntimeShares } from '../rtosModel';
import { VariableDescriptor as V } from '../types';
function v(name: string, address: number, children: V[] = [], byteWidth = 4): V { return { id: name, name, expression: name, address, children, byteWidth, typeName: '', scalarKind: 'unsigned', writable: false }; }
function fixture() {
  const memory = Buffer.alloc(0x10000);
  return { memory, put: (at: number, n: number) => memory.writeUInt32LE(n, at), read: async (at: number, n: number) => {
    assert.ok(at >= 0 && at + n <= memory.length); return Buffer.from(memory.subarray(at, at + n));
  } };
}
test('ThreadX reads dynamically allocated TCBs using DWARF offsets, names, states and stack', async () => {
  const {memory, put, read} = fixture();
  const names = ['tx_thread_id','tx_thread_created_next','tx_thread_name','tx_thread_state','tx_thread_priority','tx_thread_stack_start','tx_thread_stack_size','tx_thread_stack_ptr','tx_thread_run_count','tx_thread_execution_time_total'];
  const layout = v('TX_THREAD_STRUCT', 0, names.map((n, i) => v(n, i * 4)));
  put(0x100, 0x1000); put(0x104, 2); put(0x108, 0x2000);
  for (const [address, next, name, state] of [[0x1000, 0x2000, 0x3000, 4], [0x2000, 0x1000, 0x3100, 0]]) {
    [0x54485244,next,name,state,5,0x4000,1024,0x4300,11,100].forEach((n,i) => put(address + i*4,n));
  }
  memory.write('worker\0', 0x3000); memory.write('idle\0', 0x3100);
  const inspector = new RtosInspector([v('_tx_thread_created_ptr',0x100),v('_tx_thread_created_count',0x104),v('_tx_thread_current_ptr',0x108)],[layout],read);
  const result = await inspector.snapshot();
  assert.equal(result.rtos,'ThreadX'); assert.deepEqual(result.threads.map(t=>t.name),['worker','idle']);
  assert.equal(result.threads[0].state,'Sleeping'); assert.equal(result.threads[1].state,'Running');
  assert.equal(result.threads[0].stackUsed,256); assert.equal(result.threads[0].stackBytes,1024);
  put(0x1004,0x1000); await assert.rejects(inspector.snapshot(),/链表/);
  put(0x1004,0x2000); put(0x1000,0); await assert.rejects(inspector.snapshot(),/标识无效/);
});
test('FreeRTOS enumerates ready and blocked lists including heap tasks; supports missing runtime/stack end', async () => {
  const {memory, put, read} = fixture();
  const list = v('xLIST',0,[v('uxNumberOfItems',0),v('pxIndex',4),v('xListEnd',8,[v('xItemValue',8),v('pxNext',12),v('pxPrevious',16)])]);
  const item = v('xLIST_ITEM',0,[v('xItemValue',0),v('pxNext',4),v('pxPrevious',8),v('pvOwner',12),v('pxContainer',16)]);
  const tcb = v('tskTaskControlBlock',0,[v('pxTopOfStack',0),v('uxPriority',4),v('pxStack',8),v('pcTaskName',12,Array.from({length:16},(_,i)=>v(`[${i}]`,12+i,[],1)))]);
  put(0x100,0x1000);
  for (const [at,node,owner] of [[0x200,0x400,0x1000],[0x240,0x440,0x1100]]) {
    put(at,1); put(at+12,node); put(node+4,at+8); put(node+12,owner);
    put(owner,0x4800); put(owner+4,3); put(owner+8,0x4000);
  }
  memory.write('ready\0',0x100c); memory.write('blocked\0',0x110c);
  const inspector = new RtosInspector([v('pxCurrentTCB',0x100),v('pxReadyTasksLists',0x200,[v('[0]',0x200)]),v('xDelayedTaskList1',0x240)],[list,item,tcb],read);
  const result = await inspector.snapshot();
  assert.deepEqual(result.threads.map(t=>[t.name,t.state]),[['ready','Running'],['blocked','Blocked']]);
  assert.equal(result.threads[0].stackBytes,undefined); assert.equal(result.threads[0].counter,undefined);
  put(0x400+4,0x400); await assert.rejects(inspector.snapshot(),/列表/);
});
test('unsupported RTOS, SMP and missing DWARF are explicit errors', () => {
  const read = async () => Buffer.alloc(4);
  assert.throws(()=>new RtosInspector([],[],read),/未检测到/);
  assert.throws(()=>new RtosInspector([v('pxCurrentTCBs',0x100)],[],read),/SMP/);
  assert.throws(()=>new RtosInspector([v('pxCurrentTCB',0x100)],[],read),/DWARF/);
});
test('occupancy expires old observations and preserves unknown/idle denominator', () => {
  const samples = new OccupancySamples(); samples.add(0,1); samples.add(10000,1); samples.add(20000,0);
  assert.equal(samples.distribution(30001).shares.get(1),50); assert.equal(samples.distribution(30001).count,2);
  assert.equal(samples.distribution(60000).count,0); samples.clear(); assert.equal(samples.distribution(60000).shares.size,0);
});
test('runtime deltas handle 32-bit wrap, restart, task replacement and unavailable counters', () => {
  const runtime = new RuntimeShares(); const thread = (address:number,counter:number,name='task') => ({address,counter,name,state:'Ready',priority:1,counterBits:32});
  assert.equal(runtime.update([thread(1,0xfffffff0),thread(2,100)]).size,0);
  const shares = runtime.update([thread(1,0x10),thread(2,132)]); assert.equal(shares.get(1),50); assert.equal(shares.get(2),50);
  assert.equal(runtime.update([thread(1,0),thread(2,0)]).size,0);
  assert.equal(runtime.update([thread(1,10,'replacement'),thread(2,10)]).size,0);
});
