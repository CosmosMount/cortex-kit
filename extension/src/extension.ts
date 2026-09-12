import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { registerFlashOutput } from './flashOutput';
import { configuredProgramCandidates } from './launchConfig';
import { validateLiveWatchInput } from './liveWatchModel';
import { inspectElf, isDwarfImage, resolveConfiguredPath } from './offlineCatalog';
import { expandVariableSelections, isPlottableVariable, isVariableSelection, plottableLeaves } from './plotModel';
import { PlotViewProvider } from './plots';
import { SampleRecorder } from './recorder';
import { ThreadsView } from './threads';
import { selectProbeAndConnect, configureProbe, configureProject, defaultBackendPath, expandWorkspace, importCortexDebugConfiguration } from './projectConfig';
import { inspectSvd } from './svdCatalog';
import { SessionState, SvdTree, VariableDescriptor } from './types';
import { LiveWatchNode, LiveWatchProvider, PeripheralNode, PeripheralsProvider, RegisterNode, SessionProvider, VariableNode, VariablesProvider } from './views';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const variables = new VariablesProvider();
  const liveWatch = new LiveWatchProvider(context.workspaceState);
  const peripherals = new PeripheralsProvider();
  const sessionView = new SessionProvider();
  const plots = new PlotViewProvider(context);
  const recorder = new SampleRecorder(context, plots);
  const threads = new ThreadsView(context, plots);
  const variablesView = vscode.window.createTreeView('cortexKit.variables', { treeDataProvider: variables });
  const liveWatchView = vscode.window.createTreeView('cortexKit.liveWatch', { treeDataProvider: liveWatch });
  const peripheralsView = vscode.window.createTreeView('cortexKit.peripherals', { treeDataProvider: peripherals });
  const output = vscode.window.createOutputChannel('Cortex Kit');
  const flashOutput = vscode.window.createOutputChannel('Cortex Kit Flash');
  context.subscriptions.push(flashOutput, registerFlashOutput(flashOutput));
  let active: vscode.DebugSession | undefined;
  let latestState: SessionState | undefined;
  let valueRefreshGeneration = 0;
  let lastAutomaticStop = '';
  const offlineIndex = new OfflineVariableIndex(
    defaultBackendPath(context), variables, liveWatch, plots, variablesView, output, () => active === undefined,
  );
  const svdIndex = new SvdIndex(defaultBackendPath(context), peripherals, peripheralsView, output);
  const refreshCurrentValues = async (force = false): Promise<void> => {
    const debugSession = active;
    const state = latestState;
    if (!debugSession || !state || !isHalted(state)) { return; }
    const stopKey = `${state.sessionId}:${state.stopId}`;
    if (!force && stopKey === lastAutomaticStop) { return; }
    if (!force) { lastAutomaticStop = stopKey; }
    const generation = ++valueRefreshGeneration;
    const variableTargets = variables.getVisibleScalarVariables();
    const liveWatchTargets = liveWatch.getSelectedVariables();
    const registerTargets = peripherals.getTrackedRegisters();
    const requests: Array<PromiseLike<void>> = [];
    const valueTargets = [...new Map([...variableTargets, ...liveWatchTargets].map(variable => [variable.id, variable])).values()];
    if (valueTargets.length) {
      requests.push(debugSession.customRequest('cortexKit/readValues', { ids: valueTargets.map(variable => variable.id) }).then(result => {
        if (generation === valueRefreshGeneration && active?.id === debugSession.id) {
          variables.setValues(result.values ?? []);
          liveWatch.setValues((result.values ?? []).map((item: { id: string; value: number }) => ({ ...item, source: 'snapshot' as const })));
        }
      }));
    }
    if (registerTargets.length) {
      requests.push(debugSession.customRequest('cortexKit/readRegisters', { registers: registerTargets.map(register => ({ id: `0x${register.address.toString(16)}`, address: `0x${register.address.toString(16)}`, sizeBits: register.sizeBits })) }).then(result => {
        if (generation === valueRefreshGeneration && active?.id === debugSession.id) { peripherals.setRegisterValues(result.values ?? []); }
      }));
    }
    const results = await Promise.allSettled(requests);
    for (const result of results) {
      if (result.status === 'rejected') { output.appendLine(`[values] Refresh failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`); }
    }
  };
  const refreshLiveWatchNow = async (): Promise<void> => {
    const debugSession = active;
    const ids = liveWatch.getSelectedIds();
    if (!debugSession || !ids.length) { return; }
    try {
      const result = await debugSession.customRequest('cortexKit/readValues', { ids });
      if (active?.id === debugSession.id) {
        liveWatch.setValues((result.values ?? []).map((item: { id: string; value: number }) => ({ ...item, source: 'snapshot' as const })));
      }
    } catch (error) {
      output.appendLine(`[live-watch] Refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  context.subscriptions.push(
    variablesView,
    liveWatchView,
    liveWatch,
    peripheralsView,
    vscode.window.registerTreeDataProvider('cortexKit.session', sessionView),
    vscode.window.registerWebviewViewProvider('cortexKit.plots', plots, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewViewProvider('cortexKit.sample', recorder, { webviewOptions: { retainContextWhenHidden: true } }),
    plots,
    recorder,
    threads,
    vscode.window.registerWebviewViewProvider('cortexKit.threads', threads, { webviewOptions: { retainContextWhenHidden: true } }),
    output,
    offlineIndex,
    svdIndex,
    variablesView.onDidExpandElement(event => { variables.setExpanded(event.element.variable, true); void refreshCurrentValues(true); }),
    variablesView.onDidCollapseElement(event => variables.setExpanded(event.element.variable, false)),
    peripheralsView.onDidExpandElement(event => {
      if (event.element instanceof PeripheralNode || event.element instanceof RegisterNode) { peripherals.track(event.element); void refreshCurrentValues(true); }
    }),
    plots.onDidReceiveLiveWatchValues(values => liveWatch.setValues(values)),
    liveWatch.onDidChangeSelection(ids => plots.setLiveWatchIds(ids)),
  );
  plots.setLiveWatchIds(liveWatch.getSelectedIds());

  const factory = new AdapterFactory(context);
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory('cortex-kit', factory),
    vscode.debug.registerDebugConfigurationProvider('cortex-kit', new ConfigurationProvider()),
  );

  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession(async debugSession => {
      if (debugSession.type !== 'cortex-kit') { return; }
      active = debugSession;
      latestState = undefined;
      lastAutomaticStop = '';
      variables.clearValues();
      liveWatch.clearValues();
      peripherals.clearValues();
      plots.setSession(debugSession);
      variablesView.description = 'Connecting…';
      const svd = expandWorkspace(debugSession.configuration.svdFile, debugSession.workspaceFolder ?? vscode.workspace.workspaceFolders?.[0]);
      if (svd) { await svdIndex.loadPath(svd, path.basename(svd)); }
      else { await svdIndex.refresh(); }
    }),
    vscode.debug.onDidTerminateDebugSession(debugSession => {
      if (active?.id !== debugSession.id) { return; }
      active = undefined;
      latestState = undefined;
      valueRefreshGeneration += 1;
      lastAutomaticStop = '';
      variables.clearValues();
      liveWatch.clearValues();
      peripherals.clearValues();
      plots.setSession(undefined);
      sessionView.setState(undefined);
      offlineIndex.schedule(0);
    }),
    vscode.debug.onDidReceiveDebugSessionCustomEvent(async event => {
      if (event.session.type !== 'cortex-kit') { return; }
      if (event.event === 'cortexKit.state') {
        const state = event.body as SessionState;
        latestState = state;
        sessionView.setState(state);
        plots.setState(state);
        if (isHalted(state)) { await refreshCurrentValues(); }
        else { valueRefreshGeneration += 1; lastAutomaticStop = ''; variables.clearValues(); peripherals.clearValues(); }
      }
      if (event.event === 'cortexKit.catalog') {
        offlineIndex.useLiveCatalog((event.body?.variables ?? []) as VariableDescriptor[]);
        if (latestState && isHalted(latestState)) { await refreshCurrentValues(true); }
      }
      if (event.event === 'cortexKit.dataChannelReady') { plots.connect(event.body); }
    }),
  );

  const register = (command: string, callback: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(command, callback));
  register('cortexKit.selectProbeAndConnect', () => selectProbeAndConnect(defaultBackendPath(context)));
  register('cortexKit.configureProbe', () => configureProbe(defaultBackendPath(context)));
  register('cortexKit.configureProject', async () => {
    await configureProject(defaultBackendPath(context));
    offlineIndex.schedule(0);
    svdIndex.schedule(0);
  });
  register('cortexKit.importCortexDebug', async () => {
    if (await importCortexDebugConfiguration(defaultBackendPath(context))) { offlineIndex.schedule(0); svdIndex.schedule(0); }
  });
  register('cortexKit.mockDebug', () => vscode.debug.startDebugging(vscode.workspace.workspaceFolders?.[0], {
    type: 'cortex-kit', request: 'launch', name: 'Cortex Kit: Mock Debug', chip: 'Cortex-M Mock', mockProbe: true,
    stopOnEntry: true, acquisition: { requestedSamplesPerSecond: 1000 },
  }));
  register('cortexKit.refresh', async () => {
    if (active) {
      try {
        const state = await active.customRequest('cortexKit/getState');
        latestState = state;
        sessionView.setState(state);
        const catalog = await active.customRequest('cortexKit/getCatalog');
        offlineIndex.useLiveCatalog(catalog.variables);
        if (isHalted(state)) { await refreshCurrentValues(true); }
        else { await refreshLiveWatchNow(); }
      } catch { /* session is closing */ }
    } else {
      await offlineIndex.refresh({ force: true, notify: true });
    }
    await svdIndex.refresh({ force: true, notify: true });
  });
  register('cortexKit.selectSvd', async () => {
    const selected = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: true, canSelectFolders: false, filters: { 'CMSIS-SVD': ['svd'], 'XML files': ['xml'] }, openLabel: 'Use SVD' });
    const uri = selected?.[0];
    if (!uri) { return; }
    const folder = vscode.workspace.getWorkspaceFolder(uri) ?? vscode.workspace.workspaceFolders?.[0];
    if (!folder) { return; }
    const configuredPath = isWithinFolder(uri.fsPath, folder.uri.fsPath) ? '${workspaceFolder}/' + path.relative(folder.uri.fsPath, uri.fsPath).replace(/\\/g, '/') : uri.fsPath;
    const launch = vscode.workspace.getConfiguration('launch', folder.uri);
    const configurations = launch.get<unknown[]>('configurations', []);
    const updated = configurations.map(value => {
      if (typeof value !== 'object' || value === null || (value as { type?: unknown }).type !== 'cortex-kit') { return value; }
      return { ...value, svdFile: configuredPath };
    });
    if (!updated.some(value => typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'cortex-kit')) {
      void vscode.window.showWarningMessage('No Cortex Kit launch configuration exists. Run “Cortex Kit: Configure Project” first.');
      return;
    }
    await launch.update('configurations', updated, vscode.ConfigurationTarget.WorkspaceFolder);
    await svdIndex.loadPath(uri.fsPath, path.basename(uri.fsPath), { notify: true, force: true });
  });
  register('cortexKit.searchVariables', async () => {
    if (!variables.hasVariables()) { await offlineIndex.refresh({ notify: true }); }
    const items = variables.getVariables().filter(isVariableSelection).filter(item => !item.id.startsWith('expr:')).map(variable => ({
      label: `${variable.children.length ? '$(symbol-struct)' : '$(symbol-variable)'} ${variable.expression}`,
      description: variable.children.length ? `${variable.typeName} · ${plottableLeaves(variable).length} scalar fields` : variable.typeName,
      detail: variable.children.length ? 'Select to add every scalar field recursively' : `${variable.address === undefined ? '' : `0x${variable.address.toString(16)} · `}${variable.byteWidth} byte${variable.byteWidth === 1 ? '' : 's'}`,
      variable,
    }));
    if (!items.length) {
      void vscode.window.showWarningMessage('No searchable global/static scalar fields were found. Configure an ELF/AXF with DWARF debug information first.');
      return;
    }
    const selected = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      matchOnDescription: true,
      matchOnDetail: true,
      placeHolder: 'Select structures, fields, or array elements to add to Plot',
    });
    if (!selected?.length) { return; }
    await plots.addVariables(undefined, expandVariableSelections(selected.map(item => item.variable)));
    await vscode.commands.executeCommand('cortexKit.plots.focus');
  });
  register('cortexKit.addLiveWatch', async () => {
    if (!variables.hasVariables()) { await offlineIndex.refresh({ notify: true }); }
    const items = variables.getVariables().filter(isVariableSelection).filter(item => !item.id.startsWith('expr:')).map(variable => ({
      label: `${variable.children.length ? '$(symbol-struct)' : '$(symbol-variable)'} ${variable.expression}`,
      description: variable.children.length ? `${variable.typeName} · ${plottableLeaves(variable).length} scalar fields` : variable.typeName,
      detail: variable.children.length ? 'Select to add every scalar field recursively' : `${variable.address === undefined ? '' : `0x${variable.address.toString(16)} · `}${variable.writable ? 'read/write' : 'read-only'}`,
      picked: plottableLeaves(variable).every(leaf => liveWatch.has(leaf.id)),
      variable,
    }));
    if (!items.length) { void vscode.window.showWarningMessage('No scalar ELF variables are available for Live Watch.'); return; }
    const selected = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      matchOnDescription: true,
      matchOnDetail: true,
      placeHolder: 'Select structures or individual fields for Live Watch; Plot selections are unchanged',
    });
    if (selected?.length) {
      await liveWatch.add(expandVariableSelections(selected.map(item => item.variable)));
      if (latestState && isHalted(latestState)) { await refreshCurrentValues(true); }
    }
  });
  register('cortexKit.addVariableToLiveWatch', async (node?: VariableNode) => {
    if (node?.variable) {
      await liveWatch.add(expandVariableSelections([node.variable]));
      if (latestState && isHalted(latestState)) { await refreshCurrentValues(true); }
    }
  });
  register('cortexKit.removeLiveWatch', async (node?: LiveWatchNode) => {
    if (node) { await liveWatch.remove(node.variable); }
  });
  register('cortexKit.clearLiveWatch', () => liveWatch.clear());
  register('cortexKit.addLiveWatchToPlot', async (node?: LiveWatchNode) => {
    if (!node) { return; }
    await plots.addVariables(undefined, expandVariableSelections([node.variable]));
    await vscode.commands.executeCommand('cortexKit.plots.focus');
  });
  register('cortexKit.writeLiveWatch', async (node?: LiveWatchNode) => {
    if (!node) { return; }
    if (!active) { void vscode.window.showInformationMessage('Start or attach a Cortex Kit session before writing a Live Watch value.'); return; }
    if (!node.variable.writable) { void vscode.window.showWarningMessage(`${node.variable.expression} is read-only.`); return; }
    const current = liveWatch.getCurrent(node.variable.id);
    const input = await vscode.window.showInputBox({
      title: `Write ${node.variable.expression}`,
      prompt: `${node.variable.typeName} at 0x${node.variable.address?.toString(16) ?? '?'}. The target can remain running.`,
      value: current && Number.isFinite(current.value) ? String(current.value) : undefined,
      placeHolder: node.variable.scalarKind === 'boolean' ? 'true or false' : node.variable.scalarKind.startsWith('float') ? '0.0' : '0 or 0x0',
      validateInput: value => validateLiveWatchInput(value, node.variable.scalarKind),
    });
    if (input === undefined) { return; }
    try {
      const result = await active.customRequest('cortexKit/writeValue', { id: node.variable.id, value: input });
      liveWatch.setWrittenValue(node.variable.id, Number(result.numericValue), result.value);
      if (result.verified === false) {
        void vscode.window.showWarningMessage(`${node.variable.expression} was written, but the running firmware changed it immediately. Readback: ${result.value}`);
      } else {
        void vscode.window.setStatusBarMessage(`${node.variable.expression} = ${result.value} (verified)`, 3000);
      }
      try {
        const refreshed = await active.customRequest('cortexKit/readValues', { ids: [node.variable.id] });
        liveWatch.setValues((refreshed.values ?? []).map((item: { id: string; value: number }) => ({ ...item, source: 'snapshot' as const })));
      } catch (error) {
        output.appendLine(`[live-watch] Wrote ${node.variable.expression}, but readback failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not write ${node.variable.expression}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  register('cortexKit.refreshLiveWatch', async () => {
    if (latestState && isHalted(latestState)) { await refreshCurrentValues(true); }
    else { await refreshLiveWatchNow(); }
  });
  register('cortexKit.addChart', () => plots.addChart());
  register('cortexKit.addVariableToPlot', (node?: VariableNode) => plots.addVariables(undefined, node ? expandVariableSelections([node.variable]) : undefined));
  register('cortexKit.openPlots', () => vscode.commands.executeCommand('cortexKit.plots.focus'));
  register('cortexKit.openRecorder', () => recorder.open());
  register('cortexKit.readRegister', async (node?: RegisterNode) => {
    if (!node) { return; }
    if (!active) { void vscode.window.showInformationMessage('The SVD register map is available offline. Attach or start Cortex Kit to read live values.'); return; }
    const count = Math.max(1, Math.ceil(node.register.sizeBits / 8));
    const result = await active.customRequest('readMemory', { memoryReference: `0x${node.register.address.toString(16)}`, count });
    const bytes = Buffer.from(result.data, 'base64');
    let value = 0n;
    for (let index = bytes.length - 1; index >= 0; index -= 1) { value = (value << 8n) | BigInt(bytes[index]); }
    peripherals.setRegisterValue(node.register.address, value);
    void vscode.window.showInformationMessage(`${node.register.name} = 0x${value.toString(16).padStart(count * 2, '0')}`);
  });
  register('cortexKit.writeRegister', async (node?: RegisterNode) => {
    if (!active || !node) { return; }
    if (node.register.access && !/write/i.test(node.register.access)) { void vscode.window.showWarningMessage(`${node.register.name} is read-only according to the SVD.`); return; }
    const input = await vscode.window.showInputBox({
      prompt: `Write ${node.register.name}`,
      placeHolder: '0x00000000',
      validateInput: value => { try { BigInt(value); return undefined; } catch { return 'Enter a decimal or 0x-prefixed integer'; } },
    });
    if (!input) { return; }
    const count = Math.max(1, Math.ceil(node.register.sizeBits / 8));
    const bytes = Buffer.alloc(count);
    let value = BigInt(input);
    for (let index = 0; index < count; index += 1) { bytes[index] = Number(value & 0xffn); value >>= 8n; }
    await active.customRequest('writeMemory', { memoryReference: `0x${node.register.address.toString(16)}`, data: bytes.toString('base64') });
    await vscode.commands.executeCommand('cortexKit.readRegister', node);
  });
  register('cortexKit.build', async () => {
    try { await vscode.commands.executeCommand('cmake.build'); }
    catch (error) { void vscode.window.showErrorMessage(`Cortex Kit build failed: ${String(error)}`); }
  });
  let flashing = false;
  register('cortexKit.flash', async () => {
    if (flashing) { return; }
    flashing = true;
    flashOutput.show(true);
    flashOutput.appendLine(`\n[${new Date().toLocaleTimeString()}] Preparing firmware flash…`);
    try {
      if (!active) {
        const choices = (vscode.workspace.workspaceFolders ?? []).flatMap(folder =>
          vscode.workspace.getConfiguration('launch', folder.uri).get<vscode.DebugConfiguration[]>('configurations', [])
            .filter(config => config.type === 'cortex-kit' && config.request === 'launch' && !config.mockProbe && config.programBinary)
            .map(config => ({ label: config.name, description: folder.name, folder, config })));
        if (!choices.length) { void vscode.window.showErrorMessage('Run “Cortex Kit: Configure Project” and select a firmware image before flashing.'); return; }
        const selected = choices.length === 1 ? choices[0] : await vscode.window.showQuickPick(choices, { placeHolder: 'Select firmware to flash' });
        if (!selected) { return; }
        flashOutput.appendLine(`Configuration: ${selected.config.name}`);
        flashOutput.appendLine(selected.config.preLaunchTask
          ? `Waiting for pre-launch task: ${selected.config.preLaunchTask}`
          : 'Using existing firmware image (no pre-launch build task).');
        const name = `Cortex Kit: Flash ${Date.now()}`;
        let flashSession: vscode.DebugSession | undefined;
        const listener = vscode.debug.onDidStartDebugSession(session => {
          if (session.type === 'cortex-kit' && session.name === name) { flashSession = session; }
        });
        try {
          const started = await vscode.debug.startDebugging(selected.folder, {
            ...selected.config, name, request: 'launch', noDebug: true, stopOnEntry: false,
            plotOnly: false, flashing: { ...selected.config.flashing, enabled: false },
          });
          if (!started || !flashSession) { throw new Error('Flash session did not start; build or connection may have failed or been cancelled.'); }
          flashOutput.appendLine('Probe connected. Sending flash request…');
          await flashSession.customRequest('cortexKit/flash', {
            path: flashSession.configuration.programBinary,
            verify: selected.config.flashing?.verify ?? true,
            resetAfter: selected.config.flashing?.resetAfter ?? true,
          });
          if (selected.config.flashing?.resetAfter !== false) {
            await flashSession.customRequest('continue', { threadId: 1 });
            flashOutput.appendLine('Target resumed.');
          }
          void vscode.window.showInformationMessage('Cortex Kit flash completed.');
        } finally {
          listener.dispose();
          if (flashSession) { await vscode.debug.stopDebugging(flashSession); flashOutput.appendLine('Flash session disconnected.'); }
        }
        return;
      }
      if (active.configuration.plotOnly) { void vscode.window.showErrorMessage('Flashing is disabled in Cortex Kit plot-only mode. Start a normal debug configuration first.'); return; }
      const program = expandWorkspace(active.configuration.programBinary, active.workspaceFolder);
      if (!program) { void vscode.window.showErrorMessage('No programBinary is configured.'); return; }
      await active.customRequest('cortexKit/flash', {
        path: program,
        verify: active.configuration.flashing?.verify ?? true,
        resetAfter: active.configuration.flashing?.resetAfter ?? true,
      });
      void vscode.window.showInformationMessage('Cortex Kit flash completed.');
    } catch (error) {
      flashOutput.appendLine(`Flash operation failed: ${String(error)}`);
      void vscode.window.showErrorMessage(`Cortex Kit flash failed: ${String(error)}`);
    } finally { flashing = false; }
  });
  register('cortexKit.benchmark', async () => {
    if (recorder.isRecording) { void vscode.window.showInformationMessage('请先停止 CSV 记录，再运行采样基准测试。'); return; }
    if (!active) { void vscode.window.showErrorMessage('Start or attach a Cortex Kit session first.'); return; }
    const items = variables.getVariables().filter(isPlottableVariable).filter(item => !item.id.startsWith('expr:')).map(variable => ({ label: variable.expression, description: variable.typeName, variable }));
    const selected = await vscode.window.showQuickPick(items, { canPickMany: true, placeHolder: 'Select up to eight variables for the acquisition benchmark' });
    if (!selected?.length) { return; }
    const chosen = selected.slice(0, 8).map(item => item.variable.id);
    await active.customRequest('cortexKit/setSubscriptions', { ids: chosen, requestedSamplesPerSecond: active.configuration.acquisition?.requestedSamplesPerSecond ?? 5000 });
    let result: Record<string, unknown>;
    try { result = await active.customRequest('cortexKit/benchmark', { seconds: 1 }); }
    finally { await plots.refreshSubscriptions(); }
    const channel = vscode.window.createOutputChannel('Cortex Kit Benchmark');
    channel.appendLine(JSON.stringify({
      probe: active.configuration.probe,
      chip: active.configuration.chip,
      variables: selected.slice(0, 8).map(item => ({ name: item.variable.expression, address: item.variable.address, width: item.variable.byteWidth })),
      ...result,
    }, null, 2));
    channel.show();
  });
  register('cortexKit.internal.variableCatalogStatus', () => ({
    nodeCount: variables.getVariables().length,
    plottableCount: variables.getVariables().filter(isPlottableVariable).filter(item => !item.id.startsWith('expr:')).length,
    description: variablesView.description,
  }));

  const elfWatcher = vscode.workspace.createFileSystemWatcher('**/*.{elf,axf,out}');
  const svdWatcher = vscode.workspace.createFileSystemWatcher('**/*.svd');
  const scheduleOfflineRefresh = () => { if (!active) { offlineIndex.schedule(); } };
  const scheduleSvdRefresh = () => svdIndex.schedule();
  context.subscriptions.push(
    elfWatcher,
    svdWatcher,
    elfWatcher.onDidCreate(scheduleOfflineRefresh),
    elfWatcher.onDidChange(scheduleOfflineRefresh),
    elfWatcher.onDidDelete(scheduleOfflineRefresh),
    svdWatcher.onDidCreate(scheduleSvdRefresh),
    svdWatcher.onDidChange(scheduleSvdRefresh),
    svdWatcher.onDidDelete(scheduleSvdRefresh),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('launch') || event.affectsConfiguration('cortexKit.backendPath')) { scheduleOfflineRefresh(); scheduleSvdRefresh(); }
      if (event.affectsConfiguration('cortexKit.liveWatchSamplesPerSecond')) { void plots.refreshSubscriptions(); }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { scheduleOfflineRefresh(); scheduleSvdRefresh(); }),
  );
  await Promise.all([offlineIndex.refresh(), svdIndex.refresh()]);
}

