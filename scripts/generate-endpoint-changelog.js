#!/usr/bin/env node

import fs from 'fs';
import {dirname, join} from 'path';
import {fileURLToPath} from 'url';
import Handlebars from 'handlebars';

const IMPACT = {3: 'HIGH', 2: 'MEDIUM', 1: 'LOW'};
const PARAM_LOCATIONS = new Set(['header', 'query', 'path', 'cookie']);

const titleCase = (id) => id.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

const ensure = (map, key, init) => (map.has(key) || map.set(key, init()), map.get(key));

function extractPath(text) {
  let q = [...text.matchAll(/'([^']+)'/g)].map(m => m[1]);
  if (q.length === 0) return null;
  if (text.includes('enum value')) q = q.slice(1);
  if (PARAM_LOCATIONS.has(q[0]) && q.length > 1) return `${q[0]}: ${q[1]}`;
  return q[0];
}

function groupChanges(changes) {
    const endpoints = new Map();

    for (const {operation, path, level, id, text} of changes) {
        const ep = ensure(endpoints, `${operation} ${path}`, () => ({method: operation, path, impacts: new Map()}));
        ensure(ensure(ep.impacts, level, () => new Map()), id, () => new Set()).add(extractPath(text));
    }

    return [...endpoints.values()]
        .map(({method, path, impacts}) => ({
            method,
            path,
            impacts: [3, 2, 1].filter(l => impacts.has(l)).map(l => ({
                label: IMPACT[l],
                groups: [...impacts.get(l)].map(([id, paths]) => ({
                    label: titleCase(id),
                    changes: [...paths].filter(Boolean).sort(),
                })).sort((a, b) => a.label.localeCompare(b.label)),
            })),
        }))
        .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

function main() {
    const args = process.argv.slice(2);
    const diffFile = args[0];
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const templateFile = args.find(a => !a.startsWith('--') && a !== diffFile) || join(scriptDir, 'endpoint-template.hbs');
    const outputFile = args.find(a => a.startsWith('--output='))?.slice(9);

    const changes = JSON.parse(fs.readFileSync(diffFile, 'utf8'));

    if (!Array.isArray(changes) || changes.length === 0) {
        if (outputFile) fs.writeFileSync(outputFile, '', 'utf8');
        process.exit(0);
    }

    Handlebars.registerHelper('eq', (a, b) => a === b);
    const output = Handlebars.compile(fs.readFileSync(templateFile, 'utf8'))({endpoints: groupChanges(changes)}).trim();

    if (outputFile) fs.writeFileSync(outputFile, output, 'utf8');
    else console.log(output);
}

main();
