import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { convertCortexDebugConfiguration, suggestedProbeRsChip } from './launchConfig';

const run = promisify(execFile);

async function selectBoundProbe(backendPath: string) {
  const family = await vscode.window.showQuickPick([
    { label: 'ST-Link', key: 'stlink' },
    { label: 'DAPLink / CMSIS-DAP', key: 'cmsisdap' },
  ], { title: 'Cortex Kit: Probe Type', placeHolder: 'Choose the type of probe to detect and bind' });
  if (!family) { return; }
  while (true) {
    let probes: Awaited<ReturnType<typeof scanProbes>>;
    try { probes = await scanProbes(backendPath); }
    catch (error) {
      const action = await vscode.window.showErrorMessage(`Probe detection failed: ${String(error)}`, 'Retry');
      if (action === 'Retry') { continue; }
      return;
    }
    const matches = probes.filter(probe => probe.probeType.toLowerCase().replace(/[^a-z]/g, '').includes(family.key));
    if (!matches.length) {
      const action = await vscode.window.showWarningMessage(`No ${family.label} detected. Connect the probe and retry.${probes.length ? ` Detected: ${probes.map(probe => probe.identifier).join(', ')}.` : ''}`, 'Retry');
      if (action === 'Retry') { continue; }
      return;
    }
    const selected = matches.length === 1 ? matches[0] : (await vscode.window.showQuickPick(matches.map(probe => ({
      label: probe.identifier, description: probe.serialNumber ?? 'no serial', detail: probe.selector, probe,
    })), { title: `Cortex Kit: Select ${family.label}`, placeHolder: 'Multiple probes detected: select the serial number to bind', matchOnDetail: true }))?.probe;
    if (!selected) { return; }
    if (matches.filter(probe => probe.selector === selected.selector).length > 1) {
      void vscode.window.showErrorMessage('These probes have identical selectors. Disconnect the other identical probes and run setup again.');
      return;
    }
    return selected;
  }
}

async function selectProbeSettings(backendPath: string) {
  const probe = await selectBoundProbe(backendPath);
  if (!probe) { return; }
  const protocol = await vscode.window.showQuickPick([
    { label: 'SWD', description: 'Typical Cortex-M connection, including DAPLink', value: 'swd' },
    { label: 'JTAG', description: 'Requires support in both probe and target', value: 'jtag' },
  ], { title: 'Cortex Kit: Debug Protocol' });
  if (!protocol) { return; }
  const speed = await vscode.window.showInputBox({
    title: 'Cortex Kit: Debug Clock', prompt: 'Requested clock in kHz (10000 = 10 MHz). Increase for throughput; reduce if connection fails. CMSIS-DAP cannot report its actual clock.', value: '10000',
    validateInput: value => /^\d+$/.test(value.trim()) && Number(value) >= 1 && Number(value) <= 4294967 ? undefined : 'Enter an integer from 1 to 4294967 kHz',
  });
  if (speed === undefined) { return; }
  const connection = await vscode.window.showQuickPick([
    { label: 'Normal connection', description: 'Do not assert reset while connecting', value: false },
    { label: 'Connect under reset', description: 'Requires wired NRST; resets the target while connecting', value: true },
  ], { title: 'Cortex Kit: Connection Mode' });
  if (!connection) { return; }
  const rate = await vscode.window.showQuickPick([
    { label: 'Maximum throughput', description: 'Request 100000 S/s; actual rate depends on probe and selected variables', value: 100000 },
    { label: '5000 S/s', description: 'Lower requested acquisition rate', value: 5000 },
    { label: '1000 S/s', description: 'Lower requested acquisition rate', value: 1000 },
  ], { title: 'Cortex Kit: Sampling Rate' });
  if (!rate) { return; }
  return { probe: { selector: probe.selector, protocol: protocol.value, speedKHz: Number(speed), connectUnderReset: connection.value }, requestedSamplesPerSecond: rate.value };
}

export async function selectProbeAndConnect(backendPath: string): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) { void vscode.window.showErrorMessage('Open a firmware workspace first.'); return; }
  if (vscode.debug.activeDebugSession?.type === 'cortex-kit') {
    void vscode.window.showWarningMessage('Stop the current Cortex Kit session before switching probes.'); return;
  }
  const launch = vscode.workspace.getConfiguration('launch', folder.uri);
  const configurations = launch.get<vscode.DebugConfiguration[]>('configurations', []);
  const choices = configurations.filter(item => item.type === 'cortex-kit' && !item.mockProbe);
  if (!choices.length) { void vscode.window.showErrorMessage('Run Cortex Kit: Configure Project to set up the chip and firmware first.'); return; }
  const probe = await selectBoundProbe(backendPath);
  if (!probe) { return; }
  const selected = choices.length === 1 ? choices[0] : (await vscode.window.showQuickPick(choices.map(configuration => ({
    label: configuration.name, description: configuration.chip, detail: 'Bind this configuration and connect in Live Plot attach mode', configuration,
  })), { title: `Connect ${probe.identifier} (${probe.serialNumber ?? 'no serial'})` }))?.configuration;
  if (!selected) { return; }
  const updated = { ...selected, probe: { ...selected.probe, selector: probe.selector } };
  await launch.update('configurations', configurations.map(item => item === selected ? updated : item), vscode.ConfigurationTarget.WorkspaceFolder);
  const connection: vscode.DebugConfiguration = {
    ...updated, request: 'attach', plotOnly: true, stopOnEntry: false,
    probe: { ...updated.probe, connectUnderReset: false },
    flashing: { enabled: false, verify: false, resetAfter: false },
  };
  delete connection.preLaunchTask;
  delete connection.postDebugTask;
  try {
    if (!await vscode.debug.startDebugging(folder, connection)) {
      void vscode.window.showErrorMessage(`Bound ${probe.identifier} (${probe.serialNumber ?? 'no serial'}), but the session did not start. Check the Debug Console for connection details.`);
    }
  } catch (error) {
    void vscode.window.showErrorMessage(`Bound ${probe.identifier}, but connection failed: ${String(error)}`);
  }
}

