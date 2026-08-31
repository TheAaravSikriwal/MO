import type { Judge, JudgeResult } from '../types.js'

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

const RUBRIC = `You review submissions to MO, a community map where people report litter and pollution in real places.

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
  const chat = async (model: string, content: string | ChatMessageContent[]): Promise<JudgeResult> => {
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
            { role: 'system', content: RUBRIC },
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
    judgeText: (text) => chat(options.textModel, `Review this text submission:\n\n${text}`),
    judgeImage: (imageUrl) =>
      chat(options.visionModel, [
        { type: 'text', text: 'Review this photo submitted as a litter report.' },
        { type: 'image_url', image_url: { url: imageUrl } },
      ]),
  }
}

export const JUDGE_RUBRIC = RUBRIC
