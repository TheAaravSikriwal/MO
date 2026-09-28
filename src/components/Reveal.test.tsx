import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { Reveal, REVEAL_MS, Swap, useLingeringList } from './Reveal'

function Panel({ show, text = 'Hello' }: { show: boolean; text?: string | null }) {
  return (
    <Reveal show={show}>
      {text && <button type="button">{text}</button>}
    </Reveal>
  )
}

const box = () => screen.getByText('Hello').closest('[data-reveal]') as HTMLElement

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Reveal', () => {
  it('draws nothing while hidden', () => {
    render(<Panel show={false} />)
    expect(screen.queryByText('Hello')).not.toBeInTheDocument()
  })

  it('comes in: switched on once it has been laid out, so it moves rather than jumps', () => {
    const { rerender } = render(<Panel show={false} />)
    rerender(<Panel show />)
    expect(box()).toHaveAttribute('data-reveal', 'in')
    expect(box().className).toContain('opacity-100')
    expect(box().className).toContain('grid-rows-[1fr]')
  })

  it('lays out its hidden state before switching on, or it would appear rather than move', () => {
    // What the element looked like each time the browser was made to lay it
    // out. Without the forced layout the switch to "in" is the first state the
    // browser ever sees, and there is nothing to transition from.
    const seen: string[] = []
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        if (this.dataset.reveal) seen.push(this.dataset.reveal)
        return 0
      },
    })
    try {
      const { rerender } = render(<Panel show={false} />)
      rerender(<Panel show />)
      expect(seen).toEqual(['out'])
      expect(box()).toHaveAttribute('data-reveal', 'in')
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', original)
    }
  })

  it('opens and closes the space it takes, so what is around it slides rather than jumps', () => {
    vi.useFakeTimers()
    const { rerender } = render(<Panel show />)
    expect(box().className).toContain('grid-rows-[1fr]')
    // Tailwind 4's translate-y utilities set `translate`, not `transform`, so
    // that is the property that has to be in the list for the slide to move.
    expect(box().className).toMatch(/transition-\[[^\]]*\btranslate\b[^\]]*\]/)
    expect(box().className).toMatch(/\btranslate-y-/)
    rerender(<Panel show={false} />)
    expect(box().className).toContain('grid-rows-[0fr]')
  })

  it('clips only while it moves, so a shadow or a list is not cut off once it has arrived', () => {
    vi.useFakeTimers()
    const { rerender } = render(<Panel show />)
    const clip = () => box().firstElementChild as HTMLElement
    expect(clip().className).toContain('overflow-hidden')
    act(() => vi.advanceTimersByTime(REVEAL_MS))
    expect(clip().className).not.toContain('overflow-hidden')
    rerender(<Panel show={false} />)
    expect(clip().className).toContain('overflow-hidden')
  })

  it('keeps its gap inside, so the space closes with it', () => {
    render(
      <Reveal show gap="pt-2">
        <p>Hello</p>
      </Reveal>,
    )
    expect(screen.getByText('Hello').parentElement).toHaveClass('pt-2')
  })

  it('goes out: kept for the length of the fade, hidden and inert, then removed', () => {
    vi.useFakeTimers()
    const { rerender } = render(<Panel show />)
    rerender(<Panel show={false} />)

    expect(box()).toHaveAttribute('data-reveal', 'out')
    expect(box().className).toContain('opacity-0')
    expect(box()).toHaveAttribute('aria-hidden', 'true')
    expect(box()).toHaveAttribute('inert')
    // Hidden from the accessibility tree while it fades.
    expect(screen.queryByRole('button', { name: 'Hello' })).not.toBeInTheDocument()

    act(() => vi.advanceTimersByTime(REVEAL_MS))
    expect(screen.queryByText('Hello')).not.toBeInTheDocument()
  })

  it('keeps showing what it had while it fades, even once that is gone', () => {
    vi.useFakeTimers()
    const { rerender } = render(<Panel show />)
    // The panel's content disappears in the same render that hides it -- a
    // report being closed, say -- and the fade still has something to fade.
    rerender(<Panel show={false} text={null} />)
    expect(screen.getByText('Hello')).toBeInTheDocument()
  })

  it('comes back cleanly if shown again part-way through going out', () => {
    vi.useFakeTimers()
    const { rerender } = render(<Panel show />)
    rerender(<Panel show={false} />)
    act(() => vi.advanceTimersByTime(REVEAL_MS / 2))
    rerender(<Panel show />)
    act(() => vi.advanceTimersByTime(REVEAL_MS * 2))
    expect(box()).toHaveAttribute('data-reveal', 'in')
    expect(box()).not.toHaveAttribute('inert')
    expect(screen.getByRole('button', { name: 'Hello' })).toBeInTheDocument()
  })

  it('does not move or wait for anyone who has asked for reduced motion', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') }))
    const { rerender } = render(<Panel show />)
    expect(box().className).toContain('motion-reduce:transition-none')
    rerender(<Panel show={false} />)
    expect(screen.queryByText('Hello')).not.toBeInTheDocument()
  })
})