export async function configureProbe(backendPath: string): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) { void vscode.window.showErrorMessage('Open a firmware workspace first.'); return; }
  const launch = vscode.workspace.getConfiguration('launch', folder.uri);
  const configurations = launch.get<vscode.DebugConfiguration[]>('configurations', []);
  const choices = configurations.filter(item => item.type === 'cortex-kit' && !item.mockProbe);
  if (!choices.length) { await configureProject(backendPath); return; }
  const selected = await vscode.window.showQuickPick(choices.map(configuration => ({ label: configuration.name, configuration })), { title: 'Cortex Kit: Configure Probe / Sampling', placeHolder: 'Select the configuration to update' });
  if (!selected) { return; }
  const settings = await selectProbeSettings(backendPath);
  if (!settings) { return; }
  await launch.update('configurations', configurations.map(item => item === selected.configuration ? {
    ...item, probe: { ...item.probe, ...settings.probe }, acquisition: { ...item.acquisition, requestedSamplesPerSecond: settings.requestedSamplesPerSecond },
  } : item), vscode.ConfigurationTarget.WorkspaceFolder);
  void vscode.window.showInformationMessage(`Updated ${selected.label}: ${settings.probe.selector}, ${settings.probe.speedKHz} kHz, requested ${settings.requestedSamplesPerSecond} S/s. Start a new session to apply.`);
}

export async function configureProject(backendPath: string): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) { void vscode.window.showErrorMessage('Open a firmware workspace before configuring Cortex Kit.'); return; }
  const settings = await selectProbeSettings(backendPath);
  if (!settings) { return; }
  const targets = await scanTargets(backendPath);
  const chip = targets.length
    ? await vscode.window.showQuickPick(targets, { placeHolder: 'Search the probe-rs target registry (for STM32H723VGT6, search STM32H723VG)', matchOnDescription: true })
    : await vscode.window.showInputBox({ prompt: 'Exact probe-rs target name', placeHolder: 'STM32H723VG', validateInput: value => value.trim() ? undefined : 'A probe-rs target name is required' });
  if (!chip) { return; }
  const binaries = await vscode.workspace.findFiles('**/*.{elf,axf,out,hex,bin,uf2}', '**/{node_modules,target,.git}/**', 200);
  const selectedBinary = binaries.length ? await vscode.window.showQuickPick(binaries.map(uri => ({ label: vscode.workspace.asRelativePath(uri), uri })), { placeHolder: 'Select an existing ELF/AXF or flash image' }) : undefined;
  const svds = await vscode.workspace.findFiles('**/*.svd', '**/{node_modules,target,.git}/**', 200);
  const selectedSvd = svds.length ? await vscode.window.showQuickPick([{ label: 'Skip SVD', uri: undefined }, ...svds.map(uri => ({ label: vscode.workspace.asRelativePath(uri), uri }))], { placeHolder: 'Select an SVD file (optional)' }) : undefined;
  const tasks = await vscode.tasks.fetchTasks();
  const buildTasks = tasks.filter(task => task.group === vscode.TaskGroup.Build || /build/i.test(task.name));
  const selectedTask = buildTasks.length ? await vscode.window.showQuickPick([{ label: 'Use existing binary without build', task: undefined }, ...buildTasks.map(task => ({ label: task.name, detail: task.source, task }))], { placeHolder: 'Select pre-launch build task (optional)' }) : undefined;
  const toolchain = await scanExecutable('arm-none-eabi-gcc');
  const relative = (uri?: vscode.Uri) => uri ? '${workspaceFolder}/' + vscode.workspace.asRelativePath(uri).replace(/\\/g, '/') : undefined;
  const configuration = {
    type: 'cortex-kit', request: 'launch', name: 'Cortex Kit: Flash & Debug', cwd: '${workspaceFolder}', chip: chip.trim(),
    ...(selectedBinary?.uri ? { programBinary: relative(selectedBinary.uri) } : {}),
    ...(selectedTask?.task ? { preLaunchTask: selectedTask.task.name } : {}),
    probe: settings.probe,
    flashing: { enabled: Boolean(selectedBinary?.uri), verify: true, resetAfter: true },
    acquisition: { requestedSamplesPerSecond: settings.requestedSamplesPerSecond, maxBurstMs: 2, historySeconds: 30 },
    svdFile: relative(selectedSvd?.uri) ?? null,
  };
  const liveConfiguration: Record<string, unknown> = {
    ...configuration,
    request: 'attach',
    name: 'Cortex Kit: Live Plot (Attach)',
    plotOnly: true,
    stopOnEntry: false,
    flashing: { enabled: false, verify: false, resetAfter: false },
    acquisition: configuration.acquisition,
  };
  delete liveConfiguration.preLaunchTask;
  const launch = vscode.workspace.getConfiguration('launch', folder.uri);
  const existing = launch.get<unknown[]>('configurations', []).filter(item => !(typeof item === 'object' && item && (item as { type?: string }).type === 'cortex-kit'));
  await launch.update('configurations', [...existing, liveConfiguration, configuration], vscode.ConfigurationTarget.WorkspaceFolder);
  const status = toolchain ? `Arm GNU toolchain: ${toolchain}` : 'Arm GNU toolchain not found; existing ELF workflows remain available.';
  void vscode.window.showInformationMessage(`Cortex Kit configuration saved. ${status}`);
}

