#!/usr/bin/env node

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join, dirname, basename } from 'path';
import { tmpdir } from 'os';
import Handlebars from 'handlebars';

function run(cmd) {
  console.log(`  ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
}

function buildModules(versionDir, version, config) {
  console.log(`\nBuilding modules for ${version}...`);
  const redoclyConfig = join(versionDir, 'redocly.yaml');

  for (const [mod, modConfig] of Object.entries(config.modules)) {
    for (const iface of modConfig.interfaces) {
      const outDir = join('dist', versionDir, 'modules', mod);
      mkdirSync(outDir, { recursive: true });

      const srcFile = join(versionDir, 'modules', mod, `${iface}.yaml`);
      const outFile = join(outDir, `${iface}.html`);
      run(`redocly build-docs ${srcFile} --config ${redoclyConfig} -o ${outFile}`);
    }
  }
}

function buildRoles(versionDir, version, config) {
  if (!config.roles) return;
  console.log(`\nBuilding roles for ${version}...`);
  const redoclyConfig = join(versionDir, 'redocly.yaml');
  const outDir = join('dist', versionDir, 'roles');
  mkdirSync(outDir, { recursive: true });

  const tmpDir = join(tmpdir(), `ocpi-build-${version}`);
  mkdirSync(tmpDir, { recursive: true });

  for (const [role, modules] of Object.entries(config.roles)) {
    const specFile = join(versionDir, 'roles', `${role}-specification.yaml`);
    const moduleFiles = modules.map(m => join(versionDir, 'modules', `${m}.yaml`));
    const bundleOut = join(tmpDir, `${role}-interface.yaml`);
    const docsOut = join(outDir, `${role}-interface.html`);

    run(`redocly join --without-x-tag-groups ${specFile} ${moduleFiles.join(' ')} -o ${bundleOut}`);
    run(`redocly build-docs ${bundleOut} --config ${redoclyConfig} -o ${docsOut}`);
  }

  rmSync(tmpDir, { recursive: true, force: true });
}

function buildIndex(versionDir, version, config) {
  const templatePath = join(dirname(versionDir), 'index.html.hbs');
  if (!existsSync(templatePath)) return;

  console.log(`\nBuilding index for ${version}...`);

  const modules = Object.entries(config.modules).map(([mod, modConfig]) => ({
    label: modConfig.label || mod,
    description: modConfig.description || '',
    interfaces: modConfig.interfaces.map(iface => ({
      label: iface.replace('-', ' '),
      href: `./modules/${mod}/${iface}.html`,
    })),
  }));

  const roles = config.roles
    ? Object.keys(config.roles).map(role => ({
        label: `${role.toUpperCase()} interface`,
        href: `./roles/${role}-interface.html`,
      }))
    : [];

  const template = Handlebars.compile(readFileSync(templatePath, 'utf8'));
  const html = template({ version, modules, roles });

  const dest = join('dist', versionDir, 'index.html');
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, html);
  console.log(`  Generated ${dest}`);
}

const versionDir = process.argv[2];

if (!versionDir) {
  console.error('Usage: node scripts/build.js <version-dir>');
  process.exit(1);
}

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

const version = basename(versionDir);

buildModules(versionDir, version, config);
buildRoles(versionDir, version, config);
buildIndex(versionDir, version, config);

console.log(`\nBuild complete for ${version}`);
