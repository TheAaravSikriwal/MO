import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { FakeDataSource } from './lib/data/fakeSource'
import { forgetFindings } from './lib/worlddata/useFindings'
import { forgetWorldData } from './lib/worlddata/useWorldData'
import { SAVED_COPIES, COUNTRIES_URL } from './lib/worlddata/sources'
import air from '../public/data/air-saved.csv?raw'
import fires from '../public/data/fires-saved.csv?raw'
import life from '../public/data/life-saved.csv?raw'
import water from '../public/data/water-saved.csv?raw'
import gdp from '../public/data/gdp-saved.csv?raw'
import plasticPerPerson from '../public/data/plastic-per-person-saved.csv?raw'
import countries from '../public/data/countries.geojson?raw'

/** The Findings tab, end to end, on the real saved figures with every live file out of reach. */

vi.mock('./components/map/GlobeMap', () => import('./test/globeMapMock'))

afterEach(() => {
  vi.unstubAllGlobals()
  forgetFindings()
  forgetWorldData()
})

const offline = () =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const saved: Record<string, string> = {
        [SAVED_COPIES.air]: air,
        [SAVED_COPIES.fires]: fires,
        [SAVED_COPIES.life]: life,
        [SAVED_COPIES.water]: water,
        [SAVED_COPIES.gdp]: gdp,
        [SAVED_COPIES.plasticPerPerson]: plasticPerPerson,
        [COUNTRIES_URL]: countries,
      }
      const text = saved[String(input)]
      if (text === undefined) throw new TypeError('offline')
      return new Response(text)
    }),
  )

describe('the Findings tab', () => {
  it('opens the findings, worked out from the real figures, and says they are saved copies', async () => {
    offline()
    const user = userEvent.setup()
    render(<App data={new FakeDataSource(null)} />)
    await user.click(screen.getByRole('tab', { name: 'Findings' }))
    const panel = await screen.findByRole('tabpanel', { name: 'Findings' })
    const pick = (await within(panel).findByRole('heading', { name: '1. Pick part of the environment' })).parentElement!
    // One card per environmental measure.
    expect(within(pick).getAllByRole('button')).toHaveLength(4)
    expect(within(panel).getByText(/cleaner air: a (moderate|strong) link, across \d+ countries/)).toBeInTheDocument()
    expect(within(panel).getByText(/saved copies from/)).toBeInTheDocument()
  })

  it('writes up the same figures as a research paper', async () => {
    offline()
    const user = userEvent.setup()
    render(<App data={new FakeDataSource(null)} />)
    await user.click(screen.getByRole('tab', { name: 'Findings' }))
    const panel = await screen.findByRole('tabpanel', { name: 'Findings' })
    await within(panel).findByRole('heading', { name: '1. Pick part of the environment' })
    await user.click(within(panel).getByRole('button', { name: 'Research paper' }))
    const paper = within(panel).getByRole('article', { name: 'Research paper' })
    const table3 = within(paper).getByRole('table', { name: /^Table 3\./ })
    // Four indicators, each with its link, interval, p and n, on the real figures.
    expect(within(table3).getAllByRole('row')).toHaveLength(5)
    expect(within(table3).getByRole('rowheader', { name: 'Air pollution' }).parentElement!.textContent).toMatch(/−0\.\d\d/)
  })

  it('goes back to the map’s own panels on the other tabs', async () => {
    offline()
    const user = userEvent.setup()
    render(<App data={new FakeDataSource(null)} />)
    await user.click(screen.getByRole('tab', { name: 'Findings' }))
    await screen.findByRole('tabpanel', { name: 'Findings' })
    await user.click(screen.getByRole('tab', { name: 'Reports' }))
    expect(screen.queryByRole('tabpanel', { name: 'Findings' })).not.toBeInTheDocument()
  })
})
