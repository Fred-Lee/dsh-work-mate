// Contract gate (design D9): the loader id must agree across the three places
// the host reads — cordis.patch.yml (id + name), package.json (name + bundle
// declaration) and the plugin entry (exported `name`). A mismatch means the
// bundle either fails to load or silently mounts under the wrong identity.
// Unit tests cannot catch this class of defect; only a real profile load can,
// so this script runs in CI (`pnpm verify:contract`).
import { readFile } from 'node:fs/promises'

const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const patchYml = await readFile('cordis.patch.yml', 'utf8')
const indexTs = await readFile('src/index.ts', 'utf8')

const problems = []

if (!pkg.dsh?.bundle?.patch) {
  problems.push('package.json declares no dsh.bundle.patch — profile loading would throw')
}
if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') {
  problems.push(`package.json dsh.bundle.patch is ${pkg.dsh?.bundle?.patch}, expected './cordis.patch.yml'`)
}

const patchIds = [...patchYml.matchAll(/^\s*- id:\s*(\S+)\s*$/gm)].map((match) => match[1])
const patchNames = [...patchYml.matchAll(/^\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/gm)].map((match) => match[1])
if (patchIds.length === 0) problems.push('cordis.patch.yml declares no "- id:" entries')
if (!patchIds.includes('workmate')) problems.push('cordis.patch.yml has no "workmate" entry')
if (!patchNames.includes(pkg.name)) {
  problems.push(`cordis.patch.yml name '${patchNames.join("', '")}' does not include package.json name '${pkg.name}'`)
}

const entryName = indexTs.match(/export const name = '([^']+)'/)?.[1]
if (!entryName) {
  problems.push("src/index.ts does not export const name = '...'")
} else if (entryName !== 'workmate') {
  problems.push(`src/index.ts name '${entryName}' does not match the patch id 'workmate'`)
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`[contract] ${problem}`)
  process.exit(1)
}
console.log(`[contract] ok — id 'workmate' consistent across cordis.patch.yml / package.json / src/index.ts`)
