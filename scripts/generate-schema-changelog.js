#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import Handlebars from 'handlebars';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sort = (values) => [...new Set(values)].sort((a, b) => a.localeCompare(b));
const typeRef = (name) => `<<_${name.toLowerCase()},${name}>>`;
const classChange = (kind, referencedType) => (referencedType ? `${typeRef(referencedType)} type ${kind}` : `Property ${kind}`);
const TOP_LEVEL_KEYS = new Set(['format']);

function collectFromToChanges(node, allowedKeys = null) {
    const changes = [];
    for (const [name, diff] of Object.entries(node || {})) {
        if (allowedKeys && !allowedKeys.has(name)) continue;
        if (diff && typeof diff === 'object' && 'from' in diff && 'to' in diff) {
            changes.push(`\`${name}\` changed from \`${diff.from}\` to \`${diff.to}\``);
        } else {
            console.warn(`Unexpected diff format for ${name}:`, diff);
        }
    }
    return changes;
}

function collectEnumValueChanges(node) {
    const changes = [];
    for (const enumValue of node?.enum?.added || []) changes.push(`Enum value ${enumValue} added`);
    for (const enumValue of node?.enum?.deleted || []) changes.push(`Enum value ${enumValue} deleted`);
    return changes;
}

function describeInlinePropertyChanges(propertyNode) {
    return sort([
        ...collectFromToChanges(propertyNode),
        ...collectEnumValueChanges(propertyNode),
    ]);
}

function describeTopLevelChanges(schemaDiff) {
    return sort(collectFromToChanges(schemaDiff, TOP_LEVEL_KEYS));
}

function buildReferencedTypeMap(sourceSchemaPath) {
    if (!sourceSchemaPath) return {};
    const sourceSchemas = yaml.load(fs.readFileSync(sourceSchemaPath, 'utf8'))?.components?.schemas || {};

    const typeMap = {};
    for (const [schemaName, schemaDef] of Object.entries(sourceSchemas)) {
        const props = {};
        for (const [propName, propDef] of Object.entries(schemaDef?.properties || {})) {
            const ref = propDef?.$ref || propDef?.items?.$ref;
            if (ref) props[propName] = ref.split('/').pop();
        }
        if (Object.keys(props).length) typeMap[schemaName] = props;
    }
    return typeMap;
}

function buildModifiedSchemaChanges(modifiedSchemas, referencedTypeMap) {
    return Object.entries(modifiedSchemas || {}).map(([schemaName, schemaDiff]) => {
        const changes = {};
        const schemaType = schemaDiff?.enum ? 'enum' : 'class';

        if (schemaType === 'enum') {
            for (const v of schemaDiff?.enum?.added || []) (changes[v] ??= []).push('Enum value added');
            for (const v of schemaDiff?.enum?.deleted || []) (changes[v] ??= []).push('Enum value deleted');
        } else {
            const propertyDiff = schemaDiff?.properties || {};
            const requiredDiff = schemaDiff?.required || {};
            const refType = (name) => referencedTypeMap[schemaName]?.[name];

            for (const p of propertyDiff.added || []) (changes[p] ??= []).push(classChange('added', refType(p)));
            for (const p of propertyDiff.deleted || []) (changes[p] ??= []).push(classChange('deleted', refType(p)));
            for (const p of requiredDiff.added || []) (changes[p] ??= []).push('Property became required');
            for (const p of requiredDiff.deleted || []) (changes[p] ??= []).push('Property became optional');

            for (const [p, node] of Object.entries(propertyDiff.modified || {})) {
                if (refType(p)) {
                    (changes[p] ??= []).push(classChange('modified', refType(p)));
                } else {
                    const inline = describeInlinePropertyChanges(node);
                    for (const text of inline.length ? inline : ['Property modified']) (changes[p] ??= []).push(text);
                }
            }
        }

        return {
            name: schemaName,
            type: schemaType,
            topLevelChanges: describeTopLevelChanges(schemaDiff),
            changes: Object.entries(changes)
                .map(([name, entries]) => ({name, changelog: sort(entries)}))
                .sort((a, b) => a.name.localeCompare(b.name)),
        };
    }).sort((a, b) => a.name.localeCompare(b.name));
}

/* ── Main ─────────────────────────────────────────────────────────── */
function main() {
    const args = process.argv.slice(2);
    const diffFile = args[0];
    const outputFile = args.find(a => a.startsWith('--output='))?.split('=')[1];
    const sourceSchema = args.find(a => a.startsWith('--source-schema='))?.split('=')[1];

    const diffData = JSON.parse(fs.readFileSync(diffFile, 'utf8'));
    const schemaDiff = diffData?.components?.schemas || {};
    const referencedTypeMap = buildReferencedTypeMap(sourceSchema);

    const data = {
        added: sort(schemaDiff.added || []),
        modified: buildModifiedSchemaChanges(schemaDiff.modified, referencedTypeMap),
        deleted: sort(schemaDiff.deleted || []),
    };

    Handlebars.registerHelper('eq', (a, b) => a === b);
    const template = Handlebars.compile(fs.readFileSync(path.join(__dirname, 'schema-template.hbs'), 'utf8'));
    const output = template(data).trim();

    if (outputFile) fs.writeFileSync(outputFile, output, 'utf8');
    else console.log(output);
}

main();