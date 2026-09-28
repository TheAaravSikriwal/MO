/**
 * A large, made-up set of reports, for seeing how the map looks at scale.
 *
 * This is "The idea" side of the switch at the top of the map (worlds.ts).
 * `&count=50000` in the address changes how many. Five reports in one London
 * street say nothing about how the colours, pins and zoom levels behave
 * across a city or the world; this does.
 *
 * Deterministic: the same count gives the same reports on every load, so a
 * screenshot can be retaken and compared. The reports cluster around real
 * cities, with a few busy spots in each, because litter reports do -- a
 * uniform spray across the globe would mostly land in the sea and look like
 * nothing real.
 */

export interface DemoReport {
  id: string
  lat: number
  lng: number
  note: string
  voteCount: number
  status: 'open' | 'cleaned'
  createdAt: string
}

export const DEFAULT_LARGE_COUNT = 20_000
export const MAX_LARGE_COUNT = 100_000

/** City centre, and how many reports it gets relative to the others. */
const CITIES: Array<[name: string, lat: number, lng: number, weight: number]> = [
  ['London', 51.5074, -0.1278, 10],
  ['Manchester', 53.4808, -2.2426, 4],
  ['Birmingham', 52.4862, -1.8904, 4],
  ['Glasgow', 55.8642, -4.2518, 3],
  ['Dublin', 53.3498, -6.2603, 3],
  ['Paris', 48.8566, 2.3522, 7],
  ['Berlin', 52.52, 13.405, 5],
  ['Madrid', 40.4168, -3.7038, 5],
  ['Rome', 41.9028, 12.4964, 5],
  ['Amsterdam', 52.3676, 4.9041, 3],
  ['Warsaw', 52.2297, 21.0122, 3],
  ['Istanbul', 41.0082, 28.9784, 6],
  ['Cairo', 30.0444, 31.2357, 6],
  ['Lagos', 6.5244, 3.3792, 6],
  ['Nairobi', -1.2921, 36.8219, 4],
  ['Johannesburg', -26.2041, 28.0473, 4],
  ['Mumbai', 19.076, 72.8777, 8],
  ['Delhi', 28.6139, 77.209, 8],
  ['Bengaluru', 12.9716, 77.5946, 5],
  ['Dhaka', 23.8103, 90.4125, 5],
  ['Bangkok', 13.7563, 100.5018, 5],
  ['Jakarta', -6.2088, 106.8456, 6],
  ['Manila', 14.5995, 120.9842, 5],
  ['Tokyo', 35.6762, 139.6503, 7],
  ['Seoul', 37.5665, 126.978, 5],
  ['Shanghai', 31.2304, 121.4737, 7],
  ['Sydney', -33.8688, 151.2093, 4],
  ['Auckland', -36.8485, 174.7633, 2],
  ['New York', 40.7128, -74.006, 8],
  ['Los Angeles', 34.0522, -118.2437, 6],
  ['Chicago', 41.8781, -87.6298, 4],
  ['Toronto', 43.6532, -79.3832, 4],
  ['Mexico City', 19.4326, -99.1332, 6],
  ['Bogotá', 4.711, -74.0721, 4],
  ['Lima', -12.0464, -77.0428, 4],
  ['São Paulo', -23.5505, -46.6333, 7],
  ['Buenos Aires', -34.6037, -58.3816, 5],
  ['Honolulu', 21.3069, -157.8583, 1],
  ['Suva', -18.1248, 178.4501, 1],
]

/** Plain descriptions of the litter, never of the place or the people there. */
const NOTES = [
  'Bags of rubbish by the bus stop',
  'Broken glass along the path',
  'Dumped mattress on the pavement',
  'Litter around the benches',
  'Cans and bottles in the hedge',
  'Takeaway boxes on the grass',
  'Overflowing bin by the entrance',
  'Plastic bags caught in the fence',
  'Old tyres left by the road',
  'Cigarette ends all along the kerb',
  'Rubble and building waste',
  'Litter washed up by the water',
  'Coffee cups on the wall',
  'Broken furniture left out',
  'Wrappers blown into the corner',
]

/** A small, fast, seedable generator (mulberry32). */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Normally distributed, mean 0 and spread 1 (Box-Muller). */
function normal(next: () => number): number {
  const u = 1 - next()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next())
}

