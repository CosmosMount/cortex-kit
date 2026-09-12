import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { PlotViewProvider } from './plots';
import { OccupancySamples, RtosInspector, ThreadSnapshot } from './rtosModel';

export class ThreadsView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private inspector?: RtosInspector;
  private sessionId?: string;
  private timer?: NodeJS.Timeout;
  private busy = false;
  private generation = 0;
  private halted = true;
  private enabled = true;
  private hz = 10;
  private lastSnapshot = 0;
  private snapshot?: ThreadSnapshot;
  private samples = new OccupancySamples();

  private subscriptions: vscode.Disposable[];
  constructor(private readonly context: vscode.ExtensionContext, private readonly plots: PlotViewProvider) {
    this.subscriptions = [plots.onDidChangeSession(() => this.reset()), vscode.debug.onDidReceiveDebugSessionCustomEvent(e => {
      if (e.session.id !== this.plots.session?.id || e.event !== 'cortexKit.state') { return; }
      const halted = !['running', 'sleeping'].includes(e.body?.targetState);
      if (this.halted !== halted) { this.samples.clear(); this.lastSnapshot = 0; }
      this.halted = halted;
    })];
  }
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    const nonce = randomBytes(16).toString('hex');
    const script = view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'threads.js'));
    view.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:12px}header{display:flex;gap:12px;align-items:center;flex-wrap:wrap}h3{margin:0}button,select{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:1px solid var(--vscode-input-border);padding:5px 10px}select{background:var(--vscode-input-background);color:var(--vscode-input-foreground)}#status{margin:12px 0}#note{color:var(--vscode-descriptionForeground);line-height:1.6}table{border-collapse:collapse;width:100%;white-space:nowrap}th,td{padding:8px 12px;text-align:left;border-bottom:1px solid var(--vscode-panel-border)}th{color:var(--vscode-descriptionForeground)}.table{overflow:auto}tr.running{background:var(--vscode-list-inactiveSelectionBackground)}.error{color:var(--vscode-errorForeground)}
