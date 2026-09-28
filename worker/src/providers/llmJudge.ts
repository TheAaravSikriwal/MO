import type { Judge, JudgeResult, TextPurpose } from '../types.js'

/**
 * Tier 3 — the only tier that knows MO's own house rules.
 *
 * Tier 2 classifiers are trained on generic toxicity and nudity. They score
 * "this neighbourhood is a slum" as perfectly clean, because by their taxonomy
 * it is. MO's rule that content must never disparage a place or the people in
 * it exists nowhere in any off-the-shelf model, so it has to be handed to a
 * general model as an explicit rubric. That is what this file is for.
 *
 * Any OpenAI-compatible /v1 endpoint works — Ollama, LM Studio, vLLM,
 * llama.cpp, or a hosted provider. Switching machine or model is configuration,
 * never code.
 */

const TIMEOUT_MS = 120_000

const RUBRIC = `You review submissions to tidy, a community map where people report litter and pollution in real places.

Answer with a JSON object only, in this exact shape:
{"verdict": "safe" | "unsafe" | "uncertain", "reason": "<one short sentence>"}

Mark UNSAFE if the content:
- is sexual, pornographic, or shows nudity
- is violent, gory, or depicts injury
- attacks, demeans, or stereotypes a place, a neighbourhood, or the people who live there
- targets a person or group by race, religion, nationality, gender, disability, or similar
- harasses, threatens, or insults a person
- is advertising, spam, or unrelated to litter or pollution

Mark SAFE if the content is an ordinary report about litter, waste, or pollution.

Important context, so you do not over-flag:
- Photographs of rubbish, dumping, dirty water, and neglected ground are the ENTIRE POINT of this app. They are safe.
- Real place names sometimes contain letter sequences that look like rude words. "Penistone Road" is a real street. Judge the meaning, not the letters.
- Blunt frustration about the LITTER is fine. Contempt for the AREA or its RESIDENTS is not. "This mess is disgusting" is safe; "this area is a slum full of animals" is unsafe.
- Non-English text is fine. Judge it on the same rules.

Use UNCERTAIN when you genuinely cannot tell. A person will review those, so an honest "uncertain" is more useful than a guess.`

/**
 * For the name a person chooses to show next to their comments.
 *
 * Separate from RUBRIC because that one rejects anything "unrelated to litter
 * or pollution", and a name always is. The house rule about places and the
 * people in them still applies: a handle can disparage a neighbourhood as
 * easily as a note can.
 */
const NAME_RUBRIC = `You review display names on tidy, a community map where people report litter and pollution in real places. A display name is shown next to the comments a person posts. It is NOT a litter report and does not need to mention litter.

Answer with a JSON object only, in this exact shape:
{"verdict": "safe" | "unsafe" | "uncertain", "reason": "<one short sentence>"}

Mark UNSAFE if the name:
- is sexual or obscene
- is a slur, or targets a person or group by race, religion, nationality, gender, disability, or similar
- attacks, demeans, or stereotypes a place, a neighbourhood, or the people who live there
- harasses, threatens, or insults a person
- pretends to be an official body, such as the council, the police, or the people who run tidy
- is an email address, a phone number, a web address, or advertising

Mark SAFE if it is an ordinary name, nickname, initials, or a harmless handle, such as "Sam", "J. Okafor", "Riverside Litter Picker" or "binbag_hero". Most names are safe.

Important context, so you do not over-flag:
- Real names from any culture or language are safe.
- Names sometimes contain letter sequences that look like rude words. Judge the meaning, not the letters.

Use UNCERTAIN when you genuinely cannot tell. A person will review those, so an honest "uncertain" is more useful than a guess.`

/**
 * A cleaning group's name and description. Separate from RUBRIC for the same
 * reason as NAME_RUBRIC: a group is about cleaning up rather than one report of
 * litter, and "Saturday Litter Pickers" should not be judged as a report that
 * fails to describe any litter.
 */
const GROUP_RUBRIC = `You review cleaning groups on tidy, a community map where people report litter and pollution in real places. A cleaning group is volunteers who clean up an area together. You are shown the group's name, then its description.

Answer with a JSON object only, in this exact shape:
{"verdict": "safe" | "unsafe" | "uncertain", "reason": "<one short sentence>"}

Mark UNSAFE if the name or description:
- is sexual or obscene
- is a slur, or targets a person or group by race, religion, nationality, gender, disability, or similar
- attacks, demeans, or stereotypes a place, a neighbourhood, or the people who live there
- harasses, threatens, or insults a person
- pretends to be an official body, such as the council, the police, or the people who run tidy
- is advertising, or has nothing to do with cleaning up an area
- asks people to share private details, or to meet somewhere unsafe

Mark SAFE if it is an ordinary volunteer group, such as "Riverside Litter Pickers" with "We meet on Saturday mornings by the bridge." Most groups are safe. An email address or web address for the group is fine.

Use UNCERTAIN when you genuinely cannot tell. A person will review those, so an honest "uncertain" is more useful than a guess.`

interface ChatMessageContent {
  type: string
  text?: string
  image_url?: { url: string }
}

export function parseJudgeResponse(raw: string): JudgeResult {
  // Models wrap JSON in prose or fences often enough that grabbing the first
  // object is more reliable than trusting the whole string to parse.
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return { verdict: 'uncertain', reason: 'judge returned no parseable JSON' }

  try {
    const parsed = JSON.parse(match[0]) as { verdict?: unknown; reason?: unknown }
    const verdict = parsed.verdict
    if (verdict !== 'safe' && verdict !== 'unsafe' && verdict !== 'uncertain') {
      return { verdict: 'uncertain', reason: `judge returned an unknown verdict: ${String(verdict)}` }
    }
    const reason = typeof parsed.reason === 'string' && parsed.reason.trim() !== ''
      ? parsed.reason.trim()
      : 'no reason given'
    return { verdict, reason }
  } catch {
    return { verdict: 'uncertain', reason: 'judge returned malformed JSON' }
  }
}

export interface JudgeOptions {
  endpoint: string
  apiKey?: string
  textModel: string
  visionModel: string
}

export function createLlmJudge(options: JudgeOptions): Judge {
  const chat = async (
    model: string,
    content: string | ChatMessageContent[],
    rubric: string = RUBRIC,
  ): Promise<JudgeResult> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const response = await fetch(`${options.endpoint.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            { role: 'system', content: rubric },
            { role: 'user', content },
          ],
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error(`judge endpoint returned ${response.status}`)
      }

      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      const text = body.choices?.[0]?.message?.content
      if (typeof text !== 'string') {
        return { verdict: 'uncertain', reason: 'judge returned no message content' }
      }
      return parseJudgeResponse(text)
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    name: `llm-judge:${options.textModel}/${options.visionModel}`,
    judgeText: (text: string, purpose: TextPurpose) =>
      purpose === 'name'
        ? chat(options.textModel, `Review this display name:\n\n${text}`, NAME_RUBRIC)
        : purpose === 'group'
          ? chat(options.textModel, `Review this cleaning group:\n\n${text}`, GROUP_RUBRIC)
          : chat(options.textModel, `Review this text submission:\n\n${text}`),
    judgeImage: (imageUrl) =>
      chat(options.visionModel, [
        { type: 'text', text: 'Review this photo submitted as a litter report.' },
        { type: 'image_url', image_url: { url: imageUrl } },
      ]),
  }
}

export const JUDGE_RUBRIC = RUBRIC
export const NAME_JUDGE_RUBRIC = NAME_RUBRIC
export const GROUP_JUDGE_RUBRIC = GROUP_RUBRIC
