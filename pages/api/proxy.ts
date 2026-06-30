import type { NextApiRequest, NextApiResponse } from 'next'

import { GOOGLE_GEMINI_API_URL } from '@/constants/conf'

const GOOGLE_ORIGIN = new URL(GOOGLE_GEMINI_API_URL).origin

export const config = {
  api: {
    bodyParser: false,
    externalResolver: true,
    responseLimit: false,
  },
  maxDuration: 300,
}

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

function getRewrittenPath(req: NextApiRequest) {
  const path = req.query._path

  if (Array.isArray(path)) {
    return `/${path.join('/')}`
  }

  if (typeof path === 'string' && path.length > 0) {
    return `/${path}`
  }

  return undefined
}

function getRequestUrl(req: NextApiRequest) {
  const host = req.headers.host ?? 'localhost'
  const protocol = req.headers['x-forwarded-proto'] ?? 'https'
  const requestUrl = new URL(req.url ?? '/', `${protocol}://${host}`)
  const rewrittenPath = getRewrittenPath(req)

  if (rewrittenPath) {
    requestUrl.pathname = rewrittenPath
    requestUrl.searchParams.delete('_path')
  }

  return requestUrl
}

function getHeader(req: NextApiRequest, key: string) {
  const value = req.headers[key.toLowerCase()]

  if (Array.isArray(value)) {
    return value[0]
  }

  return value
}

function appendForwardHeaders(req: NextApiRequest, headers: Headers) {
  const allowedHeaders = [
    'content-type',
    'content-length',
    'x-goog-api-client',
    'x-goog-api-key',
  ]

  for (const key of allowedHeaders) {
    const value = getHeader(req, key)

    if (value) {
      headers.set(key, value)
    }
  }

  for (const [key, value] of Object.entries(req.headers)) {
    if (!key.startsWith('x-goog-upload-') || value === undefined) {
      continue
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item)
      }
      continue
    }

    headers.set(key, value)
  }
}

function getGoogleUrl(req: NextApiRequest) {
  const requestUrl = getRequestUrl(req)
  const proxyPath = getProxyPath(requestUrl.pathname)
  const googleUrl = new URL(proxyPath, GOOGLE_GEMINI_API_URL)

  requestUrl.searchParams.delete('_path')
  requestUrl.searchParams.forEach((value, key) => {
    googleUrl.searchParams.append(key, value)
  })

  const apiKeyFromHeader = getHeader(req, 'x-goog-api-key')

  if (!googleUrl.searchParams.has('key') && apiKeyFromHeader) {
    googleUrl.searchParams.set('key', apiKeyFromHeader)
  }

  return { googleUrl, requestUrl }
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

function sendResponseHeaders(response: Response, requestUrl: URL, res: NextApiResponse) {
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'content-encoding') {
      return
    }

    if (key.toLowerCase() === 'x-goog-upload-url') {
      res.setHeader(key, rewriteUploadUrl(value, requestUrl))
      return
    }

    res.setHeader(key, value)
  })
}

async function sendResponseBody(response: Response, res: NextApiResponse) {
  if (!response.body) {
    res.end()
    return
  }

  const reader = response.body.getReader()

  try {
    while (true) {
      const { done, value } = await reader.read()

      if (done) {
        break
      }

      res.write(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }

  res.end()
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }

  const { googleUrl, requestUrl } = getGoogleUrl(req)
  const apiKeyFromQuery = requestUrl.searchParams.get('key')
  const apiKeyFromHeader = getHeader(req, 'x-goog-api-key')

  if (!apiKeyFromQuery && !apiKeyFromHeader) {
    res.status(401).json({ error: 'No permission' })
    return
  }

  if (!isAllowedGeminiPath(requestUrl.pathname)) {
    res.status(401).json({ error: 'No permission' })
    return
  }

  const headers = new Headers()
  appendForwardHeaders(req, headers)

  try {
    const response = await fetch(googleUrl, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req,
      duplex: 'half',
      redirect: 'manual',
    } as RequestInit & { duplex: 'half' })

    res.statusCode = response.status
    res.statusMessage = response.statusText
    sendResponseHeaders(response, requestUrl, res)
    await sendResponseBody(response, res)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Proxy request failed'
    res.status(500).json({ error: message })
  }
}
