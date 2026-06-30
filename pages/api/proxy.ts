import type { NextApiRequest, NextApiResponse } from 'next'

import proxy from '@/index'

export const config = {
  api: {
    bodyParser: false,
    responseLimit: false,
  },
  maxDuration: 300,
}

function getRequestUrl(req: NextApiRequest) {
  const host = req.headers.host ?? 'localhost'
  const protocol = req.headers['x-forwarded-proto'] ?? 'https'
  const rawUrl = req.url ?? '/'

  return `${protocol}://${host}${rawUrl}`
}

function getRequestHeaders(req: NextApiRequest) {
  const headers = new Headers()

  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) {
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

  return headers
}

function createWebRequest(req: NextApiRequest) {
  const method = req.method ?? 'GET'

  return new Request(getRequestUrl(req), {
    method,
    headers: getRequestHeaders(req),
    body: method === 'GET' || method === 'HEAD' ? undefined : req,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })
}

async function sendWebResponse(webResponse: Response, res: NextApiResponse) {
  res.statusCode = webResponse.status
  res.statusMessage = webResponse.statusText

  webResponse.headers.forEach((value, key) => {
    res.setHeader(key, value)
  })

  if (!webResponse.body) {
    res.end()
    return
  }

  const reader = webResponse.body.getReader()

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
  try {
    const webResponse = await proxy(createWebRequest(req))
    await sendWebResponse(webResponse, res)
  } catch {
    res.status(500).json({ error: 'Proxy request failed' })
  }
}
