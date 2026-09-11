import { access, copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const executable = process.platform === 'win32' ? 'cortex-kit-dap.exe' : 'cortex-kit-dap';
const profile = process.argv.includes('--release') ? 'release' : 'debug';
const source = join(root, 'target', profile, executable);
const destination = join(here, '..', 'bin', executable);
await access(source).catch(() => {
  throw new Error(`Missing ${profile} backend at ${source}. Build it before bundling the extension.`);
});
await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);
