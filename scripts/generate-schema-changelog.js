#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Handlebars from 'handlebars';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STRUCTURAL_KEYS = new Set(['properties', 'items', 'extensions', 'enum', 'required']);

function addNodeChanges(node, changes) {
  for (const [key, value] of Object.entries(node)) {
    if (STRUCTURAL_KEYS.has(key)) continue;
    if (value && typeof value === 'object' && 'from' in value && 'to' in value) {
      if (key === 'description') {
        changes.push({ text: 'Description changed', isDescription: true });
      } else {
        changes.push({ text: `\`${key}\` changed from \`${value.from}\` to \`${value.to}\`` });
      }
    }
  }

  for (const v of node.enum?.added || []) {
    changes.push({ enumValue: v, enumChange: 'Enum value added' });
  }
  for (const v of node.enum?.deleted || []) {
    changes.push({ enumValue: v, enumChange: 'Enum value removed' });
  }

  for (const v of node.required?.added || []) {
    changes.push({ text: `\`${v}\` became required` });
  }
  for (const v of node.required?.deleted || []) {
    changes.push({ text: `\`${v}\` no longer required` });
  }

  const enumDescs = node.extensions?.modified?.['x-enumDescriptions'];
  if (Array.isArray(enumDescs)) {
    for (const entry of enumDescs) {
      const name = entry.path?.replace(/^\//, '') || '';
      if (entry.op === 'replace') {
        changes.push({ enumValue: name, enumChange: 'Description changed', isDescription: true });
      }
    }
  }

  for (const v of node.properties?.added || []) {
    changes.push({ text: `Property \`${v}\` added` });
  }
  for (const v of node.properties?.deleted || []) {
    changes.push({ text: `Property \`${v}\` removed` });
  }
  for (const name of Object.keys(node.properties?.modified || {})) {
    changes.push({ text: `Property \`${name}\` modified` });
  }
}

function collectNodeChanges(node) {
  const changes = [];
  addNodeChanges(node, changes);
  let current = node;
  while (current.items && typeof current.items === 'object') {
    current = current.items;
    addNodeChanges(current, changes);
  }
  return changes;
}

function filterDescriptions(changes) {
  return changes.filter(c => !c.isDescription);
}

function isTypeStructureChange(c) {
  return c.text?.startsWith('Property ') ||
         c.text?.includes('became required') ||
         c.text?.includes('no longer required');
}

function splitEnumChanges(changes) {
  const enumMap = new Map();
  const other = [];

  for (const c of changes) {
    if (c.enumValue) {
      if (!enumMap.has(c.enumValue)) enumMap.set(c.enumValue, []);
      enumMap.get(c.enumValue).push(c.enumChange);
    } else {
      other.push(c);
    }
  }

  const enumValues = [...enumMap.entries()].map(([value, changelist]) => ({
    value,
    changelog: changelist.join(', '),
  }));

  return { enumValues, other };
}

function processSchemas(schemas, ignoreDescriptions) {
  const modified = [];

  for (const [name, node] of Object.entries(schemas.modified || {})) {
    let rawRootChanges = [];
    addNodeChanges(node, rawRootChanges);
    if (ignoreDescriptions) rawRootChanges = filterDescriptions(rawRootChanges);
    rawRootChanges = rawRootChanges.filter(c => !c.text?.startsWith('Property '));
    const { enumValues: rootEnumValues, other: rootChanges } = splitEnumChanges(rawRootChanges);

    const properties = [];
    for (const v of node.properties?.added || []) {
      properties.push({ name: v, changes: [{ text: 'Property added' }] });
    }
    for (const v of node.properties?.deleted || []) {
      properties.push({ name: v, changes: [{ text: 'Property removed' }] });
    }
    for (const [propName, child] of Object.entries(node.properties?.modified || {})) {
      let rawChanges = collectNodeChanges(child);
      if (ignoreDescriptions) rawChanges = filterDescriptions(rawChanges);
      if (rawChanges.length === 0) continue;
      const hasTypeChanges = rawChanges.some(isTypeStructureChange);
      const filtered = rawChanges.filter(c => !isTypeStructureChange(c));
      const { enumValues, other } = splitEnumChanges(filtered);
      const hasEnumChanges = enumValues.length > 0;
      const changes = hasEnumChanges ? other.filter(c => !c.text?.startsWith('`format`')) : other;
      properties.push({ name: propName, changes, hasEnumChanges, hasTypeChanges });
    }

    if (rootChanges.length > 0 || rootEnumValues.length > 0 || properties.length > 0) {
      modified.push({ name, rootChanges, rootEnumValues, properties });
    }
  }

  return {
    added: schemas.added || [],
    deleted: schemas.deleted || [],
    modified,
  };
}

function main() {
  const args = process.argv.slice(2);

  if (args.length < 1 || args.includes('--help')) {
    console.error('Usage: node generate-schema-changelog.js <diff-json-file> [template-file]');
    console.error('Options:');
    console.error('  --output=<file>          Write to file instead of stdout');
    console.error('  --ignore-descriptions    Ignore description-only changes');
    process.exit(args.includes('--help') ? 0 : 1);
  }

  let diffFile = args[0];
  let templateFile = path.join(__dirname, 'schema-template.hbs');
  let outputFile = null;
  let ignoreDescriptions = false;

  for (const arg of args.slice(1)) {
    if (arg.startsWith('--output=')) outputFile = arg.split('=')[1];
    else if (arg === '--ignore-descriptions') ignoreDescriptions = true;
    else if (!arg.startsWith('--')) templateFile = arg;
  }

  const diffData = JSON.parse(fs.readFileSync(diffFile, 'utf8'));
  const schemas = diffData?.components?.schemas || { added: [], deleted: [], modified: {} };
  const data = processSchemas(schemas, ignoreDescriptions);

  const template = Handlebars.compile(fs.readFileSync(templateFile, 'utf8'));
  const output = template(data);

  if (outputFile) {
    fs.writeFileSync(outputFile, output, 'utf8');
  } else {
    console.log(output);
  }
}

main();
