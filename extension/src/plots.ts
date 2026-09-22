import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { NativeController } from './nativeController';
import { NativeRecordSpec, NativeRecordStatus, NativePreview } from './nativeData';
import { expressionDependencies } from './expression';
import { splitSubscriptions } from './liveWatchModel';
import { expandVariableSelections, expressionDescriptor, flattenVariables, isPlottableVariable, reorderCharts, resolveSubscriptionIds, restoreLayoutExpressions } from './plotModel';
import { ChartArrangement, ChartLayout, LiveWatchValue, SessionState, VariableDescriptor } from './types';

interface DataChannelInfo { port: number; token: string; protocolVersion: number; }

export class PlotViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly native: NativeController;
  private nativeRenderBusy = false;
  private nativeError(error: Error): void {
    this.post({ type: 'streamError', message: `Native data: ${error.message}` });
    this.streamError.fire(error.message);
  }
  private configureNative(): void {
    const rawIds = resolveSubscriptionIds(this.layouts, this.catalog);
    const wanted = new Set([...rawIds, ...this.layouts.flatMap(chart => chart.variableIds)]);
    // Do not serialize a full DWARF catalog on every configuration change.
    const catalog = this.catalog.filter(item => wanted.has(item.id)).map(({ id, name, expression }) => ({ id, name, expression }));
    this.native.update({ historySeconds: this.historySeconds(), charts: this.layouts.map(({ id, mode, variableIds }) => ({ id, mode, variableIds })), catalog, rawIds },
      this.liveWatchIds, vscode.workspace.getConfiguration('cortexKit').get('liveWatchRefreshRate', 20));
  }
  private async renderNative(message: Record<string, unknown>): Promise<void> {
    const requestId = message.requestId;
    if (typeof requestId !== 'string' || requestId.length > 128) return;
    if (this.nativeRenderBusy) { this.post({ type: 'nativeFrame', requestId, error: 'Native display busy' }); return; }
    const viewports = message.viewports;
    if (!Array.isArray(viewports) || viewports.length > 32 || viewports.some(v => !v || typeof v.id !== 'string' || v.id.length > 4096 || !Number.isInteger(v.columns) || v.columns < 1 || v.columns > 4096)) {
      this.post({ type: 'nativeFrame', requestId, error: 'Invalid native viewport request' }); return;
    }
    this.nativeRenderBusy = true; const view = this.view;
    try {
      const frame = await this.native.render(viewports);
      if (this.state && frame.sessionId && (frame.sessionId !== this.state.sessionId || frame.programGeneration !== this.state.programGeneration)) throw new Error('Waiting for the current target generation');
      if (this.view === view) this.post({ type: 'nativeFrame', requestId, frame });
    }
    catch (error) { if (this.view === view) this.post({ type: 'nativeFrame', requestId, error: String(error) }); }
    finally { this.nativeRenderBusy = false; }
  }
  async startNativeRecording(spec: NativeRecordSpec): Promise<void> {
    await this.native.startRecording(spec);
  }
  async stopNativeRecording(): Promise<NativeRecordStatus> {
    return this.native.stopRecording();
  }
  async nativeRecordingStatus(): Promise<NativeRecordStatus> {
    return this.native.recordingStatus();
  }
  async nativeRecordingPreview(): Promise<NativePreview | undefined> { return this.native.preview(); }
  private view?: vscode.WebviewView;
  private dataChannel?: DataChannelInfo;
  private layouts: ChartLayout[];
  private arrangement: ChartArrangement;
  private catalog: VariableDescriptor[];
  private state?: SessionState;
  private activeSession?: vscode.DebugSession;
  private liveWatchIds: string[] = [];
  private readonly liveWatchValues = new vscode.EventEmitter<LiveWatchValue[]>();
  readonly onDidReceiveLiveWatchValues = this.liveWatchValues.event;
  private lastSubscriptionKey?: string;
  private recording?: { ids: string[]; rate: number };
  private exporting = false;
  private exportRequest?: { id: string; timer: NodeJS.Timeout };
  private readonly sessionChanged = new vscode.EventEmitter<vscode.DebugSession | undefined>();
  readonly onDidChangeSession = this.sessionChanged.event;
  private readonly dataReady = new vscode.EventEmitter<void>();
  private readonly streamError = new vscode.EventEmitter<string>();
  readonly onDidReceiveStreamError = this.streamError.event;
  get session(): vscode.DebugSession | undefined { return this.activeSession; }
  getVariables(): VariableDescriptor[] { return this.catalog; }
  waitForDataChannel(timeoutMs = 30000): Promise<void> {
    if (this.dataChannel) { return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const listener = this.dataReady.event(() => { clearTimeout(timer); listener.dispose(); resolve(); });
      const timer = setTimeout(() => { listener.dispose(); reject(new Error('等待采样通道超时，请检查目标连接。')); }, timeoutMs);
    });
  }
  async setRecordingSubscription(ids: string[], rate = 1000): Promise<void> {
    this.recording = ids.length ? { ids: [...new Set(ids)], rate } : undefined;
    await this.updateSubscriptions(true);
  }

  constructor(private readonly context: vscode.ExtensionContext) {
    this.layouts = context.workspaceState.get<ChartLayout[]>('cortexKit.plots', [{ id: 'chart-1', title: 'Plot 1', mode: 'time', variableIds: [] }]);
    this.arrangement = context.workspaceState.get<ChartArrangement>('cortexKit.plotArrangement', 'grid');
    this.catalog = restoreLayoutExpressions(this.layouts);
    this.native = new NativeController(nativeBackendPath(context), latest => {
        // Already a latest-value snapshot at the configured display rate: do
        // not add a second timer and never enqueue Plot/CSV data ahead of it.
        if (this.state && (latest.sessionId !== this.state.sessionId || latest.programGeneration !== this.state.programGeneration)) return;
        // Rust owns epoch consistency and clears the snapshot atomically when
        // the target stream changes. DAP state events may arrive later, so
        // filtering here against UI state would temporarily discard fresh data.
        const values: LiveWatchValue[] = latest.values.map(item => {
          const timestampNs = Number(item.timestampNsExact);
          return { id: item.id, value: item.value ?? Number.NaN, source: 'stream' as const, actualSamplesPerSecond: item.actualSamplesPerSecond,
            ...(Number.isSafeInteger(timestampNs) ? { timestampNs } : {}) };
        });
        if (values.length) this.liveWatchValues.fire(values);
    }, error => this.nativeError(error));
    this.configureNative();
  }
  dispose(): void {
    void this.native.dispose();
    if (this.exportRequest) { clearTimeout(this.exportRequest.timer); }
    this.closeDataChannel(true);
    this.liveWatchValues.dispose();
    this.sessionChanged.dispose();
    this.dataReady.dispose();
    this.streamError.dispose();
  }
  setSession(session?: vscode.DebugSession): void {
    const changed = this.activeSession?.id !== session?.id;
    if (changed) { this.closeDataChannel(true); }
    this.activeSession = session;
    if (changed) { if (session) { this.clearHistory(); } this.lastSubscriptionKey = undefined; }
    if (!session) {
      this.state = undefined;
      this.post({ type: 'session', state: undefined });
      this.closeDataChannel(true);
    }
    if (changed) { this.recording = undefined; this.sessionChanged.fire(session); }
  }
  setCatalog(catalog: VariableDescriptor[]): void { const expressions = this.catalog.filter(item => item.id.startsWith('expr:')); this.catalog = [...flattenVariables(catalog), ...expressions]; this.post({ type: 'catalog', variables: this.catalog }); void this.updateSubscriptions(); }
  setLiveWatchIds(ids: string[]): void { this.liveWatchIds = [...new Set(ids)]; void this.updateSubscriptions(); }
  refreshSubscriptions(): Promise<void> { this.lastSubscriptionKey = undefined; return this.updateSubscriptions(); }
  private historySeconds(): number {
    const folder = this.activeSession?.workspaceFolder ?? vscode.workspace.workspaceFolders?.[0];
    const seconds = vscode.workspace.getConfiguration('cortexKit', folder?.uri).get<number>('historySeconds', 30);
    return Number.isFinite(seconds) && seconds >= 1 && seconds <= 600 ? seconds : 30;
  }
  refreshSettings(): void { this.configureNative(); this.post({ type: 'historyWindow', historySeconds: this.historySeconds(), refreshRate: vscode.workspace.getConfiguration('cortexKit').get('chartRefreshRate', 30) }); }
  setState(state: SessionState): void {
    if (state.lastError && state.lastError !== this.state?.lastError) { this.streamError.fire(state.lastError); }
    this.state = state; this.post({ type: 'session', state });
  }
  connect(info: DataChannelInfo): void {
    this.dataChannel = info;
    this.openDataChannel();
    this.dataReady.fire();
  }
  private openDataChannel(): void {
    if (!this.dataChannel || !this.activeSession) { return; }
    this.configureNative();
    void this.native.connect(this.dataChannel).catch(error => this.nativeError(error));
  }
  private closeDataChannel(forgetInfo: boolean): void {
    if (forgetInfo) this.native.disconnect();
    if (forgetInfo) { this.dataChannel = undefined; }
  }
  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = html(view.webview, media);
    view.webview.onDidReceiveMessage(message => void this.handleMessage(message).catch(error => { void vscode.window.showErrorMessage(String(error)); }));
    view.onDidDispose(() => { this.view = undefined; });
    let wasVisible = view.visible;
    view.onDidChangeVisibility(() => {
      const reopened = view.visible && !wasVisible;
      wasVisible = view.visible;
      if (reopened) { this.post({ type: 'nativeRefresh' }); }
    });
    if (this.dataChannel) { this.openDataChannel(); }
    this.pushSnapshot();
  }
  async addChart(): Promise<void> { const index = this.layouts.length + 1; this.layouts.push({ id: `chart-${Date.now()}`, title: `Plot ${index}`, mode: 'time', variableIds: [] }); await this.saveLayouts(); }
  async addVariables(chartId?: string, initial?: VariableDescriptor | VariableDescriptor[]): Promise<void> {
    const chart = this.layouts.find(item => item.id === chartId) ?? this.layouts[0];
    if (!chart) { await this.addChart(); return this.addVariables(undefined, initial); }
    let selections: VariableDescriptor[] = [];
    if (initial) {
      const requested = Array.isArray(initial) ? initial : [initial];
      const leaves = expandVariableSelections(requested);
      if (requested.some(variable => variable.children.length > 0)) {
        const chosen = await vscode.window.showQuickPick(leaves.map(variable => ({
          label: `$(symbol-variable) ${variable.expression}`,
          description: `${variable.typeName} · ${variableLocation(variable)}`,
          picked: chart.variableIds.includes(variable.id),
          variable,
        })), { canPickMany: true, matchOnDescription: true, placeHolder: `选择要加入 ${chart.title} 的内部变量` });
        if (!chosen) { return; }
        selections = chosen.map(item => item.variable);
      } else {
        selections = leaves;
      }
    } else {
      const items = this.catalog.filter(isPlottableVariable).map(variable => {
        return {
          label: `$(symbol-variable) ${variable.expression}`,
          description: `${variable.typeName} · ${variableLocation(variable)}`,
          picked: chart.variableIds.includes(variable.id),
          variable,
        };
      });
      const chosen = await vscode.window.showQuickPick(items, { canPickMany: true, matchOnDescription: true, matchOnDetail: true, placeHolder: `选择要加入 ${chart.title} 的标量变量` });
      if (!chosen) { return; }
      selections = chosen.map(item => item.variable);
    }
    chart.variableIds = [...new Set([...chart.variableIds, ...selections.map(item => item.id)])];
    await this.saveLayouts();
  }
  private async handleMessage(message: Record<string, unknown>): Promise<void> {
    switch (message.type) {
      case 'nativeRender': await this.renderNative(message); break;
      case 'ready': this.pushSnapshot(); this.post({ type: 'nativeRefresh' }); break;
      case 'exportPlots': await this.chooseExportPlots(); break;
      case 'exportImage': await this.saveExportImage(message); break;
      case 'setHistorySeconds': {
        let seconds = message.seconds;
        if (seconds === 'custom') {
          const input = await vscode.window.showInputBox({ title: 'Plot 时间窗口', prompt: '显示并保留最近多少秒的数据（1–600 秒）', value: String(this.historySeconds()),
            validateInput: value => value.trim() && Number.isFinite(Number(value)) && Number(value) >= 1 && Number(value) <= 600 ? undefined : '请输入 1–600 秒' });
          if (input === undefined) { this.refreshSettings(); break; }
          seconds = Number(input);
        }
        if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 1 || seconds > 600) { this.refreshSettings(); break; }
        const folder = this.activeSession?.workspaceFolder ?? vscode.workspace.workspaceFolders?.[0];
        try {
          await vscode.workspace.getConfiguration('cortexKit', folder?.uri).update('historySeconds', seconds, folder ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Global);
        } finally { this.refreshSettings(); }
        break;
      }
      case 'addVariables': await this.addVariables(String(message.chartId)); break;
      case 'addExpression': {
        const expression = await vscode.window.showInputBox({ prompt: 'Cortex Kit expression', placeHolder: 'signal.a * 2 + signal.b' });
        if (expression) {
          try { expressionDependencies(expression); }
          catch (error) { void vscode.window.showErrorMessage(`Invalid Cortex Kit expression: ${String(error)}`); break; }
          const variable = expressionDescriptor(expression);
          if (!this.catalog.some(item => item.id === variable.id)) { this.catalog.push(variable); }
          this.post({ type: 'catalog', variables: this.catalog });
          await this.addVariables(String(message.chartId), variable);
        }
        break;
      }
      case 'addChart': await this.addChart(); break;
      case 'removeChart': this.layouts = this.layouts.filter(item => item.id !== message.chartId); if (!this.layouts.length) { await this.addChart(); } else { await this.saveLayouts(); } break;
      case 'updateChart': { const chart = this.layouts.find(item => item.id === message.chartId); if (chart) { if (typeof message.mode === 'string') { chart.mode = message.mode as ChartLayout['mode']; } if (typeof message.title === 'string') { chart.title = message.title; } await this.saveLayouts(); } break; }
      case 'removeVariable': { const chart = this.layouts.find(item => item.id === message.chartId); if (chart) { chart.variableIds = chart.variableIds.filter(id => id !== message.variableId); await this.saveLayouts(); } break; }
      case 'setArrangement': if (message.arrangement === 'grid' || message.arrangement === 'row' || message.arrangement === 'column') { this.arrangement = message.arrangement; await this.saveArrangement(); } break;
      case 'reorderCharts': {
        if (typeof message.sourceChartId === 'string' && typeof message.targetChartId === 'string') {
          this.layouts = reorderCharts(this.layouts, message.sourceChartId, message.targetChartId, message.after === true);
          await this.saveLayouts();
        }
        break;
      }
    }
  }
  private async saveLayouts(): Promise<void> { await this.context.workspaceState.update('cortexKit.plots', this.layouts); this.post({ type: 'layout', charts: this.layouts }); await this.updateSubscriptions(); }
  private async saveArrangement(): Promise<void> { await this.context.workspaceState.update('cortexKit.plotArrangement', this.arrangement); this.post({ type: 'layout', charts: this.layouts, arrangement: this.arrangement }); }
  private async updateSubscriptions(throwOnError = false): Promise<void> {
    this.configureNative();
    if (!this.activeSession) { return; }
    const plotIds = resolveSubscriptionIds(this.layouts, this.catalog);
    const plotRate = Number(this.activeSession.configuration.acquisition?.requestedSamplesPerSecond ?? 1000);
    const liveWatchRate = vscode.workspace.getConfiguration('cortexKit').get('liveWatchSamplesPerSecond', 20);
    const foregroundIds = [...new Set([...plotIds, ...(this.recording?.ids ?? [])])];
    const foregroundRate = Math.max(plotIds.length ? plotRate : 0, this.recording?.rate ?? 0);
    const subscription = splitSubscriptions(foregroundIds, this.liveWatchIds, foregroundRate, liveWatchRate);
    const key = JSON.stringify([this.activeSession.id, subscription]);
    if (key === this.lastSubscriptionKey) { return; }
    this.lastSubscriptionKey = key;
    try { await this.activeSession.customRequest('cortexKit/setSubscriptions', subscription); }
    catch (error) { if (this.lastSubscriptionKey === key) { this.lastSubscriptionKey = undefined; } this.post({ type: 'streamError', message: `Subscription failed: ${String(error)}` }); if (throwOnError) { throw error; } }
  }
  private pushSnapshot(): void { this.post({ type: 'snapshot', charts: this.layouts, arrangement: this.arrangement, variables: this.catalog, state: this.state, refreshRate: vscode.workspace.getConfiguration('cortexKit').get('chartRefreshRate', 30), historySeconds: this.historySeconds() }); void this.updateSubscriptions(); }
  private async chooseExportPlots(): Promise<void> {
    if (this.exporting) { return; }
    const available = this.layouts.filter(chart => this.native.hasHistory && chart.variableIds.length > 0);
    if (!available.length) { void vscode.window.showInformationMessage('还没有可导出的 Plot 数据。采样后或暂停、结束会话后再导出。'); return; }
    this.exporting = true;
    try {
      const chosen = await vscode.window.showQuickPick(available.map(chart => ({ label: chart.title, description: `${chart.mode} · ${chart.variableIds.length} 个变量`, picked: true, chart })), {
        title: '导出 Plot 图片', placeHolder: '选择一个或多个图表，按当前顺序合并为一张 PNG', canPickMany: true,
      });
      if (!chosen?.length) { return; }
      if (!this.native.hasHistory) { throw new Error('已切换目标会话，请重新选择要导出的图表。'); }
      const selected = new Set(chosen.map(item => item.chart.id));
      const id = nonce();
      this.exportRequest = { id, timer: setTimeout(() => {
        this.exportRequest = undefined; this.exporting = false;
        void vscode.window.showErrorMessage('图片生成超时，请打开 Plot 面板后重试。');
      }, 30000) };
      this.post({ type: 'renderExport', requestId: id, chartIds: this.layouts.filter(chart => selected.has(chart.id)).map(chart => chart.id) });
    } finally { if (!this.exportRequest) { this.exporting = false; } }
  }
  private async saveExportImage(message: Record<string, unknown>): Promise<void> {
    if (!this.exportRequest || message.requestId !== this.exportRequest.id) { return; }
    clearTimeout(this.exportRequest.timer); this.exportRequest = undefined;
    try {
      if (message.error) { throw new Error(String(message.error)); }
      const data = message.dataUrl;
      if (typeof data !== 'string' || data.length > 64 * 1024 * 1024 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(data)) { throw new Error('导出的 PNG 数据无效或超过 48 MB。请减少图表数量后重试。'); }
      const bytes = Buffer.from(data.slice('data:image/png;base64,'.length), 'base64');
      if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) { throw new Error('导出结果不是有效的 PNG 图片。'); }
      const folder = this.activeSession?.workspaceFolder ?? vscode.workspace.workspaceFolders?.[0];
      const filename = `plots-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
      const uri = await vscode.window.showSaveDialog({ title: '保存 Plot 合并图片', filters: { PNG: ['png'] },
        ...(folder ? { defaultUri: vscode.Uri.joinPath(folder.uri, filename) } : {}) });
      if (!uri) { return; }
      await vscode.workspace.fs.writeFile(uri, bytes);
      void vscode.window.showInformationMessage(`Plot 图片已保存：${uri.fsPath}`);
    } finally { this.exporting = false; }
  }
  private clearHistory(): void { this.native.invalidateHistory(); this.post({ type: 'clearHistory' }); }
  private post(message: unknown): void { void this.view?.webview.postMessage(message); }
}

function nonce(): string { const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join(''); }
function nativeBackendPath(context: vscode.ExtensionContext): string {
  const configured = vscode.workspace.getConfiguration('cortexKit').get<string>('backendPath', '');
  if (configured) return configured;
  const executable = typeof process !== 'undefined' && process.platform === 'win32' ? 'cortex-kit-dap.exe' : 'cortex-kit-dap';
  const root = context.extensionPath ?? context.extensionUri?.fsPath ?? '.';
  const bundled = path.join(root, 'bin', executable);
  return fs.existsSync(bundled) ? bundled : path.join(root, '..', 'target', 'debug', executable);
}
function variableLocation(variable: VariableDescriptor): string {
  if (variable.address !== undefined) { return `0x${variable.address.toString(16)}`; }
  if (variable.pointerAddress !== undefined) {
    const offset = variable.pointerOffset ?? 0;
    return `*(0x${variable.pointerAddress.toString(16)})${offset ? ` + 0x${offset.toString(16)}` : ''}`;
  }
  return 'expression';
}
function html(webview: vscode.Webview, media: vscode.Uri): string {
  const nativeScript = webview.asWebviewUri(vscode.Uri.joinPath(media, 'native-plot.js'));
  const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.js')); const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'styles.css')); const value = nonce();
  return `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${value}';"><link rel="stylesheet" href="${style}"></head><body><header><span id="connection">No session</span><span id="metrics"></span><label class="history-control">时间窗口 <select id="history-seconds" title="曲线显示与保留时长；加长后从现有数据继续积累"><option value="5">5 秒</option><option value="10">10 秒</option><option value="30" selected>30 秒</option><option value="60">1 分钟</option><option value="120">2 分钟</option><option value="300">5 分钟</option><option value="600">10 分钟</option><option value="custom">自定义…</option></select></label><select id="arrangement" title="Chart arrangement"><option value="grid">Auto grid</option><option value="row">Side by side</option><option value="column">Stacked</option></select><button id="export-plots" title="选择一个或多个图表合并保存为 PNG">导出图片</button><button id="add-chart" title="Add chart">＋ Add chart</button></header><main id="charts"></main><script nonce="${value}" src="${nativeScript}"></script><script nonce="${value}" src="${script}"></script></body></html>`;
}
