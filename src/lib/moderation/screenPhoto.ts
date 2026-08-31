import { checkPhotoFile, judgeNsfwScores, loadNsfwScorer, type GateResult } from './clientGate'

/** Injected in tests so nothing has to load TensorFlow. */
export type PhotoScreener = (file: File) => Promise<GateResult>

const ALLOWED: GateResult = { blocked: false }

/** Turn a chosen file into an image element the model can read. */
async function toImageElement(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    return image
  } finally {
    // decode() has already read the bytes, so the handle can go now.
    URL.revokeObjectURL(url)
  }
}

/**
 * Tier 1's photo check: the cheap file checks, then the NSFW model.
 *
 * FAILS OPEN on every model problem — a failed load, a decode error, a browser
 * without the APIs. Tier 1 exists for fast feedback and to keep obvious junk
 * out of the review queue; the server tiers are what actually protect the map.
 * Refusing every upload because a model file 404'd would break the app for
 * everyone to prevent nothing, since anyone determined can skip this code
 * entirely by calling the API directly.
 *
 * The cheap file checks above it still fail closed — those are certain.
 */
export const screenPhotoWithModel: PhotoScreener = async (file) => {
  const basic = checkPhotoFile(file)
  if (basic.blocked) return basic

  try {
    const scorer = await loadNsfwScorer()
    if (!scorer) return ALLOWED

    const image = await toImageElement(file)
    return judgeNsfwScores(await scorer(image))
  } catch {
    return ALLOWED
  }
}

/** Used when no model should run at all, e.g. in tests. */
export const screenPhotoFileOnly: PhotoScreener = async (file) => checkPhotoFile(file)
