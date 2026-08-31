import { classifyScore, worstScore, actionFromJudge } from './decide.js'
import { checkWordlist } from './providers/obscenityText.js'
import type {
  Decision,
  ImageClassifier,
  Judge,
  Subject,
  TextClassifier,
  Thresholds,
} from './types.js'

export interface Tiers {
  textClassifier?: TextClassifier
  imageClassifier?: ImageClassifier
  judge?: Judge
  thresholds: Thresholds
}

const escalate = (reason: string, tierResults: Record<string, unknown> = {}): Decision => ({
  action: 'escalate',
  decidedBy: 'escalated',
  reason,
  tierResults,
})

/**
 * Run one piece of content through the tiers, cheapest first.
 *
 * The invariant this whole file exists to hold: NOTHING is ever approved by
 * accident. Every failure path — a classifier that is down, a judge that times
 * out, a malformed response, a missing configuration — ends in escalation, so
 * the worst case is a human doing work, never an unreviewed image going public.
 *
 * Each tier only sees what the previous tier could not settle, with one
 * deliberate asymmetry: tier 2 may auto-approve an IMAGE but never TEXT. The
 * main image risk is obscenity, which an NSFW classifier measures directly, so
 * a low score there is real evidence. The main text risk under MO's rules is
 * tone, which no generic classifier measures, so a low score there is evidence
 * of nothing.
 */
export async function moderate(subject: Subject, tiers: Tiers): Promise<Decision> {
  const tierResults: Record<string, unknown> = {}

  // --- Tier 2 ---------------------------------------------------------------

  if (subject.kind === 'text') {
    const wordlist = checkWordlist(subject.text)
    tierResults.wordlist = wordlist

    // A wordlist hit does NOT reject. MO maps real places and place names
    // collide with the wordlist -- "Penistone Road" matches on `penis`. It is a
    // signal to look harder, which means handing it to tier 3.
    if (!wordlist.matched && tiers.textClassifier) {
      try {
        const scores = await tiers.textClassifier.score(subject.text)
        tierResults.textScores = scores
        const action = classifyScore(worstScore(scores), tiers.thresholds.toxicity)

        // For text, tier 2 may only REJECT. It must never approve.
        //
        // Generic toxicity classifiers measure insult and profanity. MO's own
        // rule -- never disparage a place or the people in it -- is not in any
        // of their taxonomies. "This whole neighbourhood is a slum" scores
        // around 0.05 on Detoxify, comfortably inside the auto-approve band.
        // Letting tier 2 approve on that score would mean the house rule was
        // never enforced at all, because the only tier that knows the rule
        // would never run.
        if (action === 'reject') {
          return {
            action,
            decidedBy: `tier2:${tiers.textClassifier.name}`,
            reason: `text classifier scored ${worstScore(scores)}`,
            tierResults,
          }
        }
      } catch (error) {
        tierResults.textClassifierError = String(error)
      }
    }
  } else if (tiers.imageClassifier) {
    try {
      const scores = await tiers.imageClassifier.score(subject.url)
      tierResults.imageScores = scores
      const action = classifyScore(scores.nsfw, tiers.thresholds.nsfw)
      if (action !== 'escalate') {
        return {
          action,
          decidedBy: `tier2:${tiers.imageClassifier.name}`,
          reason: `image classifier scored ${scores.nsfw}`,
          tierResults,
        }
      }
    } catch (error) {
      tierResults.imageClassifierError = String(error)
    }
  }

  // --- Tier 3 ---------------------------------------------------------------

  if (!tiers.judge) {
    return escalate('no judge configured and tier 2 could not decide', tierResults)
  }

  try {
    const result =
      subject.kind === 'text'
        ? await tiers.judge.judgeText(subject.text)
        : await tiers.judge.judgeImage(subject.url)

    tierResults.judge = result
    const action = actionFromJudge(result)

    if (action === 'escalate') {
      return escalate(result.reason, tierResults)
    }

    return {
      action,
      decidedBy: `tier3:${tiers.judge.name}`,
      reason: result.reason,
      tierResults,
    }
  } catch (error) {
    tierResults.judgeError = String(error)
    return escalate('judge was unreachable', tierResults)
  }
}
