import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const output = fileURLToPath(new URL('../out/', import.meta.url));
rmSync(output, { recursive: true, force: true });
