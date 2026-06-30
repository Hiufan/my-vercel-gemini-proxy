import { GOOGLE_GEMINI_API_URL } from './constants/conf'
import type { Context } from './createContext'
import { createErrorResponse } from './libs/response'
import { pickHeaders } from './utils/pickHeaders'

const GOOGLE_ORIGIN = new URL(GOOGLE_GEMINI_API_URL).origin

function isAllowedGeminiPath(pathname: string) {
  return (
    pathname.startsWith('/api/v1') ||
    pathname.startsWith('/api/v1beta') ||
    pathname.startsWith('/v1') ||
    pathname.startsWith('/v1beta') ||
    pathname.startsWith('/upload/v1') ||
    pathname.startsWith('/upload/v1beta') ||
    pathname === '/files' ||
    pathname.startsWith('/files/') ||
    pathname.startsWith('/files:')
  )
}

function getProxyPath(pathname: string) {
  return pathname.startsWith('/api/') ? pathname.replace(/^\/api/, '') : pathname
}

function rewriteUploadUrl(value: string, requestUrl: URL) {
  try {
    const uploadUrl = new URL(value)

    if (uploadUrl.origin !== GOOGLE_ORIGIN) {
      return value
    }

    return `${requestUrl.origin}${uploadUrl.pathname}${uploadUrl.search}`
  } catch {
    return value
  }
}

function buildResponseHeaders(response: Response, requestUrl: URL) {
  const headers = new Headers(response.headers)
  const uploadUrl = headers.get('x-goog-upload-url')

  if (uploadUrl) {
    headers.set('x-goog-upload-url', rewriteUploadUrl(uploadUrl, requestUrl))
  }

  return headers
}

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

  if (!hasApiKey || !isAllowedGeminiPath(pathname)) {
    return createErrorResponse('No permission', 401)
  }

  const proxyPath = getProxyPath(pathname)
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
    /^x-goog-upload-/i,
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
    headers: buildResponseHeaders(response, requestUrl),
  })
}
