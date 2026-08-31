import { describe, it, expect, vi } from 'vitest'
import { moderate } from './pipeline.js'
import type { ImageClassifier, Judge, TextClassifier, Thresholds } from './types.js'

const thresholds: Thresholds = {
  nsfw: { rejectAbove: 0.85, approveBelow: 0.15 },
  toxicity: { rejectAbove: 0.8, approveBelow: 0.2 },
}

const textClassifier = (scores: Record<string, number>): TextClassifier => ({
  name: 'fake-text',
  score: vi.fn().mockResolvedValue(scores),
})

const imageClassifier = (scores: Record<string, number>): ImageClassifier => ({
  name: 'fake-image',
  score: vi.fn().mockResolvedValue(scores),
})

const judge = (verdict: 'safe' | 'unsafe' | 'uncertain', reason = 'because'): Judge => ({
  name: 'fake-judge',
  judgeText: vi.fn().mockResolvedValue({ verdict, reason }),
  judgeImage: vi.fn().mockResolvedValue({ verdict, reason }),
})

const brokenJudge = (): Judge => ({
  name: 'broken-judge',
  judgeText: vi.fn().mockRejectedValue(new Error('connection refused')),
  judgeImage: vi.fn().mockRejectedValue(new Error('connection refused')),
})

const cleanText = { kind: 'text', text: 'Bags of rubbish by the bus stop' } as const
const photo = { kind: 'image', url: 'https://img.example.com/a.jpg' } as const

describe('moderate — tier 2 settles the confident cases', () => {
  it('rejects clearly toxic text without waking the judge', async () => {
    const j = judge('safe')
    const decision = await moderate(cleanText, {
      textClassifier: textClassifier({ toxicity: 0.02, insult: 0.97 }),
      judge: j,
      thresholds,
    })
    expect(decision.action).toBe('reject')
    expect(j.judgeText).not.toHaveBeenCalled()
  })

  it('approves a clean photo on a low nsfw score', async () => {
    const decision = await moderate(photo, {
      imageClassifier: imageClassifier({ nsfw: 0.01 }),
      judge: judge('unsafe'),
      thresholds,
    })
    expect(decision.action).toBe('approve')
    expect(decision.decidedBy).toContain('tier2')
  })

  it('rejects an obviously explicit photo', async () => {
    const decision = await moderate(photo, {
      imageClassifier: imageClassifier({ nsfw: 0.99 }),
      thresholds,
    })
    expect(decision.action).toBe('reject')
  })
})

describe('moderate — tier 3 handles the middle', () => {
  it('hands an uncertain score to the judge and takes its answer', async () => {
    const j = judge('safe', 'ordinary litter')
    const decision = await moderate(photo, {
      imageClassifier: imageClassifier({ nsfw: 0.5 }),
      judge: j,
      thresholds,
    })
    expect(j.judgeImage).toHaveBeenCalled()
    expect(decision.action).toBe('approve')
    expect(decision.decidedBy).toContain('tier3')
  })

  it('escalates to a human when the judge is unsure', async () => {
    const decision = await moderate(photo, {
      imageClassifier: imageClassifier({ nsfw: 0.5 }),
      judge: judge('uncertain', 'cannot tell what this shows'),
      thresholds,
    })
    expect(decision.action).toBe('escalate')
    expect(decision.reason).toBe('cannot tell what this shows')
  })

  it('sends a wordlist hit to the judge instead of rejecting it', async () => {
    // The Penistone case: a real street name that trips the wordlist. Rejecting
    // here would censor a legitimate report about a real road.
    const j = judge('safe', 'a real place name, not an insult')
    const classifier = textClassifier({ toxicity: 0.0 })
    const decision = await moderate(
      { kind: 'text', text: 'Litter near Penistone Road' },
      { textClassifier: classifier, judge: j, thresholds },
    )
    expect(decision.action).toBe('approve')
    expect(j.judgeText).toHaveBeenCalled()
    // The wordlist hit short-circuits tier 2 scoring and goes straight to tier 3.
    expect(classifier.score).not.toHaveBeenCalled()
  })

  it('catches a house-rule violation no classifier would flag', async () => {
    const decision = await moderate(
      { kind: 'text', text: 'this whole neighbourhood is a slum' },
      {
        // A generic toxicity classifier scores this clean, which is the point.
        textClassifier: textClassifier({ toxicity: 0.05 }),
        judge: judge('unsafe', 'disparages the area and its residents'),
        thresholds,
      },
    )
    expect(decision.action).toBe('reject')
    expect(decision.reason).toContain('disparages')
  })
})

