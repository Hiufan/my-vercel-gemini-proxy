import { GOOGLE_GEMINI_API_URL } from './constants/conf'
import type { Context } from './createContext'
import { createErrorResponse } from './libs/response'
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
    pathname.startsWith('/api/v1') ||
    pathname.startsWith('/api/v1beta') ||
    pathname.startsWith('/v1') ||
    pathname.startsWith('/v1beta')

  if (!hasApiKey || !isGeminiPath) {
    return createErrorResponse('No permission', 401)
  }

  const proxyPath = pathname.startsWith('/api/') ? pathname.replace(/^\/api/, '') : pathname
  const proxyUrl = new URL(proxyPath, GOOGLE_GEMINI_API_URL)

  searchParams.delete('_path')
  searchParams.forEach((value, key) => proxyUrl.searchParams.append(key, value))

  if (!proxyUrl.searchParams.has('key') && apiKeyFromHeader) {
    proxyUrl.searchParams.set('key', apiKeyFromHeader)
  }

  const headers = pickHeaders(request.headers, [
    /Content\-Type/i,
    /Content\-Length/i,
    'x-goog-api-client',
    'x-goog-api-key',
  ])

  logger.request.info(`Request "${requestUrl.toString()}" proxy to "${proxyUrl.toString()}".`)

  const response = await fetch(proxyUrl, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : request.body,
    redirect: 'manual',
  })

  logger.response.info(`Proxy response status ${response.status}.`)

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}
