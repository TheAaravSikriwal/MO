/**
 * The statistics behind the findings. Pure functions, no libraries.
 *
 * Links are measured by rank (Spearman's): each country is placed in order on
 * each measure, and the question is whether the two orders agree. That keeps
 * one or two extreme countries from deciding the answer, and it does not care
 * whether a measure is best read on a straight or a log scale -- GDP per
 * person, for one, spans a hundredfold.
 */

/** Each value's place in order, 1 for the smallest; ties share the average place. */
export function ranks(values: readonly number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value)
  const out = new Array<number>(values.length)
  for (let i = 0; i < order.length; ) {
    let j = i
    while (j + 1 < order.length && order[j + 1].value === order[i].value) j += 1
    const place = (i + j) / 2 + 1
    for (let k = i; k <= j; k += 1) out[order[k].index] = place
    i = j + 1
  }
  return out
}

/** Pearson's correlation. NaN when either side does not vary. */
export function pearson(x: readonly number[], y: readonly number[]): number {
  const n = x.length
  if (n !== y.length || n < 2) return Number.NaN
  const mx = x.reduce((a, b) => a + b, 0) / n
  const my = y.reduce((a, b) => a + b, 0) / n
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < n; i += 1) {
    const dx = x[i] - mx
    const dy = y[i] - my
    sxy += dx * dy
    sxx += dx * dx
    syy += dy * dy
  }
  return sxx === 0 || syy === 0 ? Number.NaN : sxy / Math.sqrt(sxx * syy)
}

/** Spearman's rank correlation, from -1 to 1. */
export function spearman(x: readonly number[], y: readonly number[]): number {
  return pearson(ranks(x), ranks(y))
}

/**
 * The rank link between x and y with z held level: what is left of it once
 * each has been compared only with countries like it on z. Used with z as
 * wealth, to ask whether quality of life goes with the environment beyond
 * what being richer already explains.
 */
export function partialSpearman(x: readonly number[], y: readonly number[], z: readonly number[]): number {
  const [rx, ry, rz] = [ranks(x), ranks(y), ranks(z)]
  const rxy = pearson(rx, ry)
  const rxz = pearson(rx, rz)
  const ryz = pearson(ry, rz)
  const below = Math.sqrt((1 - rxz * rxz) * (1 - ryz * ryz))
  return below === 0 ? Number.NaN : (rxy - rxz * ryz) / below
}

// --- how likely a link this strong is by chance -----------------------------

/** ln Γ(x), by Lanczos's approximation. */
function lnGamma(x: number): number {
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ]
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x)
  x -= 1
  let a = 0.99999999999980993
  const t = x + 7.5
  for (let i = 0; i < g.length; i += 1) a += g[i] / (x + i + 1)
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}

/** The continued fraction for the incomplete beta function. */
function betaFraction(a: number, b: number, x: number): number {
  const tiny = 1e-300
  let c = 1
  let d = 1 - ((a + b) * x) / (a + 1)
  if (Math.abs(d) < tiny) d = tiny
  d = 1 / d
  let h = d
  for (let m = 1; m <= 300; m += 1) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < tiny) d = tiny
    c = 1 + aa / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    h *= d * c
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1))
    d = 1 + aa * d
    if (Math.abs(d) < tiny) d = tiny
    c = 1 + aa / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    const step = d * c
    h *= step
    if (Math.abs(step - 1) < 1e-12) break
  }
  return h
}

/** The regularised incomplete beta function, I_x(a, b). */
export function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x))
  return x < (a + 1) / (a + b + 2) ? (front * betaFraction(a, b, x)) / a : 1 - (front * betaFraction(b, a, 1 - x)) / b
}

/**
 * The chance of a link at least this strong, either way, if there were none
 * at all: the two-sided p-value of a correlation r over n countries, with
 * `heldLevel` other measures held level (1 for a partial correlation).
 */
export function pValue(r: number, n: number, heldLevel = 0): number {
  const df = n - 2 - heldLevel
  if (!Number.isFinite(r) || df < 1) return Number.NaN
  if (Math.abs(r) >= 1) return 0
  const t2 = (r * r * df) / (1 - r * r)
  return incompleteBeta(df / 2, 0.5, df / (df + t2))
}

// --- in words ----------------------------------------------------------------

export type Strength = 'no clear' | 'weak' | 'moderate' | 'strong'

