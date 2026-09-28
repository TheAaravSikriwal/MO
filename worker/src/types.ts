export type SubjectType = 'photo' | 'comment' | 'note' | 'name' | 'group'
export type ModerationStatus = 'pending' | 'approved' | 'rejected'
export type JobStatus = 'pending' | 'in_progress' | 'done' | 'failed'

/** What the worker decided to do with one piece of content. */
export type Action = 'approve' | 'reject' | 'escalate'

export interface Decision {
  action: Action
  /** Which tier settled it: 'tier2:obscenity', 'tier3:qwen3:8b', 'tier2:unavailable'. */
  decidedBy: string
  /** Plain sentence, stored on the job so a human reviewer knows why they got it. */
  reason: string
  /** Raw scores, kept for tuning thresholds later. */
  tierResults: Record<string, unknown>
}

export interface Band {
  /** Above this, reject outright. */
  rejectAbove: number
  /** Below this, approve outright. Between the two, a human decides. */
  approveBelow: number
}

export interface Thresholds {
  nsfw: Band
  toxicity: Band
}

export interface ModerationJob {
  id: string
  subject_type: SubjectType
  subject_id: string
  attempts: number
}

/**
 * What a piece of text is, because the judge's rules depend on it.
 *
 * A note or a comment is about litter, and "unrelated to litter" is a fair
 * reason to turn one down. A name is not about litter at all -- judged by the
 * same rubric, "Sam" is unrelated to litter and gets rejected, which locks
 * that person out of posting.
 */
export type TextPurpose = 'report' | 'name' | 'group'

/** Content pulled from the database for a job. */
export type Subject =
  | { kind: 'text'; text: string; purpose: TextPurpose }
  | { kind: 'image'; url: string }

// --- Provider interfaces ---------------------------------------------------
//
// Each tier is defined by its ROLE, not by a model. Any implementation that
// satisfies these interfaces can be swapped in by configuration alone.

export interface TextClassifier {
  readonly name: string
  /** Category scores in 0..1, e.g. { toxicity: 0.9, insult: 0.8 }. */
  score(text: string): Promise<Record<string, number>>
}

export interface ImageClassifier {
  readonly name: string
  /** Scores in 0..1. Must include `nsfw`. */
  score(imageUrl: string): Promise<Record<string, number>>
}

export interface JudgeResult {
  verdict: 'safe' | 'unsafe' | 'uncertain'
  reason: string
}

/** Tier 3. The only tier that knows MO's own house rules. */
export interface Judge {
  readonly name: string
  judgeText(text: string, purpose: TextPurpose): Promise<JudgeResult>
  judgeImage(imageUrl: string): Promise<JudgeResult>
}