export function deactivate(): void {}

interface OfflineImage {
  filePath: string;
  label: string;
}

class OfflineVariableIndex implements vscode.Disposable {
  private refreshGeneration = 0;
  private refreshTimer?: NodeJS.Timeout;
  private cache?: { filePath: string; size: number; mtimeMs: number; catalog: VariableDescriptor[] };

  constructor(
    private readonly backendPath: string,
    private readonly variables: VariablesProvider,
    private readonly liveWatch: LiveWatchProvider,
    private readonly plots: PlotViewProvider,
    private readonly view: vscode.TreeView<VariableNode>,
    private readonly output: vscode.OutputChannel,
    private readonly canUseOfflineCatalog: () => boolean,
  ) {}

  dispose(): void {
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
  }

  schedule(delayMs = 500): void {
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, delayMs);
  }

  useLiveCatalog(catalog: VariableDescriptor[]): void {
    this.refreshGeneration += 1;
    this.apply(catalog, 'live session');
  }

  async refresh(options: { force?: boolean; notify?: boolean } = {}): Promise<boolean> {
    if (!this.canUseOfflineCatalog()) { return this.variables.hasVariables(); }
    const generation = ++this.refreshGeneration;
    const image = await this.locateImage();
    if (generation !== this.refreshGeneration || !this.canUseOfflineCatalog()) { return false; }
    if (!image) {
      this.view.description = 'No ELF configured';
      if (options.notify) { void vscode.window.showWarningMessage('No ELF/AXF was found in a Cortex Kit or Cortex-Debug launch configuration.'); }
      return false;
    }
    this.view.description = `Indexing ${path.basename(image.filePath)}…`;
    try {
      const stat = await fs.promises.stat(image.filePath);
      let catalog: VariableDescriptor[];
      if (!options.force && this.cache?.filePath === image.filePath && this.cache.size === stat.size && this.cache.mtimeMs === stat.mtimeMs) {
        catalog = this.cache.catalog;
      } else {
        catalog = await inspectElf(this.backendPath, image.filePath);
        this.cache = { filePath: image.filePath, size: stat.size, mtimeMs: stat.mtimeMs, catalog };
      }
      if (generation !== this.refreshGeneration || !this.canUseOfflineCatalog()) { return false; }
      const count = this.apply(catalog, path.basename(image.filePath));
      this.output.appendLine(`[variables] Indexed ${count} scalar fields from ${image.filePath} (${image.label}).`);
      if (options.notify) { void vscode.window.showInformationMessage(`Cortex Kit indexed ${count.toLocaleString()} global/static scalar fields from ${path.basename(image.filePath)}.`); }
      return true;
    } catch (error) {
      if (generation !== this.refreshGeneration) { return false; }
      this.view.description = 'ELF index failed';
      const message = `Could not index ${image.filePath}: ${error instanceof Error ? error.message : String(error)}`;
      this.output.appendLine(`[variables] ${message}`);
      if (options.notify) { void vscode.window.showErrorMessage(`Cortex Kit ${message}`); }
      return false;
    }
  }

  private apply(catalog: VariableDescriptor[], source: string): number {
    this.variables.setVariables(catalog);
    this.liveWatch.setCatalog(catalog);
    this.plots.setCatalog(catalog);
    const count = this.variables.getVariables().filter(isPlottableVariable).filter(item => !item.id.startsWith('expr:')).length;
    this.view.description = `${count.toLocaleString()} fields · ${source}`;
    return count;
  }

  private async locateImage(): Promise<OfflineImage | undefined> {
    let firstConfigured: OfflineImage | undefined;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const configurations = vscode.workspace.getConfiguration('launch', folder.uri).get<unknown[]>('configurations', []);
      for (const candidate of configuredProgramCandidates(configurations)) {
        const filePath = resolveConfiguredPath(candidate.configuredPath, folder.uri.fsPath);
        if (!isDwarfImage(filePath)) { continue; }
        const image = { filePath, label: candidate.name };
        firstConfigured ??= image;
        try {
          if ((await fs.promises.stat(filePath)).isFile()) { return image; }
        } catch { /* try the next configured image */ }
      }
    }
    if (firstConfigured) { return firstConfigured; }

    const discovered = await vscode.workspace.findFiles('**/*.{elf,axf,out}', '**/{node_modules,target,.git}/**', 200);
    const dated = await Promise.all(discovered.map(async uri => {
      try { return { uri, stat: await fs.promises.stat(uri.fsPath) }; } catch { return undefined; }
    }));
    const newest = dated.filter((value): value is { uri: vscode.Uri; stat: fs.Stats } => Boolean(value?.stat.isFile())).sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)[0];
    return newest ? { filePath: newest.uri.fsPath, label: 'workspace scan' } : undefined;
  }
}

