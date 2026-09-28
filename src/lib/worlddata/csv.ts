/**
 * Reading the world data files. Kept apart from the drawing code, with no
 * map libraries, so the small servers that pass NASA's file through can use
 * it without carrying the map along.
 */

/**
 * Split one CSV line into its fields, honouring quotes. Our World in Data
 * quotes names with commas in them, and a plain split would move every value
 * after one into the wrong column.
 */
export function csvFields(line: string): string[] {
  const fields: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"'
        i += 1
      } else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      fields.push(field)
      field = ''
    } else field += ch
  }
  fields.push(field)
  return fields
}

export interface Fire {
  lat: number
  lng: number
  /** Fire radiative power, in megawatts: how much heat it gives off. */
  power: number
}

/** The fires in NASA's MODIS 24-hour file. Rows it cannot read are skipped. */
export function parseFires(csv: string): Fire[] {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim() !== '')
  if (lines.length === 0) return []
  const header = csvFields(lines[0])
  const at = (name: string) => header.indexOf(name)
  const [latAt, lngAt, powerAt] = [at('latitude'), at('longitude'), at('frp')]
  if (latAt < 0 || lngAt < 0) return []
  const fires: Fire[] = []
  for (const line of lines.slice(1)) {
    const fields = csvFields(line)
    // A blank field is not a zero: Number('') is 0, and a blank row would
    // become a fire at 0, 0, in the sea off West Africa.
    if (!fields[latAt]?.trim() || !fields[lngAt]?.trim()) continue
    const lat = Number(fields[latAt])
    const lng = Number(fields[lngAt])
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue
    fires.push({ lat, lng, power: powerAt >= 0 ? Number(fields[powerAt]) || 0 : 0 })
  }
  return fires
}

/**
 * NASA's file cut to what the map draws: where each hot spot is, to about a
 * hundred metres, and how strong it is. About a fifth of the size, which keeps
 * it well inside what a server's cache will hold (Next's refuses over 2 MB,
 * and NASA's full file is 1.4 MB on a quiet day). Empty when nothing could be
 * read, so a caller can say so rather than pass on an empty map.
 */
export function slimFires(csv: string): string {
  const fires = parseFires(csv)
  if (fires.length === 0) return ''
  const rows = fires.map((f) => `${f.lat.toFixed(3)},${f.lng.toFixed(3)},${f.power.toFixed(1)}`)
  return ['latitude,longitude,frp', ...rows].join('\n') + '\n'
}