function List({ items }: { items: string[] }) {
  const shown = useLingeringList(items, (item) => item)
  return (
    <ul>
      {shown.map(({ item, key, leaving }) => (
        <li key={key} data-leaving={leaving ? 'yes' : 'no'}>
          {item}
        </li>
      ))}
    </ul>
  )
}

const rows = () =>
  screen.queryAllByRole('listitem').map((li) => `${li.textContent}:${li.getAttribute('data-leaving')}`)

describe('useLingeringList', () => {
  it('keeps a removed item in its old place while it fades, then lets it go', () => {
    vi.useFakeTimers()
    const { rerender } = render(<List items={['a', 'b', 'c']} />)
    rerender(<List items={['a', 'c']} />)
    expect(rows()).toEqual(['a:no', 'b:yes', 'c:no'])
    act(() => vi.advanceTimersByTime(REVEAL_MS))
    expect(rows()).toEqual(['a:no', 'c:no'])
  })

  it('keeps the very same element while it leaves, so its fade has something to run on', () => {
    // Working this out after rendering dropped the item for one render: React
    // unmounted it and mounted a fresh one already hidden, and nothing faded.
    vi.useFakeTimers()
    const { rerender } = render(<List items={['a', 'b', 'c']} />)
    const before = screen.getByText('b')
    rerender(<List items={['a', 'c']} />)
    expect(screen.getByText('b')).toBe(before)
  })

  it('does not strand an item when a second change comes mid-fade', () => {
    vi.useFakeTimers()
    const { rerender } = render(<List items={['a', 'b', 'c']} />)
    rerender(<List items={['a', 'c']} />)
    act(() => vi.advanceTimersByTime(REVEAL_MS / 2))
    rerender(<List items={['c']} />)
    act(() => vi.advanceTimersByTime(REVEAL_MS))
    expect(rows()).toEqual(['c:no'])
  })

  it('treats an item that comes back as present again', () => {
    vi.useFakeTimers()
    const { rerender } = render(<List items={['a', 'b']} />)
    rerender(<List items={['a']} />)
    rerender(<List items={['a', 'b']} />)
    expect(rows()).toEqual(['a:no', 'b:no'])
    act(() => vi.advanceTimersByTime(REVEAL_MS))
    expect(rows()).toEqual(['a:no', 'b:no'])
  })

  it('drops removed items at once for anyone who has asked for reduced motion', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') }))
    const { rerender } = render(<List items={['a', 'b']} />)
    rerender(<List items={['a']} />)
    expect(rows()).toEqual(['a:no'])
  })
})

describe('Swap', () => {
  const Button = ({ state }: { state: 'join' | 'leave' }) => (
    <Swap id={state}>
      <button type="button">{state === 'join' ? 'Join' : 'Leave'}</button>
    </Swap>
  )

  it('cross-fades: the old state stays, hidden and inert, while the new one fades in', () => {
    vi.useFakeTimers()
    const { rerender } = render(<Button state="join" />)
    rerender(<Button state="leave" />)
    const old = screen.getByText('Join').parentElement as HTMLElement
    expect(old).toHaveAttribute('aria-hidden', 'true')
    expect(old).toHaveAttribute('inert')
    expect(old.className).toContain('opacity-0')
    expect(screen.getByRole('button', { name: 'Leave' }).parentElement!.className).toContain('mo-swap-in')
    // Only the live state can be reached.
    expect(screen.queryByRole('button', { name: 'Join' })).not.toBeInTheDocument()
    act(() => vi.advanceTimersByTime(REVEAL_MS))
    expect(screen.queryByText('Join')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Leave' })).toBeInTheDocument()
  })

  it('swaps at once for anyone who has asked for reduced motion', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') }))
    const { rerender } = render(<Button state="join" />)
    rerender(<Button state="leave" />)
    expect(screen.queryByText('Join')).not.toBeInTheDocument()
  })
})

describe('Reveal — keepMounted', () => {
  function Draft({ show }: { show: boolean }) {
    return (
      <Reveal show={show} keepMounted>
        <input aria-label="Draft" defaultValue="" />
      </Reveal>
    )
  }

  it('keeps what was typed while hidden, so it is still there when shown again', () => {
    vi.useFakeTimers()
    const { rerender } = render(<Draft show />)
    const input = screen.getByLabelText('Draft') as HTMLInputElement
    input.value = 'half written'
    rerender(<Draft show={false} />)
    act(() => vi.advanceTimersByTime(REVEAL_MS))
    // Hidden from everybody, but the same element.
    expect(input.closest('[data-reveal]')).toHaveAttribute('hidden')
    expect(screen.queryByRole('textbox', { name: 'Draft' })).not.toBeInTheDocument()
    rerender(<Draft show />)
    expect(screen.getByLabelText('Draft')).toBe(input)
    expect(input.value).toBe('half written')
    expect(input.closest('[data-reveal]')).not.toHaveAttribute('hidden')
  })
})