interface SvdSource {
  filePath: string;
  label: string;
}

class SvdIndex implements vscode.Disposable {
  private refreshTimer?: NodeJS.Timeout;
  private generation = 0;
  private cache?: { filePath: string; size: number; mtimeMs: number; tree: SvdTree };

  constructor(
    private readonly backendPath: string,
    private readonly provider: PeripheralsProvider,
    private readonly view: vscode.TreeView<unknown>,
    private readonly output: vscode.OutputChannel,
  ) {}

  dispose(): void { if (this.refreshTimer) { clearTimeout(this.refreshTimer); } }

  schedule(delayMs = 500): void {
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
    this.refreshTimer = setTimeout(() => { this.refreshTimer = undefined; void this.refresh(); }, delayMs);
  }

  async refresh(options: { force?: boolean; notify?: boolean } = {}): Promise<boolean> {
    const source = await this.locate();
    if (!source) {
      this.generation += 1;
      this.provider.load();
      this.view.description = 'No SVD selected';
      if (options.notify) { void vscode.window.showInformationMessage('No SVD is configured. Click the file icon in Cortex Kit Peripherals to select one.'); }
      return false;
    }
    return this.loadPath(source.filePath, source.label, options);
  }

  async loadPath(filePath: string, label: string, options: { force?: boolean; notify?: boolean } = {}): Promise<boolean> {
    const generation = ++this.generation;
    this.provider.setLoading(label);
    this.view.description = `Loading ${label}…`;
    try {
      const stat = await fs.promises.stat(filePath);
      let tree: SvdTree;
      if (!options.force && this.cache?.filePath === filePath && this.cache.size === stat.size && this.cache.mtimeMs === stat.mtimeMs) {
        tree = this.cache.tree;
      } else {
        tree = await inspectSvd(this.backendPath, filePath);
        this.cache = { filePath, size: stat.size, mtimeMs: stat.mtimeMs, tree };
      }
      if (generation !== this.generation) { return false; }
      this.provider.load(tree, label);
      this.view.description = `${tree.peripherals.length.toLocaleString()} peripherals · ${tree.deviceName}`;
      const registerCount = tree.peripherals.reduce((sum, peripheral) => sum + peripheral.registers.length, 0);
      this.output.appendLine(`[svd] Indexed ${tree.peripherals.length} peripherals and ${registerCount} registers from ${filePath}.`);
      if (options.notify) { void vscode.window.showInformationMessage(`Cortex Kit loaded ${tree.deviceName}: ${tree.peripherals.length} peripherals, ${registerCount} registers.`); }
      return true;
    } catch (error) {
      if (generation !== this.generation) { return false; }
      const message = `Could not load SVD ${filePath}: ${error instanceof Error ? error.message : String(error)}`;
      this.provider.setError('SVD load failed — see Cortex Kit output');
      this.view.description = 'SVD load failed';
      this.output.appendLine(`[svd] ${message}`);
      if (options.notify) { void vscode.window.showErrorMessage(`Cortex Kit ${message}`); }
      return false;
    }
  }