const clampLat = (lat: number) => Math.max(-85, Math.min(85, lat))
const wrapLng = (lng: number) => ((((lng + 180) % 360) + 360) % 360) - 180

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * `count` reports, the same ones every time. `now` fixes the dates: reports
 * are spread over the year before it, so the "since" filter has something to
 * cut.
 */
export function largeDemoReports(count: number, now: number = Date.now()): DemoReport[] {
  const next = random(20260927)
  const totalWeight = CITIES.reduce((sum, [, , , weight]) => sum + weight, 0)

  // A few busy spots per city: a street, a park, a riverbank. Chosen once, so
  // they stay put however many reports are asked for.
  const hotspots = CITIES.map(([, lat, lng]) =>
    Array.from({ length: 6 }, () => ({
      lat: lat + normal(next) * 0.04,
      lng: lng + (normal(next) * 0.04) / Math.cos((lat * Math.PI) / 180),
    })),
  )

  const reports: DemoReport[] = []
  for (let i = 0; i < count; i++) {
    let pick = next() * totalWeight
    let city = 0
    while (pick >= CITIES[city][3] && city < CITIES.length - 1) {
      pick -= CITIES[city][3]
      city += 1
    }
    const [, cityLat, cityLng] = CITIES[city]
    const roll = next()

    let lat: number
    let lng: number
    let busy = false
    if (roll < 0.35) {
      // Around a busy spot: tight, and more people confirm what they see.
      const spot = hotspots[city][Math.floor(next() * hotspots[city].length)]
      lat = spot.lat + normal(next) * 0.002
      lng = spot.lng + normal(next) * 0.003
      busy = true
    } else if (roll < 0.9) {
      // Across the city.
      lat = cityLat + normal(next) * 0.05
      lng = cityLng + (normal(next) * 0.05) / Math.cos((cityLat * Math.PI) / 180)
    } else {
      // Out into the towns and roads around it.
      lat = cityLat + normal(next) * 0.6
      lng = cityLng + (normal(next) * 0.6) / Math.cos((cityLat * Math.PI) / 180)
    }

    // Most reports get few confirmations and a few get many.
    const voteCount = Math.floor(Math.exp(next() * (busy ? 3.2 : 2.3))) - 1

    reports.push({
      id: `large-${i}`,
      lat: clampLat(lat),
      lng: wrapLng(lng),
      note: NOTES[Math.floor(next() * NOTES.length)],
      voteCount,
      status: next() < 0.15 ? 'cleaned' : 'open',
      createdAt: new Date(now - Math.floor(next() * 365) * DAY_MS).toISOString(),
    })
  }
  return reports
}

export interface DemoGroup {
  id: string
  name: string
  description: string
  lat: number
  lng: number
  members: number
}

/** Friendly and plain, and about the cleaning, never about the place. */
const GROUP_NAMES = [
  (city: string) => `${city} Litter Pickers`,
  (city: string) => `Friends of ${city} Parks`,
  (city: string) => `${city} Weekend Tidy-Up`,
]

const GROUP_ABOUT = [
  'We meet on Saturday mornings and bring gloves, bags and pickers for everyone.',
  'A monthly clean-up of the parks and paths. Families welcome.',
  'Short after-work sessions along the river. Come for as long as you can.',
  'We clear the streets around the market once a week.',
]

/**
 * A few made-up cleaning groups in every sample city, the same ones every
 * load. Placed near the busy spots, where a group would start.
 */
export function largeDemoGroups(): DemoGroup[] {
  const next = random(27092026)
  const groups: DemoGroup[] = []
  CITIES.forEach(([city, lat, lng], c) => {
    GROUP_NAMES.forEach((name, g) => {
      groups.push({
        id: `idea-group-${c}-${g}`,
        name: name(city),
        description: GROUP_ABOUT[Math.floor(next() * GROUP_ABOUT.length)],
        lat: clampLat(lat + normal(next) * 0.03),
        lng: wrapLng(lng + (normal(next) * 0.03) / Math.cos((lat * Math.PI) / 180)),
        members: 3 + Math.floor(next() * 58),
      })
    })
  })
  return groups
}

/**
 * How many made-up reports "The idea" shows: the default, or what `?count=` in
 * the address asks for, within limits.
 */
export function ideaCountFromSearch(search: string): number {
  const asked = Number.parseInt(new URLSearchParams(search).get('count') ?? '', 10)
  if (!Number.isFinite(asked) || asked <= 0) return DEFAULT_LARGE_COUNT
  return Math.min(asked, MAX_LARGE_COUNT)
}