/**
 * How strong a link is, in words, by the usual rule of thumb for rank links.
 * Anything the data could easily show by chance (p of 0.05 or more) is "no
 * clear" link, however large it looks.
 */
export function strength(r: number, p: number): Strength {
  if (!Number.isFinite(r) || !Number.isFinite(p) || p >= 0.05) return 'no clear'
  const size = Math.abs(r)
  return size >= 0.5 ? 'strong' : size >= 0.3 ? 'moderate' : size >= 0.1 ? 'weak' : 'no clear'
}

// --- for the research write-up ---------------------------------------------

/**
 * A 95% confidence interval for a rank correlation, by Fisher's z with the
 * standard error Fieller, Hartley and Pearson (1957) give for Spearman's rho,
 * sqrt(1.06 / (n - 3)), one more degree of freedom taken for each measure
 * held level.
 */
export function confidenceInterval(r: number, n: number, heldLevel = 0): [number, number] {
  const df = n - 3 - heldLevel
  if (!Number.isFinite(r) || df < 1) return [Number.NaN, Number.NaN]
  const z = Math.atanh(Math.max(-0.999999, Math.min(0.999999, r)))
  const se = Math.sqrt(1.06 / df)
  return [Math.tanh(z - 1.959964 * se), Math.tanh(z + 1.959964 * se)]
}

/** The regularised lower incomplete gamma function, P(a, x). */
export function incompleteGamma(a: number, x: number): number {
  if (x <= 0) return 0
  const lnFront = -x + a * Math.log(x) - lnGammaOf(a)
  if (x < a + 1) {
    let term = 1 / a
    let sum = term
    for (let n = 1; n < 500; n += 1) {
      term *= x / (a + n)
      sum += term
      if (Math.abs(term) < Math.abs(sum) * 1e-14) break
    }
    return sum * Math.exp(lnFront)
  }
  // Continued fraction for the upper part, Q(a, x); P = 1 - Q.
  const tiny = 1e-300
  let b = x + 1 - a
  let c = 1 / tiny
  let d = 1 / b
  let h = d
  for (let i = 1; i < 500; i += 1) {
    const an = -i * (i - a)
    b += 2
    d = an * d + b
    if (Math.abs(d) < tiny) d = tiny
    c = b + an / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    const step = d * c
    h *= step
    if (Math.abs(step - 1) < 1e-14) break
  }
  return 1 - Math.exp(lnFront) * h
}

const lnGammaOf = (x: number) => lnGamma(x)

/**
 * Kruskal and Wallis's test: do several groups differ in where they tend to
 * sit, by rank? H with ties corrected, and its p-value from chi-squared on
 * one fewer degree of freedom than there are groups.
 */
export function kruskalWallis(groups: ReadonlyArray<readonly number[]>): { h: number; df: number; p: number } {
  const kept = groups.filter((g) => g.length > 0)
  const all = kept.flat()
  const n = all.length
  const df = kept.length - 1
  if (df < 1 || n < kept.length + 1) return { h: Number.NaN, df, p: Number.NaN }
  const r = ranks(all)
  let at = 0
  let sum = 0
  for (const g of kept) {
    const rankSum = r.slice(at, at + g.length).reduce((a, b) => a + b, 0)
    sum += (rankSum * rankSum) / g.length
    at += g.length
  }
  let h = (12 / (n * (n + 1))) * sum - 3 * (n + 1)
  // Ties: divide by 1 - sum(t^3 - t) / (n^3 - n).
  const counts = new Map<number, number>()
  for (const v of all) counts.set(v, (counts.get(v) ?? 0) + 1)
  const ties = [...counts.values()].reduce((a, t) => a + (t * t * t - t), 0)
  const correction = 1 - ties / (n * n * n - n)
  if (correction > 0) h /= correction
  return { h, df, p: 1 - incompleteGamma(df / 2, h / 2) }
}

export interface Describe {
  n: number
  min: number
  q1: number
  median: number
  q3: number
  max: number
}

/** The spread of a set of figures: count, extremes, quartiles and median. */
export function describe(values: readonly number[]): Describe {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q: number) => {
    if (sorted.length === 0) return Number.NaN
    const pos = (sorted.length - 1) * q
    const lo = Math.floor(pos)
    const hi = Math.ceil(pos)
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
  }
  return { n: sorted.length, min: at(0), q1: at(0.25), median: at(0.5), q3: at(0.75), max: at(1) }
}

/** The middle value. NaN for none. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