  private async locate(): Promise<SvdSource | undefined> {
    let missingConfigured: SvdSource | undefined;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const configurations = vscode.workspace.getConfiguration('launch', folder.uri).get<unknown[]>('configurations', []);
      for (const value of configurations) {
        if (typeof value !== 'object' || value === null || (value as { type?: unknown }).type !== 'cortex-kit') { continue; }
        const configured = (value as { svdFile?: unknown }).svdFile;
        if (typeof configured !== 'string' || !configured.trim()) { continue; }
        const filePath = resolveConfiguredPath(configured, folder.uri.fsPath);
        const source = { filePath, label: path.basename(filePath) };
        missingConfigured ??= source;
        try { if ((await fs.promises.stat(filePath)).isFile()) { return source; } } catch { /* report the configured path if no valid entry follows */ }
      }
    }
    if (missingConfigured) { return missingConfigured; }
    const discovered = await vscode.workspace.findFiles('**/*.svd', '**/{node_modules,target,.git}/**', 20);
    return discovered.length === 1 ? { filePath: discovered[0].fsPath, label: path.basename(discovered[0].fsPath) } : undefined;
  }
}

function isWithinFolder(filePath: string, folderPath: string): boolean {
  const relative = path.relative(folderPath, filePath);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function isHalted(state: SessionState): boolean {
  return typeof state.targetState === 'object' && state.targetState !== null && 'halted' in state.targetState;
}

class ConfigurationProvider implements vscode.DebugConfigurationProvider {
  provideDebugConfigurations(): vscode.ProviderResult<vscode.DebugConfiguration[]> {
    return [{ type: 'cortex-kit', request: 'launch', name: 'Cortex Kit: Mock Debug', chip: 'Cortex-M Mock', mockProbe: true, stopOnEntry: true, acquisition: { requestedSamplesPerSecond: 1000 } }];
  }
  resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): vscode.ProviderResult<vscode.DebugConfiguration> {
    if (!config.type) { return { type: 'cortex-kit', request: 'launch', name: 'Cortex Kit: Mock Debug', chip: 'Cortex-M Mock', mockProbe: true }; }
    config.programBinary = expandWorkspace(config.programBinary, folder);
    config.svdFile = expandWorkspace(config.svdFile, folder);
    config.cwd = expandWorkspace(config.cwd, folder);
    return config;
  }
}

class AdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  constructor(private context: vscode.ExtensionContext) {}
  createDebugAdapterDescriptor(session: vscode.DebugSession): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    const executable = defaultBackendPath(this.context);
    if (!fs.existsSync(executable)) { void vscode.window.showErrorMessage(`Cortex Kit backend was not found at ${executable}. Run “Build Cortex Kit” first.`); }
    return new vscode.DebugAdapterExecutable(executable, session.configuration.mockProbe ? ['--mock'] : [], { cwd: session.workspaceFolder?.uri.fsPath });
  }
}