describe('moderate — every failure fails closed', () => {
  it('escalates rather than approving when the image classifier is down', async () => {
    const decision = await moderate(photo, {
      imageClassifier: {
        name: 'broken',
        score: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      },
      thresholds,
    })
    expect(decision.action).toBe('escalate')
    expect(decision.tierResults.imageClassifierError).toContain('ECONNREFUSED')
  })

  it('escalates rather than approving when the judge is unreachable', async () => {
    const decision = await moderate(photo, {
      imageClassifier: imageClassifier({ nsfw: 0.5 }),
      judge: brokenJudge(),
      thresholds,
    })
    expect(decision.action).toBe('escalate')
    expect(decision.reason).toContain('unreachable')
  })

  it('escalates when nothing at all is configured', async () => {
    const decision = await moderate(photo, { thresholds })
    expect(decision.action).toBe('escalate')
    expect(decision.reason).toContain('no judge configured')
  })

  it('escalates when the classifier returns no usable score', async () => {
    const decision = await moderate(photo, {
      imageClassifier: imageClassifier({}),
      thresholds,
    })
    expect(decision.action).toBe('escalate')
  })

  it('escalates when the classifier omits the nsfw key specifically', async () => {
    const decision = await moderate(photo, {
      imageClassifier: imageClassifier({ drawing: 0.1, neutral: 0.9 }),
      thresholds,
    })
    expect(decision.action).toBe('escalate')
  })

  it('never approves on any failure path', async () => {
    const failures = [
      moderate(photo, { thresholds }),
      moderate(photo, {
        imageClassifier: { name: 'x', score: vi.fn().mockRejectedValue(new Error('down')) },
        thresholds,
      }),
      moderate(photo, {
        imageClassifier: imageClassifier({ nsfw: 0.5 }),
        judge: brokenJudge(),
        thresholds,
      }),
      moderate(cleanText, {
        textClassifier: { name: 'x', score: vi.fn().mockRejectedValue(new Error('down')) },
        thresholds,
      }),
    ]
    for (const decision of await Promise.all(failures)) {
      expect(decision.action).not.toBe('approve')
    }
  })

  it('keeps the raw scores for later threshold tuning', async () => {
    const decision = await moderate(photo, {
      imageClassifier: imageClassifier({ nsfw: 0.42 }),
      judge: judge('uncertain'),
      thresholds,
    })
    expect(decision.tierResults.imageScores).toEqual({ nsfw: 0.42 })
    expect(decision.tierResults.judge).toBeDefined()
  })
})

describe('moderate — tier 2 may approve images but never text', () => {
  it('always consults the judge on text, even when the classifier is confident', async () => {
    const j = judge('safe', 'ordinary litter report')
    const decision = await moderate(cleanText, {
      textClassifier: textClassifier({ toxicity: 0.001 }),
      judge: j,
      thresholds,
    })
    expect(j.judgeText).toHaveBeenCalled()
    expect(decision.decidedBy).toContain('tier3')
    expect(decision.action).toBe('approve')
  })

  it('still lets tier 2 reject text cheaply, without waking the judge', async () => {
    const j = judge('safe')
    const decision = await moderate(cleanText, {
      textClassifier: textClassifier({ insult: 0.99 }),
      judge: j,
      thresholds,
    })
    expect(decision.action).toBe('reject')
    expect(decision.decidedBy).toContain('tier2')
    expect(j.judgeText).not.toHaveBeenCalled()
  })

  it('escalates clean-scoring text when no judge exists, rather than approving it', async () => {
    const decision = await moderate(cleanText, {
      textClassifier: textClassifier({ toxicity: 0.001 }),
      thresholds,
    })
    expect(decision.action).toBe('escalate')
  })

  it('still lets tier 2 approve an image outright', async () => {
    const j = judge('unsafe')
    const decision = await moderate(photo, {
      imageClassifier: imageClassifier({ nsfw: 0.01 }),
      judge: j,
      thresholds,
    })
    expect(decision.action).toBe('approve')
    expect(decision.decidedBy).toContain('tier2')
    expect(j.judgeImage).not.toHaveBeenCalled()
  })
})
