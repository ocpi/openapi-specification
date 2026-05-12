#!/usr/bin/env node

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join, basename, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import Handlebars from 'handlebars';

function run(cmd) {
  console.log(`  ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
}

function loadConfig(versionDir) {
  const configPath = join(versionDir, 'config.json');

  if (!existsSync(configPath)) {
    console.error(`Config file not found: ${configPath}`);
    process.exit(1);
  }

  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) {
    console.error(`Failed to parse ${configPath}: ${e.message}`);
    process.exit(1);
  }

  if (!config.modules || typeof config.modules !== 'object') {
    console.error(`Invalid config: "modules" must be an object in ${configPath}`);
    process.exit(1);
  }

  for (const [mod, modConfig] of Object.entries(config.modules)) {
    if (!Array.isArray(modConfig.interfaces)) {
      console.error(`Invalid config: module "${mod}" must have an "interfaces" array in ${configPath}`);
      process.exit(1);
    }
  }

  return config;
}

function isNonEmptyFile(filePath) {
  return existsSync(filePath) && readFileSync(filePath, 'utf8').trim().length > 0;
}

function getCommonInterfaces(fromConfig, toConfig, mod) {
  const fromInterfaces = new Set(fromConfig.modules[mod].interfaces);
  const toInterfaces = new Set(toConfig.modules[mod].interfaces);
  return [...fromInterfaces].filter(i => toInterfaces.has(i));
}

function toLabel(name) {
  return name.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

function generateMigrationGuide(fromConfig, toConfig, commonModules, addedModules, removedModules, fromVersion, toVersion, outDir) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const templatePath = join(__dirname, 'migration-guide-template.hbs');
  const template = Handlebars.compile(readFileSync(templatePath, 'utf8'));

  const summaryPath = join('migration-guides', `${fromVersion}-${toVersion}`, 'summary.asciidoc');
  const summary = existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8').trim() : null;

  const data = {
    fromVersion,
    toVersion,
    summary,
    addedModules: addedModules.map(mod => ({
      name: mod,
      label: toConfig.modules[mod].label || mod,
      description: toConfig.modules[mod].description || '',
    })),
    removedModules: removedModules.map(mod => ({
      name: mod,
      label: fromConfig.modules[mod].label || mod,
      description: fromConfig.modules[mod].description || '',
    })),
    hasComponents: isNonEmptyFile(join(outDir, 'components-schema-changelog.asciidoc')),
    commonModules: commonModules.map(mod => {
      const commonInterfaces = getCommonInterfaces(fromConfig, toConfig, mod);
      const interfaces = commonInterfaces
        .map(i => ({ name: i, label: toLabel(i) }))
        .filter(i => isNonEmptyFile(join(outDir, `${mod}-${i.name}-changelog.asciidoc`)));
      const hasSchema = existsSync(join('ocpi', fromVersion, 'modules', mod, 'schema.yaml')) &&
                        existsSync(join('ocpi', toVersion, 'modules', mod, 'schema.yaml')) &&
                        isNonEmptyFile(join(outDir, `${mod}-schema-changelog.asciidoc`));
      return {
        name: mod,
        label: (toConfig.modules[mod].label || fromConfig.modules[mod].label || mod),
        interfaces,
        hasSchema,
        hasContent: interfaces.length > 0 || hasSchema,
      };
    }),
  };

  const output = template(data);
  const dest = join(outDir, 'migration-guide.asciidoc');
  writeFileSync(dest, output, 'utf8');
  console.log(`  Generated ${dest}`);
}

function generateDiffs(fromConfig, toConfig, commonModules, fromVersionDir, toVersionDir, fromVersion, toVersion, diffDir) {
  const cwd = process.cwd();

  console.log(`\nGenerating diffs ${fromVersion} → ${toVersion} (${commonModules.length} common modules)...`);

  for (const mod of commonModules) {
    const commonInterfaces = getCommonInterfaces(fromConfig, toConfig, mod);

    for (const iface of commonInterfaces) {
      const file = `${iface}.yaml`;
      const outputFile = join(diffDir, `${mod}-${iface}_changelog-${fromVersion}-${toVersion}.json`);

      run(
        `docker run --rm -v ${cwd}/ocpi:/specs:ro -w /specs tufin/oasdiff` +
        ` changelog --flatten-allof ${fromVersion}/modules/${mod}/${file} ${toVersion}/modules/${mod}/${file}` +
        ` -f json > ${outputFile}`
      );
    }

    const fromSchemaPath = join(fromVersionDir, 'modules', mod, 'schema.yaml');
    const toSchemaPath = join(toVersionDir, 'modules', mod, 'schema.yaml');

    if (existsSync(fromSchemaPath) && existsSync(toSchemaPath)) {
      const outputFile = join(diffDir, `${mod}-schema_diff-${fromVersion}-${toVersion}.json`);

      run(
        `docker run --rm -v ${cwd}/ocpi:/specs:ro -w /specs tufin/oasdiff` +
        ` diff ${fromVersion}/modules/${mod}/schema.yaml ${toVersion}/modules/${mod}/schema.yaml` +
        ` --exclude-elements description,extensions -f json > ${outputFile}`
      );
    }
  }

  // Components (shared types like Price, Image, BusinessDetails)
  const fromComponents = join(fromVersionDir, 'components', 'schema.yaml');
  const toComponents = join(toVersionDir, 'components', 'schema.yaml');

  if (existsSync(fromComponents) && existsSync(toComponents)) {
    const outputFile = join(diffDir, `components-schema_diff-${fromVersion}-${toVersion}.json`);

    run(
      `docker run --rm -v ${cwd}/ocpi:/specs:ro -w /specs tufin/oasdiff` +
      ` diff ${fromVersion}/components/schema.yaml ${toVersion}/components/schema.yaml` +
      ` --exclude-elements description,extensions -f json > ${outputFile}`
    );
  }
}

function generateChangelogs(fromConfig, toConfig, commonModules, fromVersion, toVersion, diffDir, outDir) {
  mkdirSync(outDir, { recursive: true });

  console.log(`\nGenerating migration changelogs ${fromVersion} → ${toVersion}...`);

  console.log('\n  Endpoint changelogs:');
  for (const mod of commonModules) {
    const commonInterfaces = getCommonInterfaces(fromConfig, toConfig, mod);

    for (const iface of commonInterfaces) {
      const diffFile = join(diffDir, `${mod}-${iface}_changelog-${fromVersion}-${toVersion}.json`);
      if (!isNonEmptyFile(diffFile)) continue;

      const outputFile = join(outDir, `${mod}-${iface}-changelog.asciidoc`);
      run(
        `node scripts/generate-endpoint-changelog.js ${diffFile}` +
        ` --output=${outputFile} --specs-dir=ocpi`
      );
    }
  }

  console.log('\n  Schema changelogs:');
  for (const mod of commonModules) {
    const diffFile = join(diffDir, `${mod}-schema_diff-${fromVersion}-${toVersion}.json`);
    if (!isNonEmptyFile(diffFile)) continue;

    const outputFile = join(outDir, `${mod}-schema-changelog.asciidoc`);
    const sourceSchema = join('ocpi', fromVersion, 'modules', mod, 'schema.yaml');
    run(`node scripts/generate-schema-changelog.js ${diffFile} --output=${outputFile} --source-schema=${sourceSchema}`);
  }

  // Components (shared types)
  const componentsDiffFile = join(diffDir, `components-schema_diff-${fromVersion}-${toVersion}.json`);
  if (isNonEmptyFile(componentsDiffFile)) {
    const outputFile = join(outDir, 'components-schema-changelog.asciidoc');
    const sourceSchema = join('ocpi', fromVersion, 'components', 'schema.yaml');
    run(`node scripts/generate-schema-changelog.js ${componentsDiffFile} --output=${outputFile} --source-schema=${sourceSchema}`);
  }
}

const [fromVersionDir, toVersionDir] = process.argv.slice(2);

if (!fromVersionDir || !toVersionDir) {
  console.error('Usage: node scripts/migrate.js <from-version-dir> <to-version-dir>');
  process.exit(1);
}

const fromConfig = loadConfig(fromVersionDir);
const toConfig = loadConfig(toVersionDir);

const fromVersion = basename(fromVersionDir);
const toVersion = basename(toVersionDir);

const fromModules = new Set(Object.keys(fromConfig.modules));
const toModules = new Set(Object.keys(toConfig.modules));
const addedModules = [...toModules].filter(m => !fromModules.has(m)).sort();
const commonModules = [...toModules].filter(m => fromModules.has(m)).sort();
const removedModules = [...fromModules].filter(m => !toModules.has(m)).sort();

const diffDir = join('dist', `ocpi-migrate-${fromVersion}-${toVersion}`);
mkdirSync(diffDir, { recursive: true });

const outDir = join('dist', 'migrations', `${fromVersion}-${toVersion}`);

try {
  generateDiffs(fromConfig, toConfig, commonModules, fromVersionDir, toVersionDir, fromVersion, toVersion, diffDir);
  generateChangelogs(fromConfig, toConfig, commonModules, fromVersion, toVersion, diffDir, outDir);
  generateMigrationGuide(fromConfig, toConfig, commonModules, addedModules, removedModules, fromVersion, toVersion, outDir);
} finally {
  rmSync(diffDir, { recursive: true, force: true });
}

console.log('\nMigration complete');
