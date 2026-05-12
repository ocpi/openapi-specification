#!/usr/bin/env node

import fs from 'fs';
import {dirname, join, resolve} from 'path';
import {fileURLToPath} from 'url';
import Handlebars from 'handlebars';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IMPACT = {3: 'HIGH', 2: 'MEDIUM', 1: 'LOW'};
const PARAM_LOCATIONS = new Set(['header', 'query', 'path', 'cookie']);

const titleCase = (id) =>
    id.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

/** Extract type name and external file path from a schema's $ref. */
function resolveRef(schema) {
    const ref = schema?.$ref ?? schema?.items?.$ref;
    if (!ref) return {type: null, file: null};
    const [file, fragment] = ref.split('#');
    return {type: fragment?.split('/').pop() ?? null, file: file || null};
}

/**
 * Build a property→type map by recursively loading schema files,
 * starting from seedFiles and following $ref links across files.
 */
function buildTypeMap(seedFiles) {
    const typeMap = {};
    const visited = new Set();
    const queue = seedFiles.map(f => resolve(f));

    while (queue.length) {
        const filePath = queue.pop();
        if (visited.has(filePath)) continue;
        visited.add(filePath);

        let doc;
        try {
            doc = yaml.load(fs.readFileSync(filePath, 'utf8'));
        } catch {
            continue;
        }

        for (const [typeName, schema] of Object.entries(doc?.components?.schemas ?? {})) {
            if (!schema?.properties) continue;
            typeMap[typeName] ??= {};

            for (const [prop, propSchema] of Object.entries(schema.properties)) {
                const {type, file} = resolveRef(propSchema);
                if (type) typeMap[typeName][prop] = type;
                if (file) queue.push(resolve(dirname(filePath), file));
            }
        }
    }
    return typeMap;
}

/**
 * Parse an interface spec to find the top-level schema type per endpoint.
 * Returns { response: { "METHOD /path": type }, request: { ... } }.
 */
function buildEndpointTypes(specPath) {
    let doc;
    try {
        doc = yaml.load(fs.readFileSync(specPath, 'utf8'));
    } catch {
        return {response: {}, request: {}};
    }

    const response = {}, request = {};

    for (const [path, methods] of Object.entries(doc.paths ?? {})) {
        for (const [method, op] of Object.entries(methods)) {
            if (typeof op !== 'object') continue;
            const key = `${method.toUpperCase()} ${path}`;

            // Response: unwrap allOf/OCPIResponse envelope to find the data schema
            const res = op.responses?.['200']?.content?.['application/json']?.schema;
            if (res) {
                const data = res.allOf?.find(p => p.properties?.data)?.properties.data
                    ?? res.properties?.data
                    ?? (res.$ref ? res : null);
                const {type} = resolveRef(data);
                if (type) response[key] = type;
            }

            // Request body
            const {type} = resolveRef(op.requestBody?.content?.['application/json']?.schema);
            if (type) request[key] = type;
        }
    }
    return {response, request};
}

/**
 * Load spec metadata for human-readable paths.
 * Returns null when unavailable (paths render raw).
 */
function loadSpecMeta(specsDir, changes) {
    const source = changes.find(c => c.source)?.source;
    if (!specsDir || !source) return null;

    const specPath = resolve(specsDir, source);
    if (!fs.existsSync(specPath)) return null;

    const schemaPath = join(dirname(specPath), 'schema.yaml');

    return {
        ...buildEndpointTypes(specPath),
        typeMap: buildTypeMap(fs.existsSync(schemaPath) ? [schemaPath] : []),
    };
}

/** Extract the property path or parameter reference from oasdiff change text. */
function extractPath(text) {
    const quoted = [...text.matchAll(/['`]([^'`]+)['`]/g)].map(m => m[1]);
    if (!quoted.length) return null;

    const paths = text.includes('enum value') ? quoted.slice(1) : quoted;
    if (PARAM_LOCATIONS.has(paths[0]) && paths.length > 1) return `${paths[0]}: ${paths[1]}`;
    return paths[0];
}

/** Format a type annotation as an AsciiDoc cross-reference link. */
function typeRef(typeName) {
    return `<<_${typeName.toLowerCase()},${typeName}>>`;
}

/**
 * Convert a raw property path to a human-readable description
 * like `taxes (on data[CDR] > total_cost[Price])` by walking the spec type graph.
 * Type annotations link to their schema section in the migration guide.
 */
function humanizePath(rawPath, endpointKey, specMeta, isRequest) {
    if (!rawPath || !specMeta) return rawPath;
    if (PARAM_LOCATIONS.has(rawPath.split(':')[0]?.trim())) return rawPath;

    const topType = isRequest ? specMeta.request[endpointKey] : specMeta.response[endpointKey];

    // Keep "data" (or "data/items") as the root segment, then the rest
    const withoutData = rawPath.replace(/^data\/(items\/)?/, '');
    const segments = withoutData.split('/').filter(s => s && s !== 'items');
    if (!segments.length) return rawPath;

    const property = segments.pop();
    const chain = [];
    let current = topType;

    // Root: "data" annotated with the top-level type
    if (topType) chain.push(`data[${typeRef(topType)}]`);

    for (const seg of segments) {
        const resolved = current ? specMeta.typeMap[current]?.[seg] : null;
        chain.push(resolved ? `${seg}[${typeRef(resolved)}]` : seg);
        current = resolved ?? null;
    }

    return chain.length ? `${property} (on ${chain.join(' > ')})` : property;
}

/** Group flat oasdiff changes into: endpoint → impact → change type → paths. */
function groupChanges(changes, specMeta) {
    const endpoints = {};

    for (const {operation, path, level, id, text} of changes) {
        const key = `${operation} ${path}`;
        const ep = endpoints[key] ??= {method: operation, path, impacts: {}};
        const group = (ep.impacts[level] ??= {})[id] ??= new Set();
        const isRequest = id.startsWith('request-') || id.startsWith('new-') || text.includes('request property');
        group.add(humanizePath(extractPath(text), key, specMeta, isRequest));
    }

    return Object.values(endpoints)
        .map(({method, path, impacts}) => ({
            method,
            path,
            impacts: [3, 2, 1]
                .filter(l => impacts[l])
                .map(l => ({
                    label: IMPACT[l],
                    groups: Object.entries(impacts[l])
                        .map(([id, paths]) => ({label: titleCase(id), changes: [...paths].filter(Boolean).sort()}))
                        .sort((a, b) => a.label.localeCompare(b.label)),
                })),
        }))
        .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

/* ── Main ─────────────────────────────────────────────────────────── */
function main() {
    const args = process.argv.slice(2);
    const diffFile = args[0];
    const specsDir = args.find(a => a.startsWith('--specs-dir='))?.split('=')[1];
    const outputFile = args.find(a => a.startsWith('--output='))?.split('=')[1];

    const changes = JSON.parse(fs.readFileSync(diffFile, 'utf8'));

    if (!Array.isArray(changes) || !changes.length) {
        if (outputFile) fs.writeFileSync(outputFile, '', 'utf8');
        process.exit(0);
    }

    Handlebars.registerHelper('eq', (a, b) => a === b);
    const template = Handlebars.compile(fs.readFileSync(join(__dirname, 'endpoint-template.hbs'), 'utf8'));
    const output = template({endpoints: groupChanges(changes, loadSpecMeta(specsDir, changes))}).trim();

    if (outputFile) fs.writeFileSync(outputFile, output, 'utf8');
    else console.log(output);
}

main();
