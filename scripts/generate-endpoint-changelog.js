#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Handlebars from 'handlebars';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const IMPACT_LABELS = ['None', 'Low', 'Medium', 'High'];

function isRequestBodyPropertyChange(entry) {
  return /request property/.test(entry.text);
}

function isResponseBodyPropertyChange(entry) {
  return /'data\/[^']+'/.test(entry.text);
}

function summarizeBodyChanges(bodyChanges) {
  const counts = { High: 0, Medium: 0, Low: 0 };
  for (const c of bodyChanges) {
    const label = IMPACT_LABELS[c.level];
    if (label in counts) counts[label]++;
  }
  const maxLevel = Math.max(...bodyChanges.map(c => c.level));
  const parts = [];
  for (const label of ['High', 'Medium', 'Low']) {
    if (counts[label] > 0) parts.push(`${counts[label]} ${label}`);
  }
  return {
    count: bodyChanges.length,
    impactLabel: IMPACT_LABELS[maxLevel],
    breakdown: parts.join(', '),
  };
}

function main() {
  const args = process.argv.slice(2);

  if (args.length < 1 || args.includes('--help')) {
    console.error('Usage: node generate-endpoint-changelog.js <changelog-json-file> [template-file]');
    console.error('Options:');
    console.error('  --output=<file>                Write to file instead of stdout');
    console.error('  --ignore-descriptions          Ignore description-only changes');
    console.error('  --summarize-body               Collapse request/response body property changes into a summary');
    process.exit(args.includes('--help') ? 0 : 1);
  }

  let diffFile = args[0];
  let templateFile = path.join(__dirname, 'endpoint-template.hbs');
  let outputFile = null;
  let ignoreDescriptions = false;
  let summarizeBody = false;

  for (const arg of args.slice(1)) {
    if (arg.startsWith('--output=')) outputFile = arg.split('=')[1];
    else if (arg === '--ignore-descriptions') ignoreDescriptions = true;
    else if (arg === '--summarize-body') summarizeBody = true;
    else if (!arg.startsWith('--')) templateFile = arg;
  }

  const entries = JSON.parse(fs.readFileSync(diffFile, 'utf8'));
  const template = Handlebars.compile(fs.readFileSync(templateFile, 'utf8'));

  const grouped = new Map();
  for (const entry of entries) {
    if (ignoreDescriptions && entry.id.includes('description')) continue;
    const key = `${entry.operation} ${entry.path}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(entry);
  }

  const endpoints = [];

  for (const [key, changes] of [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const [operation, ...pathParts] = key.split(' ');
    const endpointPath = pathParts.join(' ');
    const maxLevel = Math.max(...changes.map(c => c.level));

    let visibleChanges = changes;
    let requestBodySummary = null;
    let responseBodySummary = null;

    if (summarizeBody) {
      const endpointLevel = [];
      const requestBody = [];
      const responseBody = [];
      for (const c of changes) {
        if (isRequestBodyPropertyChange(c)) requestBody.push(c);
        else if (isResponseBodyPropertyChange(c)) responseBody.push(c);
        else endpointLevel.push(c);
      }
      visibleChanges = endpointLevel;
      if (requestBody.length > 0) {
        requestBodySummary = summarizeBodyChanges(requestBody);
      }
      if (responseBody.length > 0) {
        responseBodySummary = summarizeBodyChanges(responseBody);
      }
    }

    endpoints.push({
      operation,
      path: endpointPath,
      impactLabel: IMPACT_LABELS[maxLevel] || 'Unknown',
      changes: visibleChanges.map(c => ({
        id: c.id,
        text: c.text,
        level: c.level,
        impactLabel: IMPACT_LABELS[c.level] || 'Unknown',
      })),
      requestBodySummary,
      responseBodySummary,
    });
  }

  const output = template({ endpoints, ignoreDescriptions });

  if (outputFile) {
    fs.writeFileSync(outputFile, output, 'utf8');
  } else {
    console.log(output);
  }
}

main();
