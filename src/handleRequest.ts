import { GOOGLE_GEMINI_API_URL, TIMEOUT } from './constants/conf'
import type { Context } from './createContext'
import { ProcessTransformStream } from './libs/ProcessTransformStream'
import { createErrorResponse, createException, createResponse } from './libs/response'
import { type WebWritableStream, WritableStream } from './libs/TransformStream'
import type { Message } from './types/message'
import { convertStringToUint8Array } from './utils/convertStringToUint8Array'
import { getContentLength } from './utils/getContentLength'
import { pickHeaders } from './utils/pickHeaders'

/** Handle the incoming request. */
export async function handleRequest(context: Context) {
  const { request, logger } = context
  const { method, nextUrl, url } = request

  if (method === 'OPTIONS') {
    return createErrorResponse(null, 500)
  }

  const requestUrl = nextUrl ? nextUrl : new URL(url)
  const { pathname, searchParams } = requestUrl
  const params = Object.fromEntries(searchParams.entries())

  logger.request.info(`Use ${method.toUpperCase()} to request ${pathname} with search ${JSON.stringify(params, null, 2)}`)

  const apiKeyFromQuery = searchParams.get('key')
  const apiKeyFromHeader = request.headers.get('x-goog-api-key')
  const hasApiKey = Boolean(apiKeyFromQuery || apiKeyFromHeader)

  const isGeminiPath =
    pathname.startsWith('/api/v1') || pathname.startsWith('/api/v1beta')

  if (!hasApiKey || !isGeminiPath) {
    return createErrorResponse('No permission', 401)
  }

  const proxyPath = pathname.replace(/^\/api/, '')
  const proxyUrl = new URL(proxyPath, GOOGLE_GEMINI_API_URL)

  searchParams.delete('_path')
  searchParams.forEach((value, key) => proxyUrl.searchParams.append(key, value))

  if (!proxyUrl.searchParams.has('key') && apiKeyFromHeader) {
    proxyUrl.searchParams.set('key', apiKeyFromHeader)
  }

  const { headers: reqHeaders, body } = request
  const headers = pickHeaders(reqHeaders, [
    /Content\-Type/i,
    /Content\-Length/i,
    'x-goog-api-client',
    'x-goog-api-key',
  ])

  const isModelsEndpoint = /^\/api\/v1(beta)?\/models\/?$/.test(pathname)

  if (isModelsEndpoint && !body) {
    logger.request.info(`Request "${requestUrl.toString()}" proxy to "${proxyUrl.toString()}".`)

    const response = await fetch(proxyUrl, {
      method,
      headers,
    })

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }

  if (!body) {
    logger.request.fail('Proxy failed: body is empty.')
    return createErrorResponse('Proxy failed: body is empty.', 403)
  }

  const readBody = async (): Promise<Message> => {
    const requestStream = new ProcessTransformStream()
    requestStream.process(({ message }) => logger.request.info(message))
    requestStream.setContentSize(getContentLength(reqHeaders))

    const writableStream = new WritableStream()
    await body.pipeThrough(requestStream).pipeTo(writableStream)
    const { content } = requestStream

    try {
      return JSON.parse(content)
    } catch (error) {
      const reason = error instanceof Error ? error?.message : error?.toString()
      const message = 'Proxy failed: request content is invalid json.'
      logger.request.fail(`${message}\nReason: ${reason}\nValue: ${content}`)
      throw new Error(message)
    }
  }

  const payload = await readBody()
  const firstContnet = payload?.contents.at(0)

  if (firstContnet?.role !== 'user') {
    payload.contents.splice(0, 1)
    logger.request.warn('First message in the payload does not have the role of "user". It has been removed.')
  }

  const lastContent = payload?.contents?.at(-1)
  if (lastContent?.role !== 'user') {
    logger.response.warn('The last message in the payload does not have the role of "user".')
    return createResponse(lastContent || null)
  }

  logger.request.info(`Request "${requestUrl.toString()}" proxy to "${proxyUrl.toString()}".`)

  const responseStream = new ProcessTransformStream()
  responseStream.process(({ message }) => logger.response.info(message))

  const requestStartTime = Date.now()
  const controller = new AbortController()
  const handleTimeout = () => {
    const reason = new Error(`The request timed out for more than ${(TIMEOUT / 1e3).toFixed(2)}m.`)
    logger.request.fail(reason.message)
    return controller.abort(reason)
  }

  const timeoutId = setTimeout(handleTimeout, TIMEOUT)
  const fetchOptions: RequestInit = {
    method,
    headers,
    body: JSON.stringify(payload),
    signal: controller.signal,
  }

  const writeResponseToWritableStream = (stream: WebWritableStream) => async (response: Response) => {
    const { status, body } = response
    const write = async (content: string) => {
      const writer = stream.getWriter()
      await writer.ready

      const value = convertStringToUint8Array(content)
      await writer.write(value)
      await writer.close()
      writer.releaseLock()
    }

    if (!body) {
      logger.response.fail(`Proxy failed with status code ${status}.\nResponse content is empty.`)
      const exception = createException('Nothing response.')
      await write(exception.toJson())
      return
    }

    if (400 <= status || status > 200) {
      const result = await response.text()
      const message = `Proxy failed with status code ${status}. reason:${result}`
      const exception = createException(message)

      logger.response.fail(`${message}\nResponse content is ${result}.`)
      await write(exception.toJson())
      return
    }

    const writer = stream.getWriter()
    try {
      const responseStartTime = Date.now()
      const reader = body.getReader()
      const read = async () => {
        const { done, value } = await reader.read()
        if (done) {
          await writer.close()
          writer.releaseLock()
          return
        }

        const content = convertStringToUint8Array(value)

        await writer.ready
        await writer.write(content)
        await read()
      }

      await read()

      logger.response.info(`Response spent ${((Date.now() - responseStartTime) / 1e3).toFixed(3)} s.`)
    } catch (error) {
      const message = error instanceof Error ? error?.message : error
      logger.response.fail(`Proxy failed with some errors.\n${message}`)

      await writer.ready
      await writer.write(JSON.stringify({ message }))
      await writer.close()
      writer.releaseLock()
    }
  }

  const writeErrorToWritableStream = (stream: WebWritableStream) => async (error: any) => {
    const message = error instanceof Error ? error.message : error?.toString()
    const writer = stream.getWriter()
    await writer.ready

    const exception = createException(message)
    await writer.write(exception.toJson())
    await writer.close()
  }

  logger.request.info(`Proxy request ${proxyUrl} with options ${JSON.stringify(fetchOptions, null, 2)}.`)

  fetch(proxyUrl, fetchOptions)
    .then(async (response) => {
      clearTimeout(timeoutId)

      logger.request.info(`Request spent ${((Date.now() - requestStartTime) / 1e3).toFixed(3)}s.`)
      responseStream.setContentSize(getContentLength(response.headers))

      const handleResponse = writeResponseToWritableStream(responseStream.writable)
      await handleResponse(response)
    })
    .catch(async (error) => {
      logger.response.fail(`Proxy failed with some errors.\n${error}`)

      if (responseStream.writable.locked) {
        logger.response.fail('Close the response stream.')
        responseStream.writable.getWriter().releaseLock()
      }

      clearTimeout(timeoutId)

      const handleResponse = writeErrorToWritableStream(responseStream.writable)
      await handleResponse(error)
    })

  logger.response.info('proxy stream start.')
  return new Response(responseStream.readable, { status: 200, statusText: 'ok', headers })
}
