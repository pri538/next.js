if (performance.getEntriesByName('next-start').length === 0) {
  performance.mark('next-start')
}
import '../next'
import '../require-hook'

import type { IncomingMessage, ServerResponse } from 'http'
import type { SelfSignedCertificate } from '../../lib/mkcert'
import type { WorkerRequestHandler, WorkerUpgradeHandler } from './types'

import fs from 'fs'
import path from 'path'
import http from 'http'
import https from 'https'
import Watchpack from 'watchpack'
import * as Log from '../../build/output/log'
import setupDebug from 'next/dist/compiled/debug'
import { RESTART_EXIT_CODE, checkNodeDebugType, getDebugPort } from './utils'
import { formatHostname } from './format-hostname'
import { initialize } from './router-server'
import { CONFIG_FILES } from '../../shared/lib/constants'
import { getStartServerInfo, logStartInfo } from './app-info-log'

const debug = setupDebug('next:start-server')

export interface StartServerOptions {
  dir: string
  port: number
  isDev: boolean
  hostname: string
  allowRetry?: boolean
  customServer?: boolean
  minimalMode?: boolean
  keepAliveTimeout?: number
  // this is dev-server only
  selfSignedCertificate?: SelfSignedCertificate
  isExperimentalTestProxy?: boolean
}

export async function getRequestHandlers({
  dir,
  port,
  isDev,
  server,
  hostname,
  minimalMode,
  isNodeDebugging,
  keepAliveTimeout,
  experimentalTestProxy,
  experimentalHttpsServer,
}: {
  dir: string
  port: number
  isDev: boolean
  server?: import('http').Server
  hostname: string
  minimalMode?: boolean
  isNodeDebugging?: boolean
  keepAliveTimeout?: number
  experimentalTestProxy?: boolean
  experimentalHttpsServer?: boolean
}): ReturnType<typeof initialize> {
  return initialize({
    dir,
    port,
    hostname,
    dev: isDev,
    minimalMode,
    server,
    isNodeDebugging: isNodeDebugging || false,
    keepAliveTimeout,
    experimentalTestProxy,
    experimentalHttpsServer,
  })
}

