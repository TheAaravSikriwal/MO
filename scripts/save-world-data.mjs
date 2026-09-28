// Saves slim copies of every world data source into public/data, so the app
// can still use them when the live files cannot be reached, and records the
// day in src/lib/worlddata/sources.ts (SAVED_ON). Then run the sync.
//
//   node scripts/save-world-data.mjs
//
// The addresses and column names are read from sources.ts itself (Node runs
// TypeScript directly), so this can never save a different file from the one
// the app reads.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MO = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(MO, 'public', 'data') + '/'
const SOURCES = join(MO, 'src', 'lib', 'worlddata', 'sources.ts')
const src = await import(pathToFileURL(SOURCES).href)
const FIRES = src.FIRES_UPSTREAM
/** Every country figure: its live file, its column, and the saved copy's name. */
const COUNTRY_FILES = [
  ['air', src.AIR_POLLUTION_CSV],
  ['plastic', src.OCEAN_PLASTIC_CSV],
  ['life', src.QUALITY_OF_LIFE_CSV],
  ['water', src.WATER_QUALITY_CSV],
  ['gdp', src.GDP_PER_PERSON_CSV],
  ['plasticPerPerson', src.PLASTIC_PER_PERSON_CSV],
].map(([id, url]) => ({ url, column: src.COUNTRY_COLUMNS[id], file: basename(src.SAVED_COPIES[id]) }))

const fields = (line) => {
  const out = []
  let cur = ''
  let quoted = false
  for (const ch of line) {
    if (ch === '"') quoted = !quoted
    else if (ch === ',' && !quoted) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}
const quote = (s) => (/[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)

/**
 * The saved copies are what the map falls back on when a source is down, so a
 * bad download must never replace a good copy. Every file is fetched and
 * checked first; nothing is written unless every one passes.
 */
const MIN_COUNTRIES = 100
const MIN_FIRES = 1000

async function download(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} answered ${response.status}; nothing was saved`)
  return response.text()
}

async function latest({ url, file, column }) {
  const text = await download(url)
  const lines = text.split(/\r?\n/).filter(Boolean)
  const header = fields(lines[0] ?? '')
  const lower = header.map((h) => h.toLowerCase())
  const at = { name: lower.indexOf('entity'), code: lower.indexOf('code'), year: lower.indexOf('year') }
  const valueAt = lower.indexOf(column.toLowerCase())
  if (at.name < 0 || at.code < 0 || at.year < 0 || valueAt < 0) {
    throw new Error(`${file}: the file changed shape (${header.join(', ')}); nothing was saved`)
  }
  const best = new Map()
  for (const line of lines.slice(1)) {
    const f = fields(line)
    const code = f[at.code]
    if (!code || code.startsWith('OWID_') || f[valueAt] === '' || !Number.isFinite(Number(f[valueAt]))) continue
    const year = Number(f[at.year])
    if (!best.has(code) || year > best.get(code).year) best.set(code, { name: f[at.name], year, value: f[valueAt] })
  }
  if (best.size < MIN_COUNTRIES) throw new Error(`${file}: only ${best.size} countries could be read; nothing was saved`)
  const rows = [...best].sort(([a], [b]) => a.localeCompare(b)).map(([code, r]) => [quote(r.name), code, r.year, r.value].join(','))
  return { file, text: [['entity', 'code', 'year', header[valueAt]].join(','), ...rows].join('\n') + '\n', note: `${best.size} countries` }
}

async function fires() {
  const text = await download(FIRES)
  const lines = text.split(/\r?\n/).filter(Boolean)
  const header = fields(lines[0] ?? '')
  const [lat, lng, frp] = ['latitude', 'longitude', 'frp'].map((n) => header.indexOf(n))
  if (lat < 0 || lng < 0) throw new Error('fires-saved.csv: the file changed shape; nothing was saved')
  const rows = []
  for (const line of lines.slice(1)) {
    const f = fields(line)
    // A blank field is not a zero: Number('') is 0.
    if (!f[lat]?.trim() || !f[lng]?.trim()) continue
    const [y, x] = [Number(f[lat]), Number(f[lng])]
    // Only real positions: an error page with a latitude header must not pass.
    if (!Number.isFinite(y) || !Number.isFinite(x) || Math.abs(y) > 90 || Math.abs(x) > 180) continue
    rows.push([y.toFixed(3), x.toFixed(3), (Number(f[frp]) || 0).toFixed(1)].join(','))
  }
  if (rows.length < MIN_FIRES) throw new Error(`fires-saved.csv: only ${rows.length} hot spots could be read; nothing was saved`)
  return { file: 'fires-saved.csv', text: ['latitude,longitude,frp', ...rows].join('\n') + '\n', note: `${rows.length} hot spots` }
}

const saved = []
for (const source of COUNTRY_FILES) saved.push(await latest(source))
saved.push(await fires())
const today = new Date().toISOString().slice(0, 10)
const sources = readFileSync(SOURCES, 'utf8')
const dated = sources.replace(/export const SAVED_ON = '\d{4}-\d{2}-\d{2}'/, () => `export const SAVED_ON = '${today}'`)
if (!/export const SAVED_ON = '\d{4}-\d{2}-\d{2}'/.test(sources)) throw new Error('SAVED_ON not found in sources.ts; nothing was saved')
// All three passed: only now is anything written.
for (const { file, text, note } of saved) {
  writeFileSync(OUT + file, text)
  console.log(file, note)
}
writeFileSync(SOURCES, dated)
console.log('saved on', today)
