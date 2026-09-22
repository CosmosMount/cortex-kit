import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const executable = process.argv[2] ?? process.env.VSCODE_EXECUTABLE;
if (!executable) throw new Error('Pass the VS Code executable (Code.exe), or set VSCODE_EXECUTABLE.');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [
  '--new-window', '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
  '--user-data-dir', path.join(root, '.agents/docs/live-watch-host-profile'),
  '--extensions-dir', path.join(root, '.agents/docs/live-watch-host-extensions'),
  '--extensionDevelopmentPath', path.join(root, 'tests/fixtures/live-watch-host'),
  '--extensionTestsPath', path.join(root, 'extension/out/test/liveWatchHostRunner.js'),
], { env, stdio: 'inherit', windowsHide: true });
const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 60_000);
child.on('error', error => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
child.on('exit', code => { clearTimeout(timer); process.exitCode = process.exitCode || code || 0; });
