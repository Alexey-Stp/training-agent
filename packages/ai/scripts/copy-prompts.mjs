// Copies the prompt templates (src/prompts/*.md) next to the compiled code, which loads them
// from ../prompts relative to dist/context/
import { cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
cpSync(join(root, 'src', 'prompts'), join(root, 'dist', 'prompts'), { recursive: true });
