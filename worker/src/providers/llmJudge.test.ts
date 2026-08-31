import { describe, it, expect, vi, afterEach } from 'vitest'
import { parseJudgeResponse, createLlmJudge, JUDGE_RUBRIC } from './llmJudge.js'

const reply = (content: string) => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content } }] }),
})

const SAFE = '{"verdict":"safe","reason":"ordinary litter"}'

describe('parseJudgeResponse', () => {
  it('reads a clean json verdict', () => {
    expect(parseJudgeResponse(SAFE)).toEqual({ verdict: 'safe', reason: 'ordinary litter' })
  })

  it('digs the json out of surrounding prose and fences', () => {
    const fence = String.fromCharCode(96, 96, 96)
    const raw = `Here is my answer:\n${fence}json\n{"verdict":"unsafe","reason":"nudity"}\n${fence}\nHope that helps.`
    expect(parseJudgeResponse(raw).verdict).toBe('unsafe')
  })

  it('falls back to uncertain when there is no json at all', () => {
    expect(parseJudgeResponse('I think it is probably fine').verdict).toBe('uncertain')
  })

  it('falls back to uncertain on malformed json', () => {
    expect(parseJudgeResponse('{"verdict": "safe", ').verdict).toBe('uncertain')
  })

  it('falls back to uncertain on a verdict it does not recognise', () => {
    expect(parseJudgeResponse('{"verdict":"probably-fine"}').verdict).toBe('uncertain')
  })

  it('never invents a safe verdict from unparseable output', () => {
    for (const raw of ['', 'safe', 'null', '{}', '{"reason":"safe"}']) {
      expect(parseJudgeResponse(raw).verdict).not.toBe('safe')
    }
  })

  it('always carries a reason for the audit trail', () => {
    expect(parseJudgeResponse('{"verdict":"safe"}').reason).toBeTruthy()
  })
})

describe('JUDGE_RUBRIC', () => {
  it('teaches the house rule no off-the-shelf classifier knows', () => {
    expect(JUDGE_RUBRIC).toContain('neighbourhood')
    expect(JUDGE_RUBRIC).toContain('people who live there')
  })

  it('warns the model that photos of rubbish are the point, not a violation', () => {
    expect(JUDGE_RUBRIC).toContain('ENTIRE POINT')
  })

  it('warns the model about real place names that look rude', () => {
    expect(JUDGE_RUBRIC).toContain('Penistone')
  })

  it('offers uncertain as a real answer rather than forcing a guess', () => {
    expect(JUDGE_RUBRIC).toContain('UNCERTAIN')
  })
})

describe('createLlmJudge', () => {
  afterEach(() => vi.unstubAllGlobals())

  const options = {
    endpoint: 'http://localhost:11434/v1',
    textModel: 'qwen3:8b',
    visionModel: 'qwen2.5vl:7b',
  }

  it('calls the configured endpoint and text model', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(SAFE)))
    expect((await createLlmJudge(options).judgeText('rubbish by the bins')).verdict).toBe('safe')

    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toBe('http://localhost:11434/v1/chat/completions')
    expect(JSON.parse(init!.body as string).model).toBe('qwen3:8b')
  })

  it('uses the vision model for images', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(SAFE)))
    await createLlmJudge(options).judgeImage('https://img/a.jpg')
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).model).toBe(
      'qwen2.5vl:7b',
    )
  })

  it('switching model is configuration, not code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(SAFE)))
    await createLlmJudge({ ...options, textModel: 'llama-guard3:8b' }).judgeText('x')
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).model).toBe(
      'llama-guard3:8b',
    )
  })

  it('switching machine is configuration, not code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(SAFE)))
    await createLlmJudge({ ...options, endpoint: 'http://192.168.1.40:11434/v1' }).judgeText('x')
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toBe(
      'http://192.168.1.40:11434/v1/chat/completions',
    )
  })

  it('tolerates a trailing slash on the endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(SAFE)))
    await createLlmJudge({ ...options, endpoint: 'http://localhost:11434/v1/' }).judgeText('x')
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toBe(
      'http://localhost:11434/v1/chat/completions',
    )
  })

  it('omits the auth header when no key is configured', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(SAFE)))
    await createLlmJudge(options).judgeText('x')
    expect(vi.mocked(fetch).mock.calls[0][1]!.headers).not.toHaveProperty('Authorization')
  })

  it('sends the auth header when a key is configured', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(SAFE)))
    await createLlmJudge({ ...options, apiKey: 'sk-test' }).judgeText('x')
    expect(vi.mocked(fetch).mock.calls[0][1]!.headers).toMatchObject({
      Authorization: 'Bearer sk-test',
    })
  })

  it('asks for deterministic output', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(SAFE)))
    await createLlmJudge(options).judgeText('x')
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).temperature).toBe(0)
  })

  it('returns uncertain when the model sends no content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }))
    expect((await createLlmJudge(options).judgeText('x')).verdict).toBe('uncertain')
  })

  it('throws when the endpoint errors, so the pipeline escalates', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))
    await expect(createLlmJudge(options).judgeText('x')).rejects.toThrow('503')
  })
})
