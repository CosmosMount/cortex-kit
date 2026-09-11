import * as net from 'node:net';
import * as vscode from 'vscode';
import { BatchDecoder } from './binaryProtocol';
import { expressionDependencies } from './expression';
import { latestLiveWatchValues, mergeSubscriptionIds, selectBatchChannels } from './liveWatchModel';
import { appendDerivedChannels, expandVariableSelections, expressionDescriptor, flattenVariables, isVariableSelection, plottableLeaves, reorderCharts, resolveSubscriptionIds, restoreLayoutExpressions } from './plotModel';
import { ChartArrangement, ChartLayout, LiveWatchValue, SampleBatch, SessionState, VariableDescriptor } from './types';

interface DataChannelInfo { port: number; token: string; protocolVersion: number; }

export class PlotViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private socket?: net.Socket;
  private dataChannel?: DataChannelInfo;
  private reconnectTimer?: NodeJS.Timeout;
  private socketGeneration = 0;
  private layouts: ChartLayout[];
  private arrangement: ChartArrangement;
  private catalog: VariableDescriptor[];
  private state?: SessionState;
  private activeSession?: vscode.DebugSession;
  private liveWatchIds: string[] = [];
  private readonly liveWatchValues = new vscode.EventEmitter<LiveWatchValue[]>();
  readonly onDidReceiveLiveWatchValues = this.liveWatchValues.event;
  private pendingLiveWatchValues = new Map<string, LiveWatchValue>();
  private liveWatchTimer?: NodeJS.Timeout;
  private lastSubscriptionKey?: string;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.layouts = context.workspaceState.get<ChartLayout[]>('cortexKit.plots', [{ id: 'chart-1', title: 'Plot 1', mode: 'time', variableIds: [] }]);
    this.arrangement = context.workspaceState.get<ChartArrangement>('cortexKit.plotArrangement', 'grid');
    this.catalog = restoreLayoutExpressions(this.layouts);
  }
  dispose(): void {
    this.closeDataChannel(true);
    if (this.liveWatchTimer) { clearTimeout(this.liveWatchTimer); }
    this.liveWatchValues.dispose();
  }
  setSession(session?: vscode.DebugSession): void {
    const changed = this.activeSession?.id !== session?.id;
    this.activeSession = session;
    if (changed) { this.clearHistory(); this.pendingLiveWatchValues.clear(); this.lastSubscriptionKey = undefined; }
    if (!session) {
      this.state = undefined;
      this.post({ type: 'session', state: undefined });
      this.closeDataChannel(true);
    }
  }
  setCatalog(catalog: VariableDescriptor[]): void { const expressions = this.catalog.filter(item => item.id.startsWith('expr:')); this.catalog = [...flattenVariables(catalog), ...expressions]; this.post({ type: 'catalog', variables: this.catalog }); void this.updateSubscriptions(); }
  setLiveWatchIds(ids: string[]): void { this.liveWatchIds = [...new Set(ids)]; void this.updateSubscriptions(); }
  refreshSubscriptions(): Promise<void> { return this.updateSubscriptions(); }
  setState(state: SessionState): void { this.state = state; this.post({ type: 'session', state }); }
  connect(info: DataChannelInfo): void {
    this.dataChannel = info;
    this.openDataChannel();
  }
  private openDataChannel(): void {
    const info = this.dataChannel;
    if (!info || !this.activeSession) { return; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
    const generation = ++this.socketGeneration;
    this.socket?.destroy();
    const decoder = new BatchDecoder();
    const socket = net.createConnection({ host: '127.0.0.1', port: info.port }, () => socket.write(`${info.token}\n`));
    this.socket = socket;
    socket.on('data', chunk => { try { for (const batch of decoder.push(chunk)) { this.acceptBatch(batch); } } catch (error) { void vscode.window.showErrorMessage(`Cortex Kit sample stream error: ${String(error)}`); } });
    socket.on('error', error => this.post({ type: 'streamError', message: error.message }));
    socket.on('close', () => {
      if (generation !== this.socketGeneration || !this.activeSession || !this.dataChannel) { return; }
      this.reconnectTimer = setTimeout(() => this.openDataChannel(), 250);
    });
  }
  private closeDataChannel(forgetInfo: boolean): void {
    this.socketGeneration += 1;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
    this.socket?.destroy();
    this.socket = undefined;
    if (forgetInfo) { this.dataChannel = undefined; }
  }
  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = html(view.webview, media);
    view.webview.onDidReceiveMessage(message => void this.handleMessage(message));
    view.onDidDispose(() => { this.view = undefined; });
    let wasVisible = view.visible;
    view.onDidChangeVisibility(() => {
      const reopened = view.visible && !wasVisible;
      wasVisible = view.visible;
      if (reopened) { this.clearHistory(); }
    });
    if (this.dataChannel && !this.socket) { this.openDataChannel(); }
    this.pushSnapshot();
  }
  async addChart(): Promise<void> { const index = this.layouts.length + 1; this.layouts.push({ id: `chart-${Date.now()}`, title: `Plot ${index}`, mode: 'time', variableIds: [] }); await this.saveLayouts(); }
  async addVariables(chartId?: string, initial?: VariableDescriptor | VariableDescriptor[]): Promise<void> {
    const chart = this.layouts.find(item => item.id === chartId) ?? this.layouts[0];
    if (!chart) { await this.addChart(); return this.addVariables(undefined, initial); }
    let selections: VariableDescriptor[] = initial ? expandVariableSelections(Array.isArray(initial) ? initial : [initial]) : [];
    if (!initial) {
      const items = this.catalog.filter(isVariableSelection).map(variable => {
        const leaves = plottableLeaves(variable);
        const container = variable.children.length > 0;
        return {
          label: `${container ? '$(symbol-struct)' : '$(symbol-variable)'} ${variable.expression}`,
          description: container ? `${variable.typeName} · ${leaves.length} scalar fields` : `${variable.typeName}${variable.address === undefined ? ' · expression' : ` · 0x${variable.address.toString(16)}`}`,
          picked: leaves.every(leaf => chart.variableIds.includes(leaf.id)),
          variable,
        };
      });
      const chosen = await vscode.window.showQuickPick(items, { canPickMany: true, matchOnDescription: true, matchOnDetail: true, placeHolder: `Select a structure or individual fields for ${chart.title}` });
      if (!chosen) { return; }
      selections = expandVariableSelections(chosen.map(item => item.variable));
    }
    chart.variableIds = [...new Set([...chart.variableIds, ...selections.map(item => item.id)])];
    await this.saveLayouts();
  }
  private acceptBatch(batch: SampleBatch): void {
    if (this.state && (batch.sessionId !== this.state.sessionId || batch.programGeneration !== this.state.programGeneration || batch.streamEpoch !== this.state.streamEpoch)) { return; }
    this.queueLiveWatchValues(latestLiveWatchValues(batch, this.liveWatchIds));
    if (this.view?.visible) {
      const displayedIds = new Set(this.layouts.flatMap(chart => chart.variableIds));
      const plotted = selectBatchChannels(appendDerivedChannels(batch, this.layouts, this.catalog), displayedIds);
      if (plotted.channelIds.length) { this.post({ type: 'samples', batch: plotted }); }
    }
  }
  private queueLiveWatchValues(values: LiveWatchValue[]): void {
    for (const value of values) { this.pendingLiveWatchValues.set(value.id, value); }
    if (!values.length || this.liveWatchTimer) { return; }
    const refreshRate = vscode.workspace.getConfiguration('cortexKit').get('liveWatchRefreshRate', 10);
    this.liveWatchTimer = setTimeout(() => {
      this.liveWatchTimer = undefined;
      const pending = [...this.pendingLiveWatchValues.values()];
      this.pendingLiveWatchValues.clear();
      if (pending.length) { this.liveWatchValues.fire(pending); }
    }, 1000 / Math.max(1, refreshRate));
  }
  private async handleMessage(message: Record<string, unknown>): Promise<void> {
    switch (message.type) {
      case 'ready': this.pushSnapshot(); break;
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
  private async updateSubscriptions(): Promise<void> {
    if (!this.activeSession) { return; }
    const plotIds = resolveSubscriptionIds(this.layouts, this.catalog);
    const ids = mergeSubscriptionIds(plotIds, this.liveWatchIds);
    const plotRate = plotIds.length ? Number(this.activeSession.configuration.acquisition?.requestedSamplesPerSecond ?? 1000) : 0;
    const liveWatchRate = this.liveWatchIds.length ? vscode.workspace.getConfiguration('cortexKit').get('liveWatchSamplesPerSecond', 20) : 0;
    const requestedSamplesPerSecond = Math.max(1, plotRate, liveWatchRate);
    const key = JSON.stringify([this.activeSession.id, ids, requestedSamplesPerSecond]);
    if (key === this.lastSubscriptionKey) { return; }
    this.lastSubscriptionKey = key;
    try { await this.activeSession.customRequest('cortexKit/setSubscriptions', { ids, requestedSamplesPerSecond }); }
    catch (error) { if (this.lastSubscriptionKey === key) { this.lastSubscriptionKey = undefined; } this.post({ type: 'streamError', message: `Subscription failed: ${String(error)}` }); }
  }
  private pushSnapshot(): void { this.post({ type: 'snapshot', charts: this.layouts, arrangement: this.arrangement, variables: this.catalog, state: this.state, refreshRate: vscode.workspace.getConfiguration('cortexKit').get('chartRefreshRate', 30), historySeconds: vscode.workspace.getConfiguration('cortexKit').get('historySeconds', 30) }); void this.updateSubscriptions(); }
  private clearHistory(): void { this.post({ type: 'clearHistory' }); }
  private post(message: unknown): void { void this.view?.webview.postMessage(message); }
}

function nonce(): string { const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join(''); }
function html(webview: vscode.Webview, media: vscode.Uri): string {
  const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.js')); const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'styles.css')); const value = nonce();
  return `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${value}';"><link rel="stylesheet" href="${style}"></head><body><header><span id="connection">No session</span><span id="metrics"></span><select id="arrangement" title="Chart arrangement"><option value="grid">Auto grid</option><option value="row">Side by side</option><option value="column">Stacked</option></select><button id="add-chart" title="Add chart">＋ Add chart</button></header><main id="charts"></main><script nonce="${value}" src="${script}"></script></body></html>`;
}