</style></head><body><header><h3>Threads</h3><button id="refresh">刷新</button><label><input type="checkbox" id="auto" checked>自动刷新</label><label>占用抽样 <select id="rate"><option value="2">2 Hz</option><option value="10" selected>10 Hz</option><option value="20">20 Hz</option></select></label><button id="reset">重置统计</button></header><div id="status">连接 Cortex Kit 调试 / Live Plot 会话后自动识别 ThreadX / FreeRTOS。</div><div class="table"><table><thead><tr><th>线程</th><th>状态</th><th>优先级</th><th>运行占比 · 抽样估算</th><th>栈已用 / 分配 (B)</th><th title="栈已用 ÷ 栈分配量 × 100%，按保存的 SP 估算">栈内存占用</th><th>调度次数</th><th>TCB 地址</th></tr></thead><tbody id="rows"></tbody></table></div><p id="note">占用统计仅在此标签可见且目标运行时采集。抽样统计最近 30 秒观察到的当前线程，不等同于精确 CPU 利用率。</p><script nonce="${nonce}" src="${script}"></script></body></html>`;
    this.subscriptions.push(view.onDidChangeVisibility(() => { this.samples.clear(); this.lastSnapshot = 0; if (view.visible) { void this.tick(true); } else { this.cancelTimer(); } }),
      view.onDidDispose(() => { this.view = undefined; this.reset(); }),
      view.webview.onDidReceiveMessage(m => {
        if (m.command === 'ready' || m.command === 'refresh') { this.lastSnapshot = 0; void this.tick(true); }
        if (m.command === 'auto') { this.enabled = Boolean(m.value); this.samples.clear(); this.cancelTimer(); if (this.enabled) { void this.tick(true); } }
        if (m.command === 'rate' && [2, 10, 20].includes(m.value)) { this.hz = m.value; this.samples.clear(); }
        if (m.command === 'reset') { this.samples.clear(); this.lastSnapshot = 0; void this.tick(true); }
      }));
    void this.tick(true);
  }
  private cancelTimer(): void { if (this.timer) { clearTimeout(this.timer); this.timer = undefined; } }
  private reset(): void {
    this.generation++; this.cancelTimer(); this.inspector = undefined; this.sessionId = undefined; this.snapshot = undefined;
    this.samples.clear(); this.lastSnapshot = 0; this.halted = true;
    if (this.view?.visible) { void this.tick(true); }
  }
  private async tick(force = false): Promise<void> {
    if (this.busy || !this.view?.visible || !this.enabled && !force) { return; }
    this.cancelTimer(); this.busy = true; let failed = false; const generation = this.generation; const session = this.plots.session;
    try {
      if (!session) { this.post({ status: '未连接：启动 Cortex Kit 调试 / Live Plot 会话后自动识别 ThreadX / FreeRTOS。', rows: [] }); return; }
      if (!this.inspector || this.sessionId !== session.id) {
        const catalog = await session.customRequest('cortexKit/getCatalog');
        const types = await session.customRequest('cortexKit/getRtosLayouts');
        const state = await session.customRequest('cortexKit/getState');
        if (generation !== this.generation) { return; }
        this.halted = !['running', 'sleeping'].includes(state.targetState);
        this.inspector = new RtosInspector(catalog.variables, types.layouts, async (address, length) => {
          if (generation !== this.generation || this.plots.session?.id !== session.id || !this.view?.visible) { throw new Error('线程读取已取消'); }
          if (!Number.isSafeInteger(address) || address < 0 || address + length > 2 ** 32 || length < 1 || length > 8192) { throw new Error('RTOS 内存请求越界'); }
          const result = await session.customRequest('readMemory', { memoryReference: `0x${address.toString(16)}`, count: length });
          const bytes = Buffer.from(result.data ?? '', 'base64');
          if (bytes.length !== length || result.unreadableBytes) { throw new Error('无法完整读取线程内存'); }
          return bytes;
        });
        this.sessionId = session.id;
      }
      if (this.enabled && !this.halted) {
        const address = await this.inspector.current();
        if (generation !== this.generation) { return; }
        if (!this.halted) { this.samples.add(Date.now(), address); }
      }
      if (force || Date.now() - this.lastSnapshot >= 1000) {
        const snapshot = await this.inspector.snapshot();
        if (generation !== this.generation) { return; }
        this.snapshot = snapshot; this.lastSnapshot = Date.now();
        const distribution = this.samples.distribution(Date.now());

        const known = new Set(snapshot.threads.map(t => t.address));
        const unknown = [...distribution.shares].filter(([address]) => !known.has(address)).reduce((sum, [, share]) => sum + share, 0);
        this.post({ status: `${snapshot.rtos} · ${snapshot.threads.length} 个线程 · ${this.halted ? '目标已暂停' : '运行中'} · ${distribution.count} 次抽样 / ${distribution.seconds.toFixed(1)} 秒 · 无线程/未识别 ${unknown.toFixed(1)}%`,
          rows: snapshot.threads.map(t => ({ ...t, sampled: distribution.count ? distribution.shares.get(t.address) ?? 0 : undefined })),
          note: `${snapshot.notes.join(' ')} 抽样占比是最近 30 秒的当前线程观察比例，包含线程被中断期间的观察，短任务可能漏采。FreeRTOS 未记录栈高地址时分配量显示 —。隐藏标签停止读取。` });
      }
    } catch (error) {
      failed = true;
      if (generation === this.generation) { this.post({ status: error instanceof Error ? error.message : String(error), error: true, rows: [] }); this.lastSnapshot = 0; }
    } finally {
      this.busy = false;
      if (this.view?.visible && this.enabled) {
        // Jitter reduces lockstep aliasing with periodic firmware tasks; never queue overlapping reads.
        this.timer = setTimeout(() => void this.tick(), !failed && this.inspector ? 1000 / this.hz * (0.8 + Math.random() * 0.4) : 2000);
      }
    }
  }
  private post(message: unknown): void { void this.view?.webview.postMessage(message); }
  dispose(): void { this.view = undefined; this.generation++; this.cancelTimer(); this.subscriptions.forEach(d => d.dispose()); }
}
