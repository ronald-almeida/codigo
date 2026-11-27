import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

for (const directory of ['api', 'lib', 'public', 'scripts']) {
  for (const file of await readdir(directory)) if (/\.(mjs|js)$/.test(file)) execFileSync(process.execPath, ['--check', join(directory, file)], { stdio: 'inherit' });
}
const config = JSON.parse(await readFile('vercel.json', 'utf8'));
if (config.outputDirectory !== 'public') throw new Error('Invalid output directory');
for (const file of ['index.html', 'obrigado.html', 'privacidade.html', 'assets/qr.svg', 'assets/pix.svg', 'assets/product.webp', 'assets/checkout-topo.png', 'assets/checkout-conteudo.png']) await readFile(join('public', file));
console.log('Syntax, configuration and required assets verified.');
