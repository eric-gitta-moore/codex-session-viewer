import type {
  ParseProgress,
  SessionEventDetail,
  SessionIndex,
} from '../types/session'

type ParseWorkerMessage =
  | { type: 'parse-progress'; progress: ParseProgress }
  | { type: 'parse-complete'; session: SessionIndex }
  | { type: 'parse-error'; message: string }
  | { type: 'detail-loaded'; requestId: number; detail: SessionEventDetail }
  | { type: 'detail-error'; requestId: number; message: string }

type PendingDetailRequest = {
  resolve: (detail: SessionEventDetail) => void
  reject: (reason?: unknown) => void
}

let worker: Worker | null = null
let pendingParse:
  | {
      resolve: (session: SessionIndex) => void
      reject: (reason?: unknown) => void
      onProgress?: (progress: ParseProgress) => void
    }
  | null = null
let detailRequestId = 0
const pendingDetailRequests = new Map<number, PendingDetailRequest>()

function ensureWorker(): Worker {
  if (worker) {
    return worker
  }

  worker = new Worker(new URL('../workers/sessionParser.worker.ts', import.meta.url), {
    type: 'module',
  })

  worker.addEventListener('message', (event: MessageEvent<ParseWorkerMessage>) => {
    const message = event.data

    if (message.type === 'parse-progress') {
      pendingParse?.onProgress?.(message.progress)
      return
    }

    if (message.type === 'parse-complete') {
      pendingParse?.resolve(message.session)
      pendingParse = null
      return
    }

    if (message.type === 'parse-error') {
      pendingParse?.reject(new Error(message.message))
      pendingParse = null
      return
    }

    if (message.type === 'detail-loaded') {
      const request = pendingDetailRequests.get(message.requestId)
      request?.resolve(message.detail)
      pendingDetailRequests.delete(message.requestId)
      return
    }

    if (message.type === 'detail-error') {
      const request = pendingDetailRequests.get(message.requestId)
      request?.reject(new Error(message.message))
      pendingDetailRequests.delete(message.requestId)
    }
  })

  worker.addEventListener('error', (event) => {
    pendingParse?.reject(event.error ?? new Error(event.message))
    pendingParse = null

    for (const request of pendingDetailRequests.values()) {
      request.reject(event.error ?? new Error(event.message))
    }
    pendingDetailRequests.clear()

    worker?.terminate()
    worker = null
  })

  return worker
}

function resetWorker(): Worker {
  if (worker) {
    worker.terminate()
    worker = null
  }

  pendingParse = null

  for (const request of pendingDetailRequests.values()) {
    request.reject(new Error('解析上下文已重置'))
  }
  pendingDetailRequests.clear()

  return ensureWorker()
}

export async function parseSessionFile(
  file: File,
  onProgress?: (progress: ParseProgress) => void,
): Promise<SessionIndex> {
  const nextWorker = resetWorker()

  return new Promise<SessionIndex>((resolve, reject) => {
    pendingParse = { resolve, reject, onProgress }
    nextWorker.postMessage({
      type: 'parse',
      file,
    })
  })
}

export async function loadEventDetail(eventId: string): Promise<SessionEventDetail> {
  const nextWorker = ensureWorker()

  return new Promise<SessionEventDetail>((resolve, reject) => {
    const requestId = ++detailRequestId
    pendingDetailRequests.set(requestId, { resolve, reject })
    nextWorker.postMessage({
      type: 'detail',
      eventId,
      requestId,
    })
  })
}

export function formatDuration(durationMs: number | null): string {
  if (durationMs === null || durationMs < 0) {
    return '未知耗时'
  }

  if (durationMs < 1_000) {
    return `${durationMs}ms`
  }

  if (durationMs < 60_000) {
    return `${(durationMs / 1_000).toFixed(1)}s`
  }

  return `${(durationMs / 60_000).toFixed(1)}m`
}
