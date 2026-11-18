'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const files = ['index.js', ...fs.readdirSync(path.join(root, 'src')).filter(f => f.endsWith('.js')).map(f => `src/${f}`)];
for (const file of files) new vm.Script(fs.readFileSync(path.join(root, file), 'utf8'), { filename: file });
console.log(`Sintaxis correcta: ${files.length} archivos.`);
