import * as vscode from 'vscode';
import { isPlottableVariable } from './plotModel';
import { PlotViewProvider } from './plots';
import { VariableDescriptor } from './types';
import { NativePreview } from './nativeData';

/** A docked view backed exclusively by the Rust data core. */
export class SampleRecorder implements vscode.WebviewViewProvider, vscode.Disposable {
  private nativeRecording = false;
  private nativePolling = false;
  private nativeLastPreview?: NativePreview;
  private async refreshNative(): Promise<void> {
    if (!this.nativeRecording || this.nativePolling) return;
    this.nativePolling = true;
    try {
      const status = await this.plots.nativeRecordingStatus();
      if (!this.nativeRecording) return;
      this.lastStats = { rows: status.rows, actualHz: status.actualHz, elapsedSeconds: status.elapsedSeconds, dropped: status.dropped + status.overflowFrames };
      if (status.error) { this.error = true; this.status = status.error; }
      else if (status.connectionBreaks) { this.error = true; this.status = `采样链路中断 ${status.connectionBreaks} 次，缺失样本数未知；只记录实际收到的行。`; }
      if (this.panel?.visible) {
        // Display failure/overload does not stop or restart the writer.
        try { const preview = await this.plots.nativeRecordingPreview(); if (preview) { this.nativeLastPreview = preview; this.post({ type: 'curves', ...preview }); } }
        catch { /* Numeric recording status below remains available independently. */ }
      }
      if (!status.recording && !status.closing && this.nativeRecording && !this.stopping) {
        this.nativeRecording = false;
        if (!status.error) this.status = 'Rust 记录已结束并刷新到文件。';
        await this.plots.setRecordingSubscription([]);
      }
      this.snapshot();
    } catch (error) { this.fail(error); }
    finally { this.nativePolling = false; }
  }
  private stopNative(message: string, failed: boolean): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      try {
        const status = await this.plots.stopNativeRecording();
        this.lastStats = { rows: status.rows, actualHz: status.actualHz, elapsedSeconds: status.elapsedSeconds, dropped: status.dropped + status.overflowFrames };
        this.status = status.error || (status.rows ? message : '记录已结束，CSV 只有表头；未收到所选变量的实际样本。');
        this.error = failed || Boolean(status.error) || Boolean(status.connectionBreaks);
        if (!status.error && status.connectionBreaks) this.status += ` 链路中断 ${status.connectionBreaks} 次，缺失样本数未知。`;
      } catch (error) { this.fail(error); }
      finally {
        this.nativeRecording = false;
        try { await this.plots.setRecordingSubscription([]); } catch (error) { this.fail(error); }
        this.stopping = undefined; this.snapshot();
      }
    })();
    this.snapshot(); return this.stopping;
  }
  private panel?: vscode.WebviewView;
  private selectedIds: string[];
  private requestedHz: number;
  private busy = false;
  private status = '选择变量后开始记录；采样、抽样和 CSV 写入全部由 Rust 完成。';
  private error = false;
  private file?: vscode.Uri;
  private lastStats = { rows: 0, actualHz: 0, elapsedSeconds: 0, dropped: 0 };
  private readonly subscriptions: vscode.Disposable[];
  private readonly refreshTimer: NodeJS.Timeout;
  private stopping?: Promise<void>;

  constructor(private readonly context: vscode.ExtensionContext, private readonly plots: PlotViewProvider) {
    this.selectedIds = context.workspaceState.get<string[]>('cortexKit.recorder.variables', []);
    this.requestedHz = context.workspaceState.get<number>('cortexKit.recorder.rate', 1000);
    this.subscriptions = [
      plots.onDidChangeSession(() => {
        if (this.nativeRecording) { void this.stop('目标会话已结束或切换，记录已保存。'); }
        this.snapshot();
      }),
    ];
    this.refreshTimer = setInterval(() => { void this.refreshNative(); }, 250);
  }
  get isRecording(): boolean { return Boolean(this.nativeRecording || this.busy || this.stopping); }
  dispose(): void {
    clearInterval(this.refreshTimer);
    this.subscriptions.forEach(item => item.dispose());
    void this.stop('窗口已关闭，记录已保存。');

  }
  async open(): Promise<void> {
    await vscode.commands.executeCommand('cortexKit.sample.focus');
  }
  resolveWebviewView(view: vscode.WebviewView): void {
    this.panel = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = recorderHtml(view.webview, media);
    view.webview.onDidReceiveMessage(message => { void this.handle(message).catch(error => this.fail(error)); });
    view.onDidChangeVisibility(() => {
      if (view.visible) { this.snapshot(); this.sendPreview(); }
    });
    // Recording belongs to the extension/session, not to the disposable view.
    view.onDidDispose(() => { if (this.panel === view) { this.panel = undefined; } });
  }
  private post(message: unknown): void { void this.panel?.webview.postMessage(message); }
  private snapshot(): void {
    if (!this.panel?.visible) return;
    const catalog = new Map(this.plots.getVariables().map(item => [item.id, item]));
    this.post({ type: 'state', recording: this.nativeRecording, busy: this.busy || Boolean(this.stopping),
      connected: Boolean(this.plots.session), selected: this.selectedIds.map(id => catalog.get(id)?.expression ?? id),
      requestedHz: this.requestedHz, status: this.status, error: this.error,
      file: this.file?.fsPath, ...this.lastStats,
    });
  }
  private fail(error: unknown): void {
    this.error = true;
    this.status = error instanceof Error ? error.message : String(error);
    this.snapshot();
  }
  private async handle(message: Record<string, unknown>): Promise<void> {
    if (message.type === 'ready') { this.snapshot(); this.sendPreview(); return; }
    if (message.type === 'stop') { await this.stop(); return; }
    if (message.type === 'reveal' && this.file) { await vscode.commands.executeCommand('revealFileInOS', this.file); return; }
    if (this.isRecording) { return; }
    if (message.type === 'select') {
      this.busy = true; this.snapshot();
      try { await this.selectVariables(); } finally { this.busy = false; this.snapshot(); }
    }
    if (message.type === 'start') { await this.start(Number(message.rate)); }
  }
  private async selectVariables(): Promise<void> {
    const items = this.plots.getVariables().filter(item => isPlottableVariable(item) && !item.id.startsWith('expr:')).map(variable => ({
      label: variable.expression, description: `${variable.typeName} · ${variableLocation(variable)}`,
      picked: this.selectedIds.includes(variable.id), variable,
    }));
    if (!items.length) { throw new Error('尚无变量目录。请先配置含调试信息的 ELF，或启动 Cortex Kit 会话。'); }
    const chosen = await vscode.window.showQuickPick(items, { canPickMany: true, matchOnDescription: true, placeHolder: '选择 CSV 采样变量（最多 64 个；每列一个变量）' });
    if (!chosen) { return; }
    if (chosen.length > 64) { throw new Error('一次最多记录 64 个变量。'); }
    this.selectedIds = chosen.map(item => item.variable.id);
    await this.context.workspaceState.update('cortexKit.recorder.variables', this.selectedIds);
    this.snapshot();
  }
  private async start(rate: number): Promise<void> {
    const panel = this.panel;
    if (!panel) { return; }
    validateRecordingRate(rate);
    this.busy = true; this.error = false; this.snapshot();
    try {
      if (!this.selectedIds.length) { await this.selectVariables(); }
      if (!this.selectedIds.length || this.panel !== panel) { return; }
      if (!this.plots.session) { await this.attach(); }
      if (this.panel !== panel) { return; }
      const session = this.plots.session;
      if (!session) { throw new Error('未连接目标，请先启动 Cortex Kit 会话。'); }
      const catalog = new Map(this.plots.getVariables().map(item => [item.id, item]));
      const names = this.selectedIds.map(id => {
        const variable = catalog.get(id);
        if (!variable || !isPlottableVariable(variable)) { throw new Error(`当前固件不包含变量 ${id}，请重新选择。`); }
        return variable.expression;
      });
      const uri = await vscode.window.showSaveDialog({ title: '保存带时间戳的采样 CSV', filters: { CSV: ['csv'] },
        defaultUri: vscode.Uri.joinPath(session.workspaceFolder?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(require('node:os').homedir()), `samples-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`) });
      if (!uri || this.panel !== panel) { return; }
      if (uri.scheme !== 'file') { throw new Error('连续采样请选择本机文件路径。'); }
      if (this.plots.session?.id !== session.id) { throw new Error('目标会话已变化，请重新开始。'); }
      this.requestedHz = rate;
      await this.context.workspaceState.update('cortexKit.recorder.rate', rate);
      if (this.panel !== panel) { return; }
      this.file = uri; this.nativeLastPreview = undefined;
      this.lastStats = { rows: 0, actualHz: 0, elapsedSeconds: 0, dropped: 0 };
      await this.plots.startNativeRecording({ path: uri.fsPath, ids: [...this.selectedIds], names, rate });
      this.nativeRecording = true;
      this.post({ type: 'clear' });
      await this.plots.setRecordingSubscription(this.selectedIds, rate);
      if (this.plots.session?.id !== session.id) throw new Error('目标会话在 Rust 记录启动期间改变。');
      this.status = 'Rust 独立线程持续写入 CSV；关闭 Plot 或 Sample 面板不停止记录。';
    } catch (error) {
      if (this.nativeRecording) { await this.stop(error instanceof Error ? error.message : String(error), true); }
      throw error;
    } finally { this.busy = false; this.snapshot(); }
  }
  private async attach(): Promise<void> {
    const options = (vscode.workspace.workspaceFolders ?? []).flatMap(folder =>
      vscode.workspace.getConfiguration('launch', folder.uri).get<vscode.DebugConfiguration[]>('configurations', [])
        .filter(config => config.type === 'cortex-kit').map(config => ({ label: config.name, description: folder.name, config, folder })));
    if (!options.length) { throw new Error('请先运行 Cortex Kit: Configure Project 或启动 Mock Debug，再开始记录。'); }
    const preferred = options.filter(option => option.config.request === 'attach');
    const candidates = preferred.length ? preferred : options;
    const selected = candidates.length === 1 ? candidates[0] : await vscode.window.showQuickPick(candidates, { placeHolder: '选择采样目标（仅附加，不刷写或复位）' });
    if (!selected) { return; }
    const config = { ...selected.config, name: 'Cortex Kit: Sample / CSV', request: 'attach', plotOnly: true,
      stopOnEntry: false, flashing: { enabled: false, verify: false, resetAfter: false } };
    delete (config as vscode.DebugConfiguration).preLaunchTask; delete (config as vscode.DebugConfiguration).postDebugTask;
    const connected = await vscode.debug.startDebugging(selected.folder, config);
    if (!connected) { throw new Error('无法启动目标连接。'); }
    await this.plots.waitForDataChannel();
  }
  private async stop(message = '记录已停止，CSV 已保存。', failed = false): Promise<void> {
    if (!this.nativeRecording) return;
    return this.stopNative(message, failed);
  }
  private sendPreview(): void {
    if (this.nativeLastPreview) this.post({ type: 'curves', ...this.nativeLastPreview });
  }
}