export async function startServer({
  dir,
  port,
  isDev,
  hostname,
  minimalMode,
  allowRetry,
  keepAliveTimeout,
  isExperimentalTestProxy,
  selfSignedCertificate,
}: StartServerOptions): Promise<void> {
  process.title = 'next-server'
  let handlersReady = () => {}
  let handlersError = () => {}

  let handlersPromise: Promise<void> | undefined = new Promise<void>(
    (resolve, reject) => {
      handlersReady = resolve
      handlersError = reject
    }
  )
  let requestHandler: WorkerRequestHandler = async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> => {
    if (handlersPromise) {
      await handlersPromise
      return requestHandler(req, res)
    }
    throw new Error('Invariant request handler was not setup')
  }
  let upgradeHandler: WorkerUpgradeHandler = async (
    req,
    socket,
    head
  ): Promise<void> => {
    if (handlersPromise) {
      await handlersPromise
      return upgradeHandler(req, socket, head)
    }
    throw new Error('Invariant upgrade handler was not setup')
  }

  // setup server listener as fast as possible
  if (selfSignedCertificate && !isDev) {
    throw new Error(
      'Using a self signed certificate is only supported with `next dev`.'
    )
  }

  async function requestListener(req: IncomingMessage, res: ServerResponse) {
    try {
      if (handlersPromise) {
        await handlersPromise
        handlersPromise = undefined
      }
      await requestHandler(req, res)
    } catch (err) {
      res.statusCode = 500
      res.end('Internal Server Error')
      Log.error(`Failed to handle request for ${req.url}`)
      console.error(err)
    }
  }

  const server = selfSignedCertificate
    ? https.createServer(
        {
          key: fs.readFileSync(selfSignedCertificate.key),
          cert: fs.readFileSync(selfSignedCertificate.cert),
        },
        requestListener
      )
    : http.createServer(requestListener)

  if (keepAliveTimeout) {
    server.keepAliveTimeout = keepAliveTimeout
  }
  server.on('upgrade', async (req, socket, head) => {
    try {
      await upgradeHandler(req, socket, head)
    } catch (err) {
      socket.destroy()
      Log.error(`Failed to handle request for ${req.url}`)
      console.error(err)
    }
  })

  let portRetryCount = 0

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (
      allowRetry &&
      port &&
      isDev &&
      err.code === 'EADDRINUSE' &&
      portRetryCount < 10
    ) {
      Log.warn(`Port ${port} is in use, trying ${port + 1} instead.`)
      port += 1
      portRetryCount += 1
      server.listen(port, hostname)
    } else {
      Log.error(`Failed to start server`)
      console.error(err)
      process.exit(1)
    }
  })

  const nodeDebugType = checkNodeDebugType()

  await new Promise<void>((resolve) => {
    server.on('listening', async () => {
      const addr = server.address()
      const actualHostname = formatHostname(
        typeof addr === 'object'
          ? addr?.address || hostname || 'localhost'
          : addr
      )
      const formattedHostname =
        !hostname || actualHostname === '0.0.0.0'
          ? 'localhost'
          : actualHostname === '[::]'
          ? '[::1]'
          : formatHostname(hostname)

      port = typeof addr === 'object' ? addr?.port || port : port

      const networkUrl = hostname ? `http://${actualHostname}:${port}` : null
      const appUrl = `${
        selfSignedCertificate ? 'https' : 'http'
      }://${formattedHostname}:${port}`

      if (nodeDebugType) {
        const debugPort = getDebugPort()
        Log.info(
          `the --${nodeDebugType} option was detected, the Next.js router server should be inspected at port ${debugPort}.`
        )
      }

      // expose the main port to render workers
      process.env.PORT = port + ''

      try {
        const cleanup = (code: number | null) => {
          debug('start-server process cleanup')
          server.close()
          process.exit(code ?? 0)
        }
        const exception = (err: Error) => {
          // This is the render worker, we keep the process alive
          console.error(err)
        }
        process.on('exit', (code) => cleanup(code))
        // callback value is signal string, exit with 0
        process.on('SIGINT', () => cleanup(0))
        process.on('SIGTERM', () => cleanup(0))
        process.on('uncaughtException', exception)
        process.on('unhandledRejection', exception)

        const initResult = await getRequestHandlers({
          dir,
          port,
          isDev,
          server,
          hostname,
          minimalMode,
          isNodeDebugging: Boolean(nodeDebugType),
          keepAliveTimeout,
          experimentalTestProxy: !!isExperimentalTestProxy,
          experimentalHttpsServer: !!selfSignedCertificate,
        })
        requestHandler = initResult[0]
        upgradeHandler = initResult[1]

        const startServerProcessDuration =
          performance.mark('next-start-end') &&
          performance.measure(
            'next-start-duration',
            'next-start',
            'next-start-end'
          ).duration

        const formatDurationText =
          startServerProcessDuration > 2000
            ? `${Math.round(startServerProcessDuration / 100) / 10}s`
            : `${Math.round(startServerProcessDuration)}ms`

        handlersReady()

        // Only load env and config in dev to for logging purposes
        let envInfo: string[] | undefined
        let expFeatureInfo: string[] | undefined
        if (isDev) {
          const startServerInfo = await getStartServerInfo(dir)
          envInfo = startServerInfo.envInfo
          expFeatureInfo = startServerInfo.expFeatureInfo
        }
        logStartInfo({
          networkUrl,
          appUrl,
          envInfo,
          expFeatureInfo,
          formatDurationText,
          maxExperimentalFeatures: 3,
        })
      } catch (err) {
        // fatal error if we can't setup
        handlersError()
        console.error(err)
        process.exit(1)
      }

      resolve()
    })
    server.listen(port, hostname)
  })

  if (isDev) {
    function watchConfigFiles(
      dirToWatch: string,
      onChange: (filename: string) => void
    ) {
      const wp = new Watchpack()
      wp.watch({
        files: CONFIG_FILES.map((file) => path.join(dirToWatch, file)),
      })
      wp.on('change', onChange)
    }
    watchConfigFiles(dir, async (filename) => {
      if (process.env.__NEXT_DISABLE_MEMORY_WATCHER) {
        Log.info(
          `Detected change, manual restart required due to '__NEXT_DISABLE_MEMORY_WATCHER' usage`
        )
        return
      }

      Log.warn(
        `Found a change in ${path.basename(
          filename
        )}. Restarting the server to apply the changes...`
      )
      process.exit(RESTART_EXIT_CODE)
    })
  }
}

if (process.env.NEXT_PRIVATE_WORKER && process.send) {
  process.addListener('message', async (msg: any) => {
    if (msg && typeof msg && msg.nextWorkerOptions && process.send) {
      await startServer(msg.nextWorkerOptions)
      process.send({ nextServerReady: true })
    }
  })
  process.send({ nextWorkerReady: true })
}
