import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { isPlottableVariable } from './plotModel';
import { PlotViewProvider } from './plots';
import { csvCurves, csvHeader, csvRows, CsvTable, defaultTimeColumn, FrameSampler, parseCsv, RecordedRow, reducePoints, timeScale, validateSampleRate } from './recordingModel';
import { SampleBatch } from './types';

interface Recording {
  sampler: FrameSampler; stream: fs.WriteStream; uri: vscode.Uri; names: string[];
  ready: boolean; preview: RecordedRow[]; droppedStart?: number; dropped: number; timer?: NodeJS.Timeout;
}

/** A docked view in the Cortex Kit bottom panel; shares the existing sample socket. */
export class SampleRecorder implements vscode.WebviewViewProvider, vscode.Disposable {
  private panel?: vscode.WebviewView;
  private selectedIds: string[];
  private requestedHz: number;
  private durationSeconds = 10;
  private recording?: Recording;
  private busy = false;
  private status = '选择变量后开始记录，或导入 CSV 离线查看曲线。';
  private error = false;
  private file?: vscode.Uri;
  private imported?: CsvTable;
  private timeColumn = 0;
  private scale = 1;
  private columns: number[] = [];
  private lastStats = { rows: 0, actualHz: 0, elapsedSeconds: 0, dropped: 0 };
  private readonly subscriptions: vscode.Disposable[];
  private readonly refreshTimer: NodeJS.Timeout;
  private dirty = false;
  private stopping?: Promise<void>;

