import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const release = process.argv.includes('--release');
const localCargo = join(root, '.tooling', 'cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
const command = existsSync(localCargo) ? localCargo : 'cargo';
const args = [];
const env = { ...process.env };

if (existsSync(localCargo)) {
  if (process.platform === 'win32') { args.push('+stable-x86_64-pc-windows-gnu'); }
  env.CARGO_HOME = join(root, '.tooling', 'cargo');
  env.RUSTUP_HOME = join(root, '.tooling', 'rustup');
}
args.push('build', '-p', 'cortex-kit-dap', '--locked');
if (release) { args.push('--release'); }

const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
if (result.error) { throw result.error; }
if (result.status !== 0) { process.exit(result.status ?? 1); }
