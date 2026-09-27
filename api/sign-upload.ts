import { createSignUploadHandler } from './_lib/signUpload'

/**
 * POST /api/sign-upload
 *
 * The whole endpoint is four lines because everything it does lives in
 * `_lib/signUpload.ts`, where it can be tested without a deployment. This file
 * is only the seam between Vercel's runtime and that handler: the environment,
 * the clock and the random id come from here, so the tests can supply their
 * own and stay deterministic.
 *
 * Edge runtime, because Web Crypto and `Request`/`Response` are native there
 * and the handler needs nothing else — no Node built-ins, no dependencies.
 */
export const config = { runtime: 'edge' }

declare const process: { env: Record<string, string | undefined> }

/**
 * Note what is NOT covered by the handler's own catch: this file.
 *
 * `process.env` is read out here, before `createSignUploadHandler` returns the
 * function that has the try/catch inside it. So a wrong runtime declaration or
 * export shape fails in the platform rather than in our code, and the reply is
 * not the `{message}` JSON every other path produces. `api/README.md` has that
 * as its own row in the diagnosis table, because it is the one case with no
 * better signal than the Vercel build log.
 */
export default function handler(request: Request): Promise<Response> {
  return createSignUploadHandler(process.env, {
    fetch: globalThis.fetch,
    now: () => new Date(),
    randomUUID: () => crypto.randomUUID(),
  })(request)
}
