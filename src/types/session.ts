export type EventCategory =
  | 'user'
  | 'assistant'
  | 'tool'
  | 'metrics'
  | 'lifecycle'
  | 'context'
  | 'system'
  | 'reasoning'
  | 'other'

export interface ParseIssue {
  line: number
  message: string
}

export interface SessionSummary {
  fileName: string
  sessionId: string | null
  cwd: string | null
  model: string | null
  cliVersion: string | null
  source: string | null
  startedAt: string | null
  endedAt: string | null
  durationMs: number
  totalRecords: number
  totalTurns: number
  totalToolCalls: number
  totalTokens: number | null
  totalInputTokens: number | null
  totalOutputTokens: number | null
  parseIssueCount: number
}

export interface SessionEventLite {
  id: string
  index: number
  line: number
  timestamp: string
  recordType: string
  payloadType: string | null
  category: EventCategory
  role: string | null
  turnId: string | null
  callId: string | null
  title: string
  summary: string
  statusLabel: string | null
  bodyText: string
  bodyPreview: string
  hiddenByDefault: boolean
}

export interface SessionIndex {
  summary: SessionSummary
  issues: ParseIssue[]
  events: SessionEventLite[]
}

export interface SessionEventDetail {
  eventId: string
  bodyText: string
  rawText: string
  sections?: SessionEventDetailSection[]
}

export interface ParseProgress {
  loadedBytes: number
  totalBytes: number
  parsedLines: number
  parsedRecords: number
}

export interface SessionEventDetailSection {
  title: string
  timestamp: string
  bodyText: string
  rawText: string
}