function validateRecordingRate(rate: number): void {
  if (!Number.isInteger(rate) || rate < 1 || rate > 100_000) throw new Error('采样频率必须是 1–100000 之间的整数。');
}

function variableLocation(variable: VariableDescriptor): string {
  if (variable.address !== undefined) { return `0x${variable.address.toString(16)}`; }
  if (variable.pointerAddress !== undefined) {
    const offset = variable.pointerOffset ?? 0;
    return `*(0x${variable.pointerAddress.toString(16)})${offset ? ` + 0x${offset.toString(16)}` : ''}`;
  }
  return '<dynamic>';
}

export function recorderHtml(webview: vscode.Webview, media: vscode.Uri): string {
  const nonce = require('node:crypto').randomBytes(16).toString('hex');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'recorder.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'recorder.css'));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${style}"></head><body>
  <header><div><span class="eyebrow">CORTEX KIT</span><h1>采样记录 / CSV 曲线</h1></div><div class="window-actions"><span id="connection" class="badge">未连接</span></div></header>
  <section class="controls" aria-label="采样设置"><button id="select">选择变量 <span id="selected-count">0</span></button><label>采样频率 <div><input id="rate" type="number" min="1" max="100000" step="1" value="1000"><span>S/s</span></div></label><span>持续记录 · 手动停止</span><button id="start" class="primary">● 开始记录</button><button id="stop" disabled>■ 停止并保存</button></section>
  <div id="selected" class="selected" title="采样变量">尚未选择采样变量</div>
  <section class="stats"><div><small>实际记录频率</small><strong id="actual">—</strong></div><div><small>已记录样本 / 行</small><strong id="rows">0</strong></div><div><small>采样时间跨度</small><strong id="elapsed">0.000 s</strong></div><div><small>通道丢帧</small><strong id="dropped">0</strong></div></section>
  <div class="file-row"><span id="file">尚未选择文件</span><button id="reveal" disabled>打开所在文件夹</button></div><p id="status" role="status">选择变量后开始记录；采样、抽样和 CSV 写入全部由 Rust 完成。</p>
  <section class="plot"><div class="plot-toolbar"><h2 id="plot-title">Rust 实时预览</h2><button id="fit">显示全部</button><label><input type="checkbox" id="follow" checked>跟随最新</label></div><div id="legend"></div><div class="canvas-wrap"><canvas id="chart" aria-label="变量随时间变化曲线"></canvas><div id="empty">开始记录后，在这里查看 Rust 生成的预览。<br><small>滚轮缩放 · 拖动平移 · 悬停读取数值</small></div><div id="tooltip" hidden></div></div><footer><span id="range">时间 / s</span><span>Rust 预览按像素抽稀保留峰值；CSV 保存记录的全部样本。</span></footer></section>
  <script nonce="${nonce}" src="${script}"></script></body></html>`;
}