  constructor(private readonly context: vscode.ExtensionContext, private readonly plots: PlotViewProvider) {
    this.selectedIds = context.workspaceState.get<string[]>('cortexKit.recorder.variables', []);
    this.requestedHz = context.workspaceState.get<number>('cortexKit.recorder.rate', 1000);
    this.subscriptions = [
      plots.onDidReceiveSamples(batch => this.acceptBatch(batch)),
      plots.onDidReceiveStreamError(error => { if (this.recording) { void this.stop(error, true); } }),
      plots.onDidChangeSession(() => {
        if (this.recording) { void this.stop('目标会话已结束或切换，记录已保存。'); }
        this.snapshot();
      }),
    ];
    this.refreshTimer = setInterval(() => { if (this.dirty) { this.dirty = false; this.sendPreview(); this.snapshot(); } }, 250);
  }
  get isRecording(): boolean { return Boolean(this.recording || this.busy || this.stopping); }
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
      if (view.visible) { this.snapshot(); if (this.imported) { this.sendImported(); } else { this.sendPreview(); } }
    });
    view.onDidDispose(() => { if (this.panel === view) { this.panel = undefined; void this.stop('采样视图已关闭，记录已保存。'); } });
  }
  private post(message: unknown): void { void this.panel?.webview.postMessage(message); }
  private snapshot(): void {
    const catalog = new Map(this.plots.getVariables().map(item => [item.id, item]));
    const recording = this.recording;
    const stats = recording ? { rows: recording.sampler.count, actualHz: recording.sampler.actualHz, elapsedSeconds: recording.sampler.elapsedSeconds, dropped: recording.dropped } : this.lastStats;
    this.post({ type: 'state', recording: Boolean(recording), busy: this.busy || Boolean(this.stopping),
      connected: Boolean(this.plots.session), selected: this.selectedIds.map(id => catalog.get(id)?.expression ?? id),
      requestedHz: this.requestedHz, durationSeconds: this.durationSeconds, status: this.status, error: this.error,
      file: this.file?.fsPath, ...stats,
      imported: this.imported ? { headers: this.imported.headers, rows: this.imported.rows.length, timeColumn: this.timeColumn, scale: this.scale, columns: this.columns } : undefined,
    });
  }
  private fail(error: unknown): void {
    this.error = true;
    this.status = error instanceof Error ? error.message : String(error);
    this.snapshot();
  }
  private async handle(message: Record<string, unknown>): Promise<void> {
    if (message.type === 'ready') { this.snapshot(); if (this.imported) { this.sendImported(); } else { this.sendPreview(); } return; }
    if (message.type === 'stop') { await this.stop(); return; }
    if (message.type === 'reveal' && this.file) { await vscode.commands.executeCommand('revealFileInOS', this.file); return; }
    if (message.type === 'view' && this.imported && !this.isRecording) {
      const timeColumn = Number(message.timeColumn), scale = Number(message.scale);
      const columns = Array.isArray(message.columns) ? message.columns.map(Number) : [];
      const range = Array.isArray(message.range) && message.range.length === 2 && message.range.every(Number.isFinite)
        ? message.range.map(Number) as [number, number] : undefined;
      const curves = csvCurves(this.imported, timeColumn, scale, columns, range);
      this.timeColumn = timeColumn; this.scale = scale; this.columns = columns;
      this.error = false; this.status = '已更新曲线。滚轮缩放、拖动平移，悬停查看最近的预览样本。';
      const elapsedSeconds = (this.imported.rows.at(-1)![timeColumn]! - this.imported.rows[0][timeColumn]!) * scale;
      this.lastStats = { ...this.lastStats, elapsedSeconds, actualHz: elapsedSeconds > 0 ? (this.imported.rows.length - 1) / elapsedSeconds : 0 };
      this.post({ type: 'curves', curves, live: false, preserveRange: Boolean(range) });
      this.snapshot();
      return;
    }
    if (this.isRecording) { return; }
    if (message.type === 'select') {
      this.busy = true; this.snapshot();
      try { await this.selectVariables(); } finally { this.busy = false; this.snapshot(); }
    }
    if (message.type === 'start') { await this.start(Number(message.rate), Number(message.duration)); }
    if (message.type === 'import') { await this.importCsv(); }
  }
  private async selectVariables(): Promise<void> {
    const items = this.plots.getVariables().filter(item => isPlottableVariable(item) && !item.id.startsWith('expr:')).map(variable => ({
      label: variable.expression, description: `${variable.typeName} · 0x${variable.address?.toString(16)}`,
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
  private async start(rate: number, duration: number): Promise<void> {
    const panel = this.panel;
    if (!panel) { return; }
    validateSampleRate(rate);
    if (!Number.isFinite(duration) || duration < 0 || duration > 86400) { throw new Error('记录时长应为 0–86400 秒；0 表示手动停止。'); }
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
        if (!variable || variable.address === undefined) { throw new Error(`当前固件不包含变量 ${id}，请重新选择。`); }
        return variable.expression;
      });
      const uri = await vscode.window.showSaveDialog({ title: '保存带时间戳的采样 CSV', filters: { CSV: ['csv'] },
        defaultUri: vscode.Uri.joinPath(session.workspaceFolder?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(require('node:os').homedir()), `samples-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`) });
      if (!uri || this.panel !== panel) { return; }
      if (uri.scheme !== 'file') { throw new Error('连续采样请选择本机文件路径。'); }
      if (this.plots.session?.id !== session.id) { throw new Error('目标会话已变化，请重新开始。'); }
      this.requestedHz = rate; this.durationSeconds = duration;
      await this.context.workspaceState.update('cortexKit.recorder.rate', rate);
      if (this.panel !== panel) { return; }
      const stream = fs.createWriteStream(uri.fsPath, { encoding: 'utf8' });
      const recording: Recording = { sampler: new FrameSampler([...this.selectedIds], rate), stream, uri, names, ready: false, preview: [], dropped: 0 };
      // Keep an error listener installed after stop as a late disk error must never crash the extension host.
      stream.on('error', error => { if (this.recording === recording) { void this.stop(`CSV 写入失败：${error.message}`, true); } else { this.fail(error); } });
      this.recording = recording; this.file = uri; this.imported = undefined;
      this.post({ type: 'clear' });
      await new Promise<void>((resolve, reject) => { stream.once('open', () => resolve()); stream.once('error', reject); });
      stream.write(csvHeader(names));
      await this.plots.setRecordingSubscription(this.selectedIds, rate);
      if (this.recording !== recording || this.plots.session?.id !== session.id) { throw new Error('记录启动时会话已结束。'); }
      recording.ready = true;
      if (duration > 0) { recording.timer = setTimeout(() => { void this.stop('已达到设定时长，CSV 已保存。'); }, duration * 1000); }
      this.status = '正在记录到 CSV；实际频率取决于硬件吞吐。暂停目标时保留时间间隔。';
    } catch (error) {
      if (this.recording) { await this.stop(error instanceof Error ? error.message : String(error), true); }
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
  private acceptBatch(batch: SampleBatch): void {
    const recording = this.recording;
    if (!recording?.ready) { return; }
    try {
      if (recording.stream.writableLength > 8 * 1024 * 1024) { throw new Error('磁盘写入跟不上采样，已停止记录并保存已接收数据。'); }
      const rows = recording.sampler.accept(batch);
      if (!rows.length) { return; }
      recording.droppedStart ??= batch.droppedFrames;
      recording.dropped = Math.max(0, batch.droppedFrames - recording.droppedStart);
      recording.stream.write(csvRows(rows));
      recording.preview.push(...rows);
      if (recording.preview.length > 4000) { recording.preview.splice(0, recording.preview.length - 4000); }
      this.dirty = true;
    } catch (error) { void this.stop(error instanceof Error ? error.message : String(error), true); }
  }
  private async stop(message = '记录已停止，CSV 已保存。', failed = false): Promise<void> {
    if (this.stopping) { return this.stopping; }
    const recording = this.recording;
    if (!recording) { return; }
    this.sendPreview();
    this.recording = undefined;
    clearTimeout(recording.timer);
    this.lastStats = { rows: recording.sampler.count, actualHz: recording.sampler.actualHz, elapsedSeconds: recording.sampler.elapsedSeconds, dropped: recording.dropped };
    this.stopping = (async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          if (recording.stream.destroyed) { resolve(); return; }
          recording.stream.once('error', reject); recording.stream.end(resolve);
        });
        this.status = recording.sampler.count ? message : '记录已结束，未收到样本（CSV 仅有表头）。请确认目标正在运行。';
        this.error = failed;
      } catch (error) { this.fail(error); }
      finally {
        try { await this.plots.setRecordingSubscription([]); } catch (error) { this.fail(error); }
        this.stopping = undefined; this.snapshot();
      }
    })();
    this.snapshot();
    return this.stopping;
  }
  private sendPreview(): void {
    const recording = this.recording;
    if (!recording?.preview.length) { return; }
    const limit = Math.max(100, Math.floor(12000 / recording.names.length));
    this.post({ type: 'curves', live: true, curves: recording.names.map((name, index) => ({ name,
      points: reducePoints(recording.preview.flatMap((row, i): Array<[number, number | null]> => {
        const point: [number, number | null] = [row.elapsedSeconds, Number.isFinite(row.values[index]) ? row.values[index] : null];
        return i > 0 && row.streamEpoch !== recording.preview[i - 1].streamEpoch ? [[row.elapsedSeconds, null], point] : [point];
      }), limit),
    })) });
  }
  private async importCsv(): Promise<void> {
    const chosen = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { CSV: ['csv'] }, title: '导入时间序列 CSV' });
    if (!chosen?.[0]) { return; }
    this.busy = true; this.snapshot();
    try {
      const info = await vscode.workspace.fs.stat(chosen[0]);
      if (info.size > 64 * 1024 * 1024) { throw new Error('导入 CSV 最大支持 64 MB。'); }
      const table = parseCsv(Buffer.from(await vscode.workspace.fs.readFile(chosen[0])).toString('utf8'));
      const timeColumn = defaultTimeColumn(table.headers);
      const scale = timeScale(table.headers[timeColumn]);
      const columns = table.headers.map((_, index) => index).filter(index => index !== timeColumn && !['timestamp_ns', 'stream_epoch'].includes(table.headers[index]) && table.rows.some(row => row[index] !== null));
      if (!columns.length) { throw new Error('CSV 没有可绘制的数值列。'); }
      // Validate before replacing the existing chart.
      const initialCurves = csvCurves(table, timeColumn, scale, columns.slice(0, 8));
      const elapsedSeconds = initialCurves[0]?.points.at(-1)?.[0] ?? 0;
      this.lastStats = { rows: table.rows.length, actualHz: elapsedSeconds > 0 ? (table.rows.length - 1) / elapsedSeconds : 0, elapsedSeconds, dropped: 0 };
      this.imported = table; this.timeColumn = timeColumn; this.scale = scale; this.columns = columns.slice(0, 8); this.file = chosen[0];
      this.status = `已导入 ${table.rows.length.toLocaleString()} 行；选择时间列、单位和曲线，可缩放查看局部。`;
      this.error = false; this.post({ type: 'clear' }); this.snapshot(); this.sendImported();
    } finally { this.busy = false; this.snapshot(); }
  }
  private sendImported(): void {
    if (this.imported) { this.post({ type: 'curves', live: false, curves: csvCurves(this.imported, this.timeColumn, this.scale, this.columns) }); }
  }
}

