// One small client for the GaugeLab API. Errors carry the server's message so screens can
// show something actionable instead of "Request failed".

export class ApiError extends Error {
  status: number
  details: string[]
  constructor(status: number, message: string, details: string[] = []) {
    super(message)
    this.status = status
    this.details = details
  }
}

async function parse(res: Response): Promise<never> {
  let message = `${res.status} ${res.statusText}`
  let details: string[] = []
  try {
    const body = await res.json()
    const d = body?.detail
    if (typeof d === 'string') message = d
    else if (d && typeof d === 'object' && 'message' in d) {
      message = String(d.message)
      details = Array.isArray(d.errors) ? d.errors.map(String) : []
    } else if (Array.isArray(d)) {
      message = 'The request was not valid.'
      details = d.map((e: { loc?: unknown[]; msg?: string }) => `${(e.loc ?? []).join(' > ')}: ${e.msg}`)
    }
  } catch {
    /* non-JSON error body */
  }
  throw new ApiError(res.status, message, details)
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: {} }
  if (body instanceof FormData) init.body = body
  else if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers = { 'Content-Type': 'application/json' }
  }
  let res: Response
  try {
    res = await fetch(path, init)
  } catch {
    throw new ApiError(0, 'Cannot reach the GaugeLab API. Is it running? (gaugelab serve, port 8040)')
  }
  if (!res.ok) return parse(res)
  const type = res.headers.get('content-type') ?? ''
  return (type.includes('json') ? res.json() : res.text()) as Promise<T>
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  del: <T>(path: string) => request<T>('DELETE', path),
  upload: <T>(path: string, form: FormData) => request<T>('POST', path, form),
}

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ''
}
