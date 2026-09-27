/**
 * The two maps the switch at the top of the screen moves between.
 *
 *   idea  -- "The idea": thousands of made-up reports, to show how the map
 *            works at scale. Nothing on it is real.
 *   real  -- "Real world": the reports people have actually made, from the
 *            database. Empty, and said to be, when no database is connected.
 *
 * The choice lives in the address (`?world=idea` or `?world=real`), so a
 * reload keeps it and a link shows the same map to whoever opens it.
 */
export type World = 'idea' | 'real'

/**
 * Which map to open on. What the address asks for, if anything; the older
 * `?demo=large` means the idea. Otherwise the real one when there is a
 * database to show, and the idea when there is not, so a first visit never
 * lands on an empty map.
 */
export function worldFromSearch(search: string, realConnected: boolean): World {
  const params = new URLSearchParams(search)
  const asked = params.get('world')
  if (asked === 'idea' || asked === 'real') return asked
  if (params.get('demo') === 'large') return 'idea'
  return realConnected ? 'real' : 'idea'
}

/** The same address, saying which map is showing. Everything else is kept. */
export function searchWithWorld(search: string, world: World): string {
  const params = new URLSearchParams(search)
  params.delete('demo')
  params.set('world', world)
  return `?${params.toString()}`
}
