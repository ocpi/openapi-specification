#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Handlebars from 'handlebars';
import yaml from 'js-yaml';

const sort = (values) => [...new Set(values)].sort((a, b) => a.localeCompare(b));
const getOptionValue = (args, optionName) => args.find((arg) => arg.startsWith(`${optionName}=`))?.slice(optionName.length + 1) || null;
const classChange = (kind, referencedType) => (referencedType ? `\`${referencedType}\` type ${kind}` : `Property ${kind}`);
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

function pushChange(changeMap, itemName, text) {
  changeMap.set(itemName, [...(changeMap.get(itemName) || []), text]);
}

function pushBatch(changeMap, itemNames, buildText) {
  for (const itemName of itemNames || []) pushChange(changeMap, itemName, buildText(itemName));
}

function buildReferencedTypeMap(sourceSchemaPath) {
  if (!sourceSchemaPath) return new Map();
  const sourceSchemas = yaml.load(fs.readFileSync(sourceSchemaPath, 'utf8'))?.components?.schemas || {};

  const typeMapBySchema = new Map();
  for (const [schemaName, schemaDef] of Object.entries(sourceSchemas)) {
    const schemaProperties = schemaDef?.properties || {};
    const typeMapByProperty = new Map();

    for (const [propertyName, propertyDef] of Object.entries(schemaProperties)) {
      const ref = propertyDef?.$ref || propertyDef?.items?.$ref;
      if (ref) typeMapByProperty.set(propertyName, ref.split('/').pop());
    }

    if (typeMapByProperty.size > 0) typeMapBySchema.set(schemaName, typeMapByProperty);
  }
  return typeMapBySchema;
}

function buildModifiedSchemaChanges(modifiedSchemas, referencedTypeMapBySchema) {
  return Object.entries(modifiedSchemas || {}).map(([schemaName, schemaDiff]) => {
    const changeMap = new Map();
    const schemaType = schemaDiff?.enum ? 'enum' : 'class';
    if (schemaType === 'enum') {
      const addedEnumValues = schemaDiff?.enum?.added || [];
      const deletedEnumValues = schemaDiff?.enum?.deleted || [];
      pushBatch(changeMap, addedEnumValues, () => 'Enum value added');
      pushBatch(changeMap, deletedEnumValues, () => 'Enum value deleted');
    } else {
      const propertyDiff = schemaDiff?.properties || {};
      const requiredDiff = schemaDiff?.required || {};
      const propertyTypeMap = referencedTypeMapBySchema.get(schemaName) || new Map();
      const getReferencedType = (propertyName) => propertyTypeMap.get(propertyName);

      pushBatch(changeMap, propertyDiff.added, (propertyName) => classChange('added', getReferencedType(propertyName)));
      pushBatch(changeMap, propertyDiff.deleted, (propertyName) => classChange('deleted', getReferencedType(propertyName)));
      pushBatch(changeMap, requiredDiff.added, () => 'Property became required');
      pushBatch(changeMap, requiredDiff.deleted, () => 'Property became optional');

      for (const [propertyName, propertyNode] of Object.entries(propertyDiff.modified || {})) {
        const referencedTypeName = getReferencedType(propertyName);
        if (referencedTypeName) {
          pushChange(changeMap, propertyName, classChange('modified', referencedTypeName));
        } else {
          const inlineChanges = describeInlinePropertyChanges(propertyNode);
          if (inlineChanges.length === 0) {
            pushChange(changeMap, propertyName, 'Property modified');
          } else {
            for (const inlineChange of inlineChanges) pushChange(changeMap, propertyName, inlineChange);
          }
        }
      }
    }

    return {
      name: schemaName,
      type: schemaType,
      topLevelChanges: describeTopLevelChanges(schemaDiff),
      changes: [...changeMap.entries()]
        .map(([name, entries]) => ({ name, changelog: sort(entries) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function main() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const args = process.argv.slice(2);

  if (args.length < 1 || args.includes('--help')) {
    console.error('Usage: node scripts/generate-simple-schema-changelog.js <schema-diff-json-file> [template-file]');
    console.error('Options:');
    console.error('  --output=<file>              Write to file instead of stdout');
    console.error('  --source-schema=<file>       Source schema YAML used for property type names');
    process.exit(args.includes('--help') ? 0 : 1);
  }

  const diffFile = args[0];
  const templateFile = args.find((arg) => !arg.startsWith('--') && arg !== diffFile)
    || path.join(__dirname, 'schema-template.hbs');
  const outputFile = getOptionValue(args, '--output');
  const sourceSchema = getOptionValue(args, '--source-schema');

  const diffData = JSON.parse(fs.readFileSync(diffFile, 'utf8'));
  const schemaDiff = diffData?.components?.schemas || {};
  const referencedTypeMapBySchema = buildReferencedTypeMap(sourceSchema);

  const data = {
    added: sort(schemaDiff.added || []),
    modified: buildModifiedSchemaChanges(schemaDiff.modified, referencedTypeMapBySchema),
    deleted: sort(schemaDiff.deleted || []),
  };

  Handlebars.registerHelper('eq', (a, b) => a === b);
  Handlebars.registerHelper('lowercase', (value) => value?.toLowerCase() ?? '');
  const template = Handlebars.compile(fs.readFileSync(templateFile, 'utf8'));
  const output = template(data).trim();

  if (outputFile) {
    fs.writeFileSync(outputFile, output, 'utf8');
  } else {
    console.log(output);
  }
}

main();