export async function importCortexDebugConfiguration(backendPath: string): Promise<boolean> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) { void vscode.window.showErrorMessage('Open a firmware workspace before importing a debug configuration.'); return false; }
  const launch = vscode.workspace.getConfiguration('launch', folder.uri);
  const configurations = launch.get<unknown[]>('configurations', []);
  const legacy = configurations.filter(item => typeof item === 'object' && item !== null && (item as { type?: string }).type === 'cortex-debug');
  if (!legacy.length) { void vscode.window.showInformationMessage('No Cortex-Debug configuration was found in this workspace.'); return false; }
  const choices = legacy.map(configuration => ({
    label: String((configuration as { name?: unknown }).name ?? 'Cortex-Debug'),
    description: String((configuration as { executable?: unknown }).executable ?? ''),
    configuration,
  }));
  const selected = choices.length === 1 ? choices[0] : await vscode.window.showQuickPick(choices, { placeHolder: 'Select a Cortex-Debug configuration to import' });
  if (!selected) { return false; }

  const device = suggestedProbeRsChip((selected.configuration as { device?: unknown }).device);
  const targets = await scanTargets(backendPath);
  const exact = device && targets.find(target => target.toLowerCase() === device.toLowerCase());
  const prefixMatches = device ? targets.filter(target => target.toLowerCase().startsWith(device.toLowerCase())) : [];
  let chip = exact ?? (prefixMatches.length === 1 ? prefixMatches[0] : undefined);
  if (!chip) {
    chip = await vscode.window.showQuickPick(targets, {
      placeHolder: device ? `Confirm probe-rs target (suggested: ${device})` : 'Select the probe-rs target',
      matchOnDescription: true,
    });
  }
  const imported = convertCortexDebugConfiguration(selected.configuration, chip ?? device);
  if (!imported || !imported.chip) { void vscode.window.showErrorMessage('The Cortex-Debug configuration does not identify a usable target chip.'); return false; }
  const importedName = imported.name;
  const updated = configurations.filter(item => !(typeof item === 'object' && item !== null && (item as { type?: unknown; name?: unknown }).type === 'cortex-kit' && (item as { name?: unknown }).name === importedName));
  await launch.update('configurations', [...updated, imported], vscode.ConfigurationTarget.WorkspaceFolder);
  void vscode.window.showInformationMessage(`Imported “${String(importedName)}”. Global variables can now be indexed before debugging starts.`);
  return true;
}

export async function scanProbes(backendPath: string): Promise<Array<{ selector: string; identifier: string; serialNumber?: string; probeType: string }>> {
  const { stdout } = await run(backendPath, ['--list-probes'], { windowsHide: true, timeout: 10000 });
  return JSON.parse(stdout);
}
export async function scanTargets(backendPath: string): Promise<string[]> { try { const { stdout } = await run(backendPath, ['--list-targets'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }); return JSON.parse(stdout); } catch { return []; } }
async function scanExecutable(name: string): Promise<string | undefined> { try { const command = process.platform === 'win32' ? 'where.exe' : 'which'; const { stdout } = await run(command, [name], { windowsHide: true }); return stdout.split(/\r?\n/).find(Boolean); } catch { return undefined; } }
export function expandWorkspace(value: string | undefined, folder?: vscode.WorkspaceFolder): string | undefined { return value && folder ? value.replace(/\$\{workspaceFolder\}/g, folder.uri.fsPath) : value; }
export function defaultBackendPath(context: vscode.ExtensionContext): string {
  const configured = vscode.workspace.getConfiguration('cortexKit').get<string>('backendPath', '');
  if (configured) { return configured; }
  const executable = process.platform === 'win32' ? 'cortex-kit-dap.exe' : 'cortex-kit-dap';
  const bundled = path.join(context.extensionPath, 'bin', executable);
  return require('node:fs').existsSync(bundled) ? bundled : path.join(context.extensionPath, '..', 'target', 'debug', executable);
}
