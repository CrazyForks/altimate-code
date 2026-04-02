#!/usr/bin/env bun
/**
 * Mirrors publish.ts exactly — creates all dist packages and packs them as tarballs.
 * Stops before `npm publish`. Injects local altimate-core tarballs from /tmp/altimate-local-dist/.
 *
 * Usage: bun run script/pack-local.ts
 */

import { $ } from "bun"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { Script } from "@opencode-ai/script"
import pkg from "../package.json"

const LOCAL_DIST = "/tmp/altimate-local-dist"
const OUT = "/tmp/altimate-local-dist"

// ── Discover built binaries ──────────────────────────────────────────────────
const binaries: Record<string, string> = {}
for (const filepath of new Bun.Glob("**/package.json").scanSync({ cwd: "./dist" })) {
  const p = await Bun.file(`./dist/${filepath}`).json()
  if (!p.name || !p.version) continue
  binaries[p.name] = p.version
}
console.log("Platform binaries:", Object.keys(binaries))
const version = Object.values(binaries)[0]
const sanitizedVersion = version.replace(/\//g, "-")
console.log("Version:", sanitizedVersion)

// ── Sanitize platform binary package.json versions ───────────────────────────
for (const filepath of new Bun.Glob("**/package.json").scanSync({ cwd: "./dist" })) {
  const pkgPath = `./dist/${filepath}`
  const p = await Bun.file(pkgPath).json()
  if (!p.name || !p.version) continue
  if (p.version.includes("/")) {
    p.version = p.version.replace(/\//g, "-")
    await Bun.file(pkgPath).write(JSON.stringify(p, null, 2))
  }
}

// ── copyAssets helper (mirrors publish.ts) ───────────────────────────────────
async function copyAssets(targetDir: string) {
  await $`mkdir -p ${targetDir}/bin`
  await $`cp bin/altimate bin/altimate-code ${targetDir}/bin/`
  await $`cp -r ../../.opencode/skills ${targetDir}/skills`
  await $`cp ./script/postinstall.mjs ${targetDir}/postinstall.mjs`
  await $`mkdir -p ${targetDir}/dbt-tools/bin`
  await $`cp ../dbt-tools/bin/altimate-dbt ${targetDir}/dbt-tools/bin/altimate-dbt`
  await $`mkdir -p ${targetDir}/dbt-tools/dist`
  await $`cp ../dbt-tools/dist/index.js ${targetDir}/dbt-tools/dist/`
  await $`cp ../dbt-tools/dist/node_python_bridge.py ${targetDir}/dbt-tools/dist/`
  await Bun.file(`${targetDir}/dbt-tools/package.json`).write(JSON.stringify({ type: "module" }, null, 2) + "\n")
  if (fs.existsSync("../dbt-tools/dist/altimate_python_packages")) {
    await $`cp -r ../dbt-tools/dist/altimate_python_packages ${targetDir}/dbt-tools/dist/`
  }
  await Bun.file(`${targetDir}/LICENSE`).write(await Bun.file("../../LICENSE").text())
  await Bun.file(`${targetDir}/CHANGELOG.md`).write(await Bun.file("../../CHANGELOG.md").text())
}

// ── Build wrapper package ────────────────────────────────────────────────────
const wrapperDir = `./dist/${pkg.name}`
await $`mkdir -p ${wrapperDir}`
await copyAssets(wrapperDir)

// Use local altimate-core tarball path as the dependency
const coreCompanionTgz = `${LOCAL_DIST}/altimateai-altimate-core-darwin-arm64-0.2.6.tgz`
const coreTgz = `${LOCAL_DIST}/altimateai-altimate-core-0.2.6.tgz`

await Bun.file(`${wrapperDir}/package.json`).write(
  JSON.stringify(
    {
      name: pkg.name,
      version: sanitizedVersion,
      bin: {
        altimate: "./bin/altimate",
        "altimate-code": "./bin/altimate-code",
      },
      scripts: {
        postinstall: "bun ./postinstall.mjs || node ./postinstall.mjs",
      },
      license: pkg.license,
      dependencies: {
        // Reference local tarball so npm install uses our build, not the registry
        "@altimateai/altimate-core": `file:${coreTgz}`,
      },
      optionalDependencies: Object.fromEntries(
        Object.entries(binaries).map(([name, _]) => [name, sanitizedVersion])
      ),
      peerDependencies: {
        pg: ">=8", "snowflake-sdk": ">=1", "@google-cloud/bigquery": ">=8",
        "@databricks/sql": ">=1", mysql2: ">=3", mssql: ">=11",
        oracledb: ">=6", duckdb: ">=1", "@clickhouse/client": ">=1",
      },
    },
    null,
    2,
  ),
)

// ── Pack all platform binary packages ────────────────────────────────────────
for (const name of Object.keys(binaries)) {
  console.log(`Packing ${name}...`)
  await $`chmod -R 755 ./dist/${name}`
  await $`npm pack --pack-destination ${OUT}`.cwd(`./dist/${name}`)
}

// ── Pack wrapper package ──────────────────────────────────────────────────────
console.log(`Packing wrapper ${pkg.name}...`)
await $`chmod -R 755 ${wrapperDir}`
await $`npm pack --pack-destination ${OUT}`.cwd(wrapperDir)

// ── List all output tarballs ──────────────────────────────────────────────────
const tarballs = (await $`ls ${OUT}/*.tgz`.text()).trim().split("\n")
console.log(`\n✓ All tarballs ready in ${OUT}:\n`)
for (const t of tarballs) {
  const size = (await $`du -sh ${t}`.text()).split("\t")[0]
  console.log(`  ${size}  ${path.basename(t)}`)
}

console.log(`
Install and run:
  rm -rf /tmp/altimate-test && mkdir /tmp/altimate-test && cd /tmp/altimate-test
  npm install \\
    ${OUT}/altimateai-altimate-core-darwin-arm64-0.2.6.tgz \\
    ${OUT}/altimateai-altimate-core-0.2.6.tgz \\
    ${tarballs.find(t => t.includes("darwin-arm64") && !t.includes("altimate-core"))} \\
    ${tarballs.find(t => t.includes("altimate-code-0") || (t.includes("altimate-code-") && !t.includes("darwin")))}
  ./node_modules/.bin/altimate-code
`)
