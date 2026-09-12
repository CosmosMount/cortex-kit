import { VariableDescriptor as V } from './types';

export type MemoryReader = (address: number, length: number) => Promise<Buffer>;
export interface ThreadInfo {
  address: number; name: string; state: string; priority: number; stackBytes?: number;
  stackUsed?: number; counter?: number; counterBits?: number; runs?: number;
}
export interface ThreadSnapshot { rtos: string; threads: ThreadInfo[]; current: number; notes: string[]; }
const txStates = ['Ready', 'Completed', 'Terminated', 'Suspended', 'Sleeping', 'Queue wait', 'Semaphore wait', 'Event flags wait', 'Block memory wait', 'Byte memory wait', 'I/O wait', 'File wait', 'Network wait', 'Mutex wait', 'Priority change'];
function field(layout: V, name: string): V {
  const found = layout.children.find(v => v.name === name);
  if (!found || found.address === undefined) { throw new Error(`调试信息缺少 ${layout.name}.${name}；请使用带完整 DWARF 的 ELF。`); }
  return found;
}
function span(v: V): number {
  return Math.max((v.address ?? 0) + v.byteWidth, ...v.children.map(span));
}
function uint(bytes: Buffer, offset: number, width = 4): number {
  if (![1, 2, 4, 8].includes(width) || offset < 0 || offset + width > bytes.length) { throw new Error('RTOS 字段越界或宽度不支持'); }
  if (width === 8) { const n = bytes.readBigUInt64LE(offset); if (n > BigInt(Number.MAX_SAFE_INTEGER)) { throw new Error('运行计数器超过安全整数范围'); } return Number(n); }
  return bytes.readUIntLE(offset, width);
}
function value(bytes: Buffer, layout: V, name: string): number { const f = field(layout, name); return uint(bytes, f.address!, f.byteWidth); }
function optional(bytes: Buffer, layout: V, name: string): number | undefined {
  return layout.children.some(v => v.name === name) ? value(bytes, layout, name) : undefined;
}
function validPointer(address: number): void {
  if (!Number.isInteger(address) || address < 0x100 || address > 0xfffffffc || address % 4) { throw new Error(`RTOS 指针无效：0x${address.toString(16)}`); }
}
export class RtosInspector {
  readonly rtos: 'ThreadX' | 'FreeRTOS';
  readonly currentSymbol: V;
  private readonly tcb: V;
  private readonly globals: Map<string, V>;
  constructor(private readonly catalog: V[], private readonly layouts: V[], private readonly read: MemoryReader) {
    this.globals = new Map(catalog.map(v => [v.name, v]));
    if (this.globals.has('_tx_thread_created_ptr') && this.globals.has('_tx_thread_current_ptr')) {
      this.rtos = 'ThreadX'; this.currentSymbol = this.global('_tx_thread_current_ptr');
      this.tcb = this.layout('TX_THREAD_STRUCT', 'TX_THREAD');
    } else if (this.globals.has('pxCurrentTCB')) {
      this.rtos = 'FreeRTOS'; this.currentSymbol = this.global('pxCurrentTCB');
      this.tcb = this.layout('tskTaskControlBlock', 'TCB_t');
    } else if (this.globals.has('pxCurrentTCBs')) {
      throw new Error('当前为 FreeRTOS SMP；此版本支持单核 Cortex-M，暂不支持多核占用统计。');
    } else { throw new Error('未检测到 ThreadX / FreeRTOS。请连接调试会话并提供与固件一致、包含 RTOS 符号和 DWARF 的 ELF。'); }
  }
  private layout(...names: string[]): V {
    const found = this.layouts.find(v => names.includes(v.name));
    if (!found) { throw new Error(`缺少 ${names.join(' / ')} 的 DWARF 类型信息；请为 RTOS 内核启用调试信息。`); }
    if (span(found) > 8192) { throw new Error('RTOS 结构大小异常'); }
    return found;
  }
  private global(name: string): V {
    const found = this.globals.get(name);
    if (found?.address === undefined) { throw new Error(`缺少 RTOS 符号 ${name}`); }
    return found;
  }
  private async scalar(v: V): Promise<number> { return uint(await this.read(v.address!, v.byteWidth), 0, v.byteWidth); }
  async current(): Promise<number> { return this.scalar(this.currentSymbol); }
  private async struct(address: number, layout: V): Promise<Buffer> { validPointer(address); return this.read(address, span(layout)); }
  private async name(address: number): Promise<string> {
    if (!address) { return '(unnamed)'; }
    // Small chunks stop at NUL without crossing arbitrarily far into target memory.
    const chunks: Buffer[] = [];
    for (let i = 0; i < 128; i += 16) {
      const bytes = await this.read(address + i, 16); const end = bytes.indexOf(0);
      chunks.push(end < 0 ? bytes : bytes.subarray(0, end)); if (end >= 0) { break; }
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  async snapshot(): Promise<ThreadSnapshot> {
    const current = await this.current();
    const threads = this.rtos === 'ThreadX' ? await this.threadX(current) : await this.freeRtos(current);
    return { rtos: this.rtos, threads, current, notes: ['运行中读取为非原子快照；状态可能在读取期间变化。栈已用按保存的 SP 估算，不是高水位。'] };
  }
  private async threadX(current: number): Promise<ThreadInfo[]> {
    const head = await this.scalar(this.global('_tx_thread_created_ptr'));
    const count = await this.scalar(this.global('_tx_thread_created_count'));
    if (count > 256) { throw new Error('线程数超过 256 或线程链表正在变化'); }
    const result: ThreadInfo[] = []; const visited = new Set<number>(); let address = head;
    for (let i = 0; i < count; i++) {
      if (!address || visited.has(address)) { throw new Error('ThreadX 链表发生变化，请刷新重试'); }
      visited.add(address); const b = await this.struct(address, this.tcb);
      if (value(b, this.tcb, 'tx_thread_id') !== 0x54485244) { throw new Error('ThreadX 控制块标识无效；请检查 ELF 是否与固件一致'); }
      const state = value(b, this.tcb, 'tx_thread_state');
      const start = value(b, this.tcb, 'tx_thread_stack_start'); const size = value(b, this.tcb, 'tx_thread_stack_size');
      const sp = value(b, this.tcb, 'tx_thread_stack_ptr');
      const counter = optional(b, this.tcb, 'tx_thread_execution_time_total');
      result.push({ address, name: await this.name(value(b, this.tcb, 'tx_thread_name')), state: address === current ? 'Running' : txStates[state] ?? `State ${state}`,
        priority: value(b, this.tcb, 'tx_thread_priority'), stackBytes: size,
        stackUsed: sp >= start && sp <= start + size ? start + size - sp : undefined,
        runs: optional(b, this.tcb, 'tx_thread_run_count'), counter,
        counterBits: counter === undefined ? undefined : field(this.tcb, 'tx_thread_execution_time_total').byteWidth * 8 });
      address = value(b, this.tcb, 'tx_thread_created_next');
    }
    if (count && address !== head || head !== await this.scalar(this.global('_tx_thread_created_ptr')) || count !== await this.scalar(this.global('_tx_thread_created_count'))) {
      throw new Error('ThreadX 线程链表正在变化，请刷新重试');
    }
    return result;
  }
  private async freeRtos(current: number): Promise<ThreadInfo[]> {
    const list = this.layout('xLIST', 'List_t'); const item = this.layout('xLIST_ITEM', 'ListItem_t');
    const tasks = new Map<number, string>();
    const lists: Array<{ address: number; state: string }> = [];
    const ready = this.global('pxReadyTasksLists');
    if (!ready.children.length || ready.children.length > 256) { throw new Error('FreeRTOS 就绪列表数组信息缺失或优先级数超过 256'); }
    for (const v of ready.children) { lists.push({ address: v.address!, state: 'Ready' }); }
    for (const [name, state] of [['xDelayedTaskList1', 'Blocked'], ['xDelayedTaskList2', 'Blocked'], ['xSuspendedTaskList', 'Suspended / indefinite wait'], ['xTasksWaitingTermination', 'Deleted']]) {
      const v = this.globals.get(name); if (v?.address !== undefined) { lists.push({ address: v.address, state }); }
    }
    for (const entry of lists) {
      const b = await this.struct(entry.address, list); const count = value(b, list, 'uxNumberOfItems');
      if (count > 256) { throw new Error('FreeRTOS 列表长度异常或正在变化'); }
      const end = field(list, 'xListEnd'); const next = field(end, 'pxNext');
      let pointer = uint(b, next.address!, next.byteWidth); const seen = new Set<number>();
      for (let i = 0; i < count; i++) {
        if (pointer === entry.address + end.address! || seen.has(pointer)) { throw new Error('FreeRTOS 列表发生变化，请重试'); }
        seen.add(pointer); const node = await this.struct(pointer, item); const owner = value(node, item, 'pvOwner');
        validPointer(owner); tasks.set(owner, entry.state); pointer = value(node, item, 'pxNext');
        if (tasks.size > 256) { throw new Error('线程数超过 256'); }
      }
      if (pointer !== entry.address + end.address!) { throw new Error('FreeRTOS 列表发生变化，请重试'); }
    }
    if (current) { tasks.set(current, 'Running'); }
    const result: ThreadInfo[] = [];
    for (const [address, state] of tasks) {
      const b = await this.struct(address, this.tcb); const name = field(this.tcb, 'pcTaskName');
      const size = name.children.length || name.byteWidth;
      const rawName = b.subarray(name.address!, name.address! + size); const nul = rawName.indexOf(0);
      const start = value(b, this.tcb, 'pxStack'); const end = optional(b, this.tcb, 'pxEndOfStack'); const sp = value(b, this.tcb, 'pxTopOfStack');
      const counter = optional(b, this.tcb, 'ulRunTimeCounter');
      result.push({ address, state, name: rawName.subarray(0, nul < 0 ? rawName.length : nul).toString('utf8'), priority: value(b, this.tcb, 'uxPriority'),
        stackBytes: end !== undefined && end >= start ? end + 4 - start : undefined,
        stackUsed: end !== undefined && sp >= start && sp <= end + 4 ? end + 4 - sp : undefined,
        counter, counterBits: counter === undefined ? undefined : field(this.tcb, 'ulRunTimeCounter').byteWidth * 8 });
    }
    return result;
  }
}

/** A rolling distribution of observed current-thread pointers, not a cycle-accurate CPU meter. */
export class OccupancySamples {
  private samples: Array<{ at: number; address: number }> = [];
  add(at: number, address: number): void { this.samples.push({ at, address }); this.prune(at); }
  private prune(at: number): void { this.samples = this.samples.filter(s => s.at >= at - 30000); }
  distribution(at: number): { count: number; seconds: number; shares: Map<number, number> } {
    this.prune(at); const shares = new Map<number, number>();
    for (const s of this.samples) { shares.set(s.address, (shares.get(s.address) ?? 0) + 100 / this.samples.length); }
    return { count: this.samples.length, seconds: this.samples.length ? (at - this.samples[0].at) / 1000 : 0, shares };
  }
  clear(): void { this.samples = []; }
}

/** Relative share of completed per-thread runtime deltas; excludes unaccounted ISR/idle time. */
export class RuntimeShares {
  private previous = new Map<number, { name: string; counter: number }>();
  update(threads: ThreadInfo[]): Map<number, number> {
    const deltas = new Map<number, number>(); let valid = this.previous.size === threads.length;
    for (const t of threads) {
      const old = this.previous.get(t.address);
      if (t.counter === undefined || !old || old.name !== t.name) { valid = false; continue; }
      let delta = t.counter - old.counter;
      if (delta < 0 && t.counterBits === 32 && old.counter > 0xf0000000 && t.counter < 0x10000000) { delta += 2 ** 32; }
      if (delta < 0) { valid = false; } else { deltas.set(t.address, delta); }
    }
    this.previous = new Map(threads.filter(t => t.counter !== undefined).map(t => [t.address, { name: t.name, counter: t.counter! }]));
    const total = [...deltas.values()].reduce((a, b) => a + b, 0);
    return valid && total > 0 ? new Map([...deltas].map(([id, n]) => [id, n / total * 100])) : new Map();
  }
}
