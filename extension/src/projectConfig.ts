import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { convertCortexDebugConfiguration, suggestedProbeRsChip } from './launchConfig';

const run = promisify(execFile);

export async function configureProject(backendPath: string): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) { void vscode.window.showErrorMessage('Open a firmware workspace before configuring Cortex Kit.'); return; }
  const probes = await scanProbes(backendPath);
  const probe = probes.length ? await vscode.window.showQuickPick(probes.map(item => ({ label: item.identifier, description: item.serialNumber ?? 'no serial', detail: item.probeType, selector: item.selector })), { placeHolder: 'Select ST-Link or CMSIS-DAP probe' }) : undefined;
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
    probe: { selector: probe?.selector ?? 'auto', protocol: 'swd', speedKHz: 10000, connectUnderReset: false },
    flashing: { enabled: Boolean(selectedBinary?.uri), verify: true, resetAfter: true },
    acquisition: { requestedSamplesPerSecond: 5000, maxBurstMs: 2, historySeconds: 30 },
    svdFile: relative(selectedSvd?.uri) ?? null,
  };
  const liveConfiguration: Record<string, unknown> = {
    ...configuration,
    request: 'attach',
    name: 'Cortex Kit: Live Plot (Attach)',
    plotOnly: true,
    stopOnEntry: false,
    flashing: { enabled: false, verify: false, resetAfter: false },
    acquisition: { requestedSamplesPerSecond: 1000, maxBurstMs: 2, historySeconds: 30 },
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
  try { const { stdout } = await run(backendPath, ['--list-probes'], { windowsHide: true }); return JSON.parse(stdout); } catch { return []; }
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