export function recorderHtml(webview: vscode.Webview, media: vscode.Uri): string {
  const nonce = require('node:crypto').randomBytes(16).toString('hex');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'recorder.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'recorder.css'));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${style}"></head><body>
  <header><div><span class="eyebrow">CORTEX KIT</span><h1>采样记录 / CSV 曲线</h1></div><div class="window-actions"><span id="connection" class="badge">未连接</span></div></header>
  <section class="controls" aria-label="采样设置"><button id="select">选择变量 <span id="selected-count">0</span></button><label>采样频率 <div><input id="rate" type="number" min="1" max="100000" step="1" value="1000"><span>S/s</span></div></label><label>记录时长 <div><input id="duration" type="number" min="0" max="86400" step="1" value="10"><span>秒 · 0 为手动</span></div></label><button id="start" class="primary">● 开始记录</button><button id="stop" disabled>■ 停止并保存</button><button id="import">导入 CSV</button></section>
  <div id="selected" class="selected" title="采样变量">尚未选择采样变量</div>
  <section class="stats"><div><small>实际记录频率</small><strong id="actual">—</strong></div><div><small>已记录样本 / 行</small><strong id="rows">0</strong></div><div><small>采样时间跨度</small><strong id="elapsed">0.000 s</strong></div><div><small>通道丢帧</small><strong id="dropped">0</strong></div></section>
  <div class="file-row"><span id="file">尚未选择文件</span><button id="reveal" disabled>打开所在文件夹</button></div><p id="status" role="status">选择变量后开始记录，或导入 CSV 离线查看曲线。</p>
  <section class="plot"><div class="plot-toolbar"><h2 id="plot-title">时间序列</h2><div id="csv-controls" hidden><label>时间列 <select id="time-column"></select></label><label>单位 <select id="unit"><option value="1">s</option><option value="0.001">ms</option><option value="0.000001">µs</option><option value="0.000000001">ns</option></select></label><button id="columns">选择曲线</button></div><button id="fit">显示全部</button><label><input type="checkbox" id="follow" checked>跟随最新</label></div><div id="column-picker" hidden></div><div id="legend"></div><div class="canvas-wrap"><canvas id="chart" aria-label="变量随时间变化曲线"></canvas><div id="empty">导入 CSV 或开始记录后，在这里查看曲线。<br><small>滚轮缩放 · 拖动平移 · 悬停读取数值</small></div><div id="tooltip" hidden></div></div><footer><span id="range">时间 / s</span><span>预览按像素抽稀保留峰值；CSV 保存记录的全部样本。</span></footer></section>
  <script nonce="${nonce}" src="${script}"></script></body></html>`;
}
