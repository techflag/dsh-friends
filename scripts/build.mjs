import { build } from 'esbuild';
import { mkdir, writeFile, rm } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await mkdir('dist');
await build({ entryPoints:['src/index.ts'], outfile:'dist/index.js', bundle:true, format:'esm', platform:'node', target:'node24', external:['@deepseek-ai/*'], sourcemap:true });
const client = await build({ entryPoints:['src/client.tsx'], bundle:true, write:false, format:'cjs', platform:'browser', target:'es2022', external:['@deepseek-ai/*','react','react/jsx-runtime'] });
await writeFile('dist/client.browser.js', `window.__ModuleLoader__.load({id:"dsh-friends",factory:function(require){const module={exports:{}};\n${client.outputFiles[0].text}\nreturn module.exports;}});\n`);
console.log('Built DSH Friends Host and native Client.');
