# MO moderation worker

Drains MO's moderation queue. Standalone — its own dependencies, its own config,
imports nothing from the app.

## Running it

```bash
npm install
cp ../.env.example .env    # then fill in the worker section
npm start
```

It needs **outbound HTTPS to Supabase and nothing else**. No inbound port, no
tunnel, no static IP, no domain. That is what makes moving it between machines
a matter of copying the folder, editing `.env`, and running it again.

## Switching model or machine

Both are one line of config. Nothing in this package names a model.

```bash
MODERATION_ENDPOINT=http://192.168.1.40:11434/v1    # your PC
MODERATION_ENDPOINT=http://homeserver.lan:8000/v1   # a local server
MODERATION_ENDPOINT=https://api.openai.com/v1       # hosted

MODERATION_TEXT_MODEL=qwen3:8b
MODERATION_VISION_MODEL=qwen2.5vl:7b
```

Any OpenAI-compatible `/v1` endpoint works, which covers Ollama, LM Studio,
vLLM, llama.cpp and the hosted providers. The tiers are defined by **role**, not
by model, so swapping `qwen3:8b` for `llama-guard3:8b` is a rename.

Rough sizing: an 8B text model at Q4 needs about 5–6 GB of VRAM, a 7B vision
model about 6–7 GB. 8 GB runs either; 12 GB holds both resident. Tier 2 needs no
GPU at all.

## The tiers

| Tier | Text | Image | Where |
|---|---|---|---|
| 1 | `obscenity` | `nsfwjs` | Browser — **not** in this package |
| 2 | wordlist, then `TEXT_CLASSIFIER_URL` | `IMAGE_CLASSIFIER_URL` | Here, CPU |
| 3 | `MODERATION_TEXT_MODEL` | `MODERATION_VISION_MODEL` | Here, GPU |
| 4 | Admin queue | Admin queue | The app |

Tier 2 classifiers are plain HTTP: POST JSON, get back a flat map of category
scores in 0..1. Detoxify, a NSFW ViT classifier, NudeNet or anything else fits
that shape. Leave a URL unset and that classifier is simply absent.

## Three rules worth knowing

**Everything fails closed.** A classifier that is down, a judge that times out, a
malformed response, a missing config — every one of them escalates to a human.
Nothing is ever approved by accident. `pipeline.test.ts` asserts this across
every failure path.

**Tier 2 may approve an image, but never text.** The main image risk is
obscenity, which an NSFW classifier measures directly, so a low score is real
evidence. The main text risk under MO's rules is *tone*, which no generic
classifier measures at all.

Measured: "this whole neighbourhood is a slum" scores about 0.05 on a generic
toxicity classifier — comfortably inside the auto-approve band. If tier 2 could
approve text, MO's rule about never disparaging a place would never be enforced,
because the only tier that knows the rule would never run.

**A wordlist match escalates; it does not reject.** MO maps real places, and
place names collide with profanity lists. Measured: "Litter near Penistone Road"
matches on `penis`. Penistone is a real town in South Yorkshire. The library
whitelists a few famous cases — Scunthorpe and Clitheroe both pass — but no
dataset covers every place name on Earth, and auto-rejecting would silently
censor a legitimate report about a real road.

Also measured, and worth knowing: the wordlist catches `f*ck` and `sh1t`, but
**misses** `f u c k` with spaces between the letters. It is a cheap first pass,
not a guarantee.

## Keeping the human queue small

Only the uncertain middle reaches a person. Widen the bands if your queue is
noisier than you want — no code change:

```bash
NSFW_AUTO_REJECT_ABOVE=0.85
NSFW_AUTO_APPROVE_BELOW=0.15
TOXICITY_AUTO_REJECT_ABOVE=0.80
TOXICITY_AUTO_APPROVE_BELOW=0.20
```

The worker refuses to start on an inverted or overlapping band. A worker that
booted with a broken band would silently approve things it should have
escalated, and nobody would notice until something bad was already public.
Failing to start is the safe failure.

## Layout

| File | Responsibility |
|---|---|
| `src/decide.ts` | Pure threshold logic. No I/O, heavily tested |
| `src/config.ts` | Environment parsing and validation |
| `src/pipeline.ts` | Tier orchestration and the fail-closed guarantee |
| `src/queue.ts` | The only file that talks to Supabase |
| `src/providers/` | Swappable tier 2 and tier 3 implementations |
| `src/index.ts` | The polling loop |

```bash
npm test        # 97 tests, no network, no database, no models
npm run typecheck
```

## What is not covered

The tests use fake providers throughout, so they prove the **pipeline** behaves —
not that any real model does. Accuracy of a given classifier or judge can only
be measured against real content once one is running.

`src/queue.ts` has no tests: it is a thin wrapper over RPCs that do not exist yet
on any live database. It should be verified against a real Supabase project
before being trusted.

## Not built yet

CSAM scanning. It is a legal obligation rather than a moderation preference and
none of the four tiers address it. The plan is Cloudflare's free scanning tool
applied to the R2 hostname serving the photos — see the design spec.
