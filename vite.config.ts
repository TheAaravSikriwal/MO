import { defineConfig } from 'vitest/config'
import { loadEnv, type PluginOption, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import type { IncomingMessage, ServerResponse } from 'node:http'
import tailwindcss from '@tailwindcss/vite'

/**
 * Serve `POST /api/sign-upload` under `npm run dev`.
 *
 * In production Vercel turns `api/sign-upload.ts` into a function. The Vite dev
 * server knows nothing about that, so without this the endpoint 404s locally
 * and the app reports a generic "could not be uploaded" instead of the honest
 * reason -- which is exactly the wrong signal for the one person trying to get
 * uploads working for the first time.
 *
 * It loads the handler through `ssrLoadModule` so the signing code is never
 * pulled into this config or into the browser bundle, and it hands over
 * `loadEnv` values because Vite puts `.env` into `import.meta.env`, not
 * `process.env`.
 */
function signUploadDevRoute(env: Record<string, string>): PluginOption {
  return {
    name: 'mo:sign-upload-dev',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/api/sign-upload', (req: IncomingMessage, res: ServerResponse) => {
        void (async () => {
          try {
            const chunks: Uint8Array[] = []
            for await (const chunk of req) chunks.push(chunk as Uint8Array)

            const headers = new Headers()
            for (const [name, value] of Object.entries(req.headers)) {
              if (typeof value === 'string') headers.set(name, value)
              else if (Array.isArray(value)) headers.set(name, value.join(', '))
            }

            const module = await server.ssrLoadModule('/api/_lib/signUpload.ts')
            const handle = module.createSignUploadHandler(env, {
              fetch: globalThis.fetch,
              now: () => new Date(),
              randomUUID: () => crypto.randomUUID(),
            })

            const method = req.method ?? 'GET'
            const response: Response = await handle(
              new Request('http://localhost/api/sign-upload', {
                method,
                headers,
                body:
                  method === 'GET' || method === 'HEAD' || chunks.length === 0
                    ? undefined
                    : Buffer.concat(chunks),
              }),
            )

            res.statusCode = response.status
            response.headers.forEach((value, name) => res.setHeader(name, value))
            res.end(await response.text())
          } catch (cause) {
            // Never leave the request hanging: a dead socket looks like a
            // network fault and sends you looking in the wrong place.
            server.config.logger.error(`[mo] /api/sign-upload failed in dev: ${String(cause)}`)
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ message: 'Something went wrong preparing the upload.' }))
          }
        })()
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  // '' rather than 'VITE_': the endpoint's variables are deliberately not
  // VITE_-prefixed, because they must never reach a browser.
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [react(), tailwindcss(), signUploadDevRoute(env)],
    test: {
      environment: 'jsdom',
      setupFiles: ['./vitest.setup.ts'],
      globals: true,
      // Scoped to the app and its own serverless endpoints, which deploy with
      // it. The worker is a separate package with its own config and runs in
      // node, not jsdom; without this it gets swept in here and passes under
      // the wrong environment by luck.
      include: ['src/**/*.test.{ts,tsx}', 'api/**/*.test.ts'],
    },
  }
})
