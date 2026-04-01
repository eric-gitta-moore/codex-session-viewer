import type {
  EventCategory,
  ParseIssue,
  ParseProgress,
  SessionEventDetail,
  SessionEventDetailSection,
  SessionEventLite,
  SessionIndex,
  SessionSummary,
} from '../types/session'

const PREVIEW_LIMIT = 220
const BODY_PREVIEW_LIMIT = 420
const PROGRESS_INTERVAL_MS = 60
const decoder = new TextDecoder()

interface RawRecord {
  timestamp: string
  type: string
  payload: Record<string, unknown> | null
}

interface ParseState {
  fileName: string
  totalBytes: number
  loadedBytes: number
  parsedLines: number
  totalRecords: number
  issues: ParseIssue[]
  events: SessionEventLite[]
  detailByEventId: Map<string, SessionEventDetail>
  activeTurnId: string | null
  turnIds: Set<string>
  toolCallIds: Set<string>
  pendingToolBatch: PendingToolBatch | null
  startedAt: string | null
  endedAt: string | null
  sessionId: string | null
  cwd: string | null
  model: string | null
  cliVersion: string | null
  source: string | null
  lastTokenTotals: {
    totalTokens: number | null
    inputTokens: number | null
    outputTokens: number | null
  }
}

interface PendingToolBatch {
  startLine: number
  turnId: string | null
  startedAt: string | null
  endedAt: string | null
  sections: SessionEventDetailSection[]
  toolTitles: string[]
  callIds: string[]
  invocationCount: number
}

type WorkerInboundMessage =
  | { type: 'parse'; file: File }
  | { type: 'detail'; eventId: string; requestId: number }

let currentState: ParseState | null = null
let parseGeneration = 0

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function getNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function getCommandText(value: unknown): string | null {
  if (typeof value === 'string') {
    return value
  }

  if (Array.isArray(value)) {
    const textParts = value.filter((item): item is string => typeof item === 'string')
    return textParts.length > 0 ? textParts.join(' ') : null
  }

  return null
}

function clampPreview(text: string | null, limit = PREVIEW_LIMIT): string {
  if (!text) return ''
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= limit) {
    return normalized
  }
  return `${normalized.slice(0, limit)}…`
}

function readMessageContent(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null
  }

  const textParts = content
    .map((item) => {
      if (!isObject(item)) return null
      const type = getString(item.type)
      if (type !== 'input_text' && type !== 'output_text' && type !== 'text') {
        return null
      }
      return getString(item.text)
    })
    .filter((item): item is string => Boolean(item))

  return textParts.length > 0 ? textParts.join('\n\n') : null
}

function inferCategory(record: RawRecord): EventCategory {
  const payloadType = getString(record.payload?.type ?? null)
  const role = getString(record.payload?.role ?? null)

  if (record.type === 'session_meta') return 'system'
  if (record.type === 'turn_context') return 'context'
  if (payloadType === 'user_message' || role === 'user') return 'user'
  if (payloadType === 'agent_message' || role === 'assistant') return 'assistant'
  if (
    payloadType === 'function_call' ||
    payloadType === 'custom_tool_call' ||
    payloadType === 'function_call_output' ||
    payloadType === 'custom_tool_call_output' ||
    payloadType === 'mcp_tool_call_end' ||
    payloadType === 'exec_command_end' ||
    payloadType === 'web_search_call' ||
    payloadType === 'web_search_end'
  ) {
    return 'tool'
  }
  if (payloadType === 'token_count') return 'metrics'
  if (payloadType === 'task_started' || payloadType === 'task_complete') return 'lifecycle'
  if (payloadType === 'reasoning') return 'reasoning'
  if (role === 'developer' || role === 'system') return 'system'
  return 'other'
}

function buildTitle(record: RawRecord): string {
  const payloadType = getString(record.payload?.type ?? null)
  const role = getString(record.payload?.role ?? null)

  if (record.type === 'session_meta') return 'Session 元信息'
  if (record.type === 'turn_context') return 'Turn 上下文'
  if (payloadType === 'user_message') return '用户消息'
  if (payloadType === 'agent_message') return 'Agent 消息'
  if (payloadType === 'task_started') return '任务开始'
  if (payloadType === 'task_complete') return '任务完成'
  if (payloadType === 'token_count') return 'Token 统计'
  if (payloadType === 'reasoning') return 'Reasoning'
  if (payloadType === 'function_call') {
    return `工具调用 · ${getString(record.payload?.name ?? null) ?? 'unknown'}`
  }
  if (payloadType === 'custom_tool_call') {
    return `工具调用 · ${getString(record.payload?.name ?? null) ?? 'unknown'}`
  }
  if (payloadType === 'function_call_output') return '工具输出'
  if (payloadType === 'custom_tool_call_output') return '工具输出'
  if (payloadType === 'mcp_tool_call_end') {
    const invocation = isObject(record.payload?.invocation) ? record.payload.invocation : null
    const server = getString(invocation?.server)
    const tool = getString(invocation?.tool)
    return `MCP 结果 · ${[server, tool].filter(Boolean).join('.') || 'unknown'}`
  }
  if (payloadType === 'exec_command_end') return '命令执行结果'
  if (payloadType === 'web_search_call') return 'Web Search 调用'
  if (payloadType === 'web_search_end') return 'Web Search 结果'
  if (role) return `${role} 消息`
  return record.type
}

function buildBodyText(record: RawRecord): string {
  const payload = record.payload
  const payloadType = getString(payload?.type ?? null)

  if (payloadType === 'user_message') {
    return getString(payload?.message ?? null) ?? ''
  }

  if (payloadType === 'agent_message') {
    return getString(payload?.message ?? null) ?? ''
  }

  if (payloadType === 'task_complete') {
    return getString(payload?.last_agent_message ?? null) ?? ''
  }

  if (payloadType === 'message') {
    return readMessageContent(payload?.content) ?? ''
  }

  if (payloadType === 'function_call') {
    const name = getString(payload?.name ?? null) ?? 'unknown'
    const argumentsText = getString(payload?.arguments ?? null) ?? '{}'
    return `调用工具: ${name}\n\n参数:\n${argumentsText}`
  }

  if (payloadType === 'custom_tool_call') {
    const name = getString(payload?.name ?? null) ?? 'unknown'
    const inputText = getString(payload?.input ?? null) ?? '{}'
    return `调用工具: ${name}\n\n参数:\n${inputText}`
  }

  if (payloadType === 'function_call_output') {
    return getString(payload?.output ?? null) ?? ''
  }

  if (payloadType === 'custom_tool_call_output') {
    return getString(payload?.output ?? null) ?? ''
  }

  if (payloadType === 'exec_command_end') {
    const command = getCommandText(payload?.command ?? null) ?? 'unknown'
    const exitCode = getNumber(payload?.exit_code)
    const output =
      getString(payload?.aggregated_output ?? null) ??
      getString(payload?.formatted_output ?? null) ??
      getString(payload?.stdout ?? null) ??
      ''

    return [`命令: ${command}`, `退出码: ${exitCode ?? 'unknown'}`, '', output].join('\n')
  }

  if (payloadType === 'mcp_tool_call_end') {
    const invocation = isObject(payload?.invocation) ? payload.invocation : null
    const server = getString(invocation?.server)
    const tool = getString(invocation?.tool)
    return [
      `MCP: ${[server, tool].filter(Boolean).join('.') || 'unknown'}`,
      '',
      typeof payload?.result === 'undefined' ? '无结果' : JSON.stringify(payload.result, null, 2),
    ].join('\n')
  }

  if (payloadType === 'web_search_end') {
    return `Web Search 查询:\n${getString(payload?.query ?? null) ?? 'unknown'}`
  }

  if (payloadType === 'token_count') {
    const info = isObject(payload?.info) ? payload.info : null
    const total = isObject(info?.total_token_usage) ? info.total_token_usage : null
    const last = isObject(info?.last_token_usage) ? info.last_token_usage : null

    return [
      `累计 tokens: ${getNumber(total?.total_tokens) ?? 0}`,
      `输入: ${getNumber(total?.input_tokens) ?? 0}`,
      `输出: ${getNumber(total?.output_tokens) ?? 0}`,
      `推理: ${getNumber(total?.reasoning_output_tokens) ?? 0}`,
      `最近一次增量: ${getNumber(last?.total_tokens) ?? 0}`,
    ].join('\n')
  }

  if (payloadType === 'reasoning') {
    if (Array.isArray(payload?.summary)) {
      return payload.summary.map((item) => String(item)).join('\n')
    }
    return '该节点只有加密后的 reasoning 内容，前端不直接展示明文。'
  }

  return clampPreview(JSON.stringify(payload))
}

function buildSummary(record: RawRecord): string {
  const payloadType = getString(record.payload?.type ?? null)

  if (record.type === 'session_meta') {
    return clampPreview(
      `session=${getString(record.payload?.id ?? null) ?? 'unknown'} cli=${getString(record.payload?.cli_version ?? null) ?? 'unknown'}`,
    )
  }

  if (record.type === 'turn_context') {
    return clampPreview(`model=${getString(record.payload?.model ?? null) ?? 'unknown'}`)
  }

  if (payloadType === 'token_count') {
    const info = isObject(record.payload?.info) ? record.payload.info : null
    const total = isObject(info?.total_token_usage) ? info.total_token_usage : null
    return clampPreview(`累计 ${getNumber(total?.total_tokens) ?? 0} tokens`)
  }

  return clampPreview(buildBodyText(record))
}

function getDurationMsBetween(startedAt: string | null, endedAt: string | null): number | null {
  if (!startedAt || !endedAt) return null

  const startedMs = Date.parse(startedAt)
  const endedMs = Date.parse(endedAt)
  if (Number.isNaN(startedMs) || Number.isNaN(endedMs)) {
    return null
  }

  return Math.max(endedMs - startedMs, 0)
}

function formatCompactDuration(durationMs: number | null): string {
  if (durationMs === null) {
    return '片刻'
  }

  if (durationMs < 1_000) {
    return '<1s'
  }

  const totalSeconds = Math.floor(durationMs / 1_000)
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  const parts: string[] = []

  if (hours > 0) {
    parts.push(`${hours}h`)
  }

  if (minutes > 0) {
    parts.push(`${minutes}m`)
  }

  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds}s`)
  }

  return parts.join(' ')
}

function formatToolInvocationCount(invocationCount: number): string {
  return `${invocationCount} 次工具调用`
}

function formatCompactToolInvocationCount(invocationCount: number): string {
  return `${invocationCount} 次`
}

function buildToolStatusLabel(
  durationMs: number | null,
  isComplete: boolean,
  invocationCount: number,
): string {
  const countLabel = `（${formatToolInvocationCount(invocationCount)}）`
  if (!isComplete) {
    return `工具调用中 ${countLabel}`
  }

  return `已处理 ${formatCompactDuration(durationMs)} ${countLabel}`
}

function isToolInvocationRecord(record: RawRecord): boolean {
  const payloadType = getString(record.payload?.type ?? null)

  return (
    payloadType === 'function_call' ||
    payloadType === 'custom_tool_call' ||
    payloadType === 'web_search_call' ||
    payloadType === 'mcp_tool_call_end' ||
    payloadType === 'exec_command_end' ||
    payloadType === 'web_search_end'
  )
}

function formatRawDetailSection(title: string, rawLine: string): string {
  try {
    const parsed = JSON.parse(rawLine)
    return `${title}\n${JSON.stringify(parsed, null, 2)}`
  } catch {
    return `${title}\n${rawLine}`
  }
}

function formatRawEvent(rawLine: string): string {
  try {
    return JSON.stringify(JSON.parse(rawLine), null, 2)
  } catch {
    return rawLine
  }
}

function createToolBatchDetailSection(
  record: RawRecord,
  rawLine: string,
): SessionEventDetailSection {
  const bodyText = buildBodyText(record)

  return {
    title: buildTitle(record),
    timestamp: record.timestamp || '',
    bodyText,
    rawText: formatRawEvent(rawLine),
  }
}

function shouldInlineFullBody(category: EventCategory): boolean {
  return category === 'user' || category === 'assistant'
}

function shouldHideByDefault(record: RawRecord, category: EventCategory): boolean {
  const payloadType = getString(record.payload?.type ?? null)
  const role = getString(record.payload?.role ?? null)

  if (
    category === 'context' ||
    category === 'reasoning' ||
    category === 'system' ||
    category === 'metrics' ||
    category === 'lifecycle'
  ) {
    return true
  }

  if (payloadType === 'function_call_output' || payloadType === 'web_search_call') {
    return true
  }

  if (payloadType === 'message' && role === 'user') {
    return true
  }

  return role === 'developer' || role === 'system'
}

function createInitialState(file: File): ParseState {
  return {
    fileName: file.name,
    totalBytes: file.size,
    loadedBytes: 0,
    parsedLines: 0,
    totalRecords: 0,
    issues: [],
    events: [],
    detailByEventId: new Map<string, SessionEventDetail>(),
    activeTurnId: null,
    turnIds: new Set<string>(),
    toolCallIds: new Set<string>(),
    pendingToolBatch: null,
    startedAt: null,
    endedAt: null,
    sessionId: null,
    cwd: null,
    model: null,
    cliVersion: null,
    source: null,
    lastTokenTotals: {
      totalTokens: null,
      inputTokens: null,
      outputTokens: null,
    },
  }
}

function pushEvent(
  state: ParseState,
  event: Omit<SessionEventLite, 'id' | 'index'>,
  detail: SessionEventDetail,
): void {
  const eventId = `event-${state.events.length}`

  state.events.push({
    id: eventId,
    index: state.events.length,
    ...event,
  })
  state.detailByEventId.set(eventId, {
    ...detail,
    eventId,
  })
}

function createToolBatch(
  record: RawRecord,
  rawLine: string,
  lineNumber: number,
  turnId: string | null,
): PendingToolBatch {
  const callId = getString(record.payload?.call_id ?? null)

  return {
    startLine: lineNumber,
    turnId,
    startedAt: record.timestamp || null,
    endedAt: record.timestamp || null,
    sections: [createToolBatchDetailSection(record, rawLine)],
    toolTitles: [buildTitle(record)],
    callIds: callId ? [callId] : [],
    invocationCount: isToolInvocationRecord(record) ? 1 : 0,
  }
}

function appendToolBatchRecord(pending: PendingToolBatch, record: RawRecord, rawLine: string): void {
  if (record.timestamp) {
    pending.startedAt = pending.startedAt ?? record.timestamp
    pending.endedAt = record.timestamp
  }

  pending.sections.push(createToolBatchDetailSection(record, rawLine))

  const title = buildTitle(record)
  if (!pending.toolTitles.includes(title)) {
    pending.toolTitles.push(title)
  }

  const callId = getString(record.payload?.call_id ?? null)
  if (callId && !pending.callIds.includes(callId)) {
    pending.callIds.push(callId)
  }

  if (isToolInvocationRecord(record) && !callId) {
    pending.invocationCount += 1
  } else if (callId && pending.callIds.includes(callId) && isToolInvocationRecord(record)) {
    pending.invocationCount = pending.callIds.length
  }
}

function buildToolBatchTitle(pending: PendingToolBatch): string {
  if (pending.toolTitles.length === 0) {
    return '工具调用'
  }

  if (pending.toolTitles.length === 1) {
    return pending.toolTitles[0]
  }

  return `工具调用 · ${pending.toolTitles.length} 项`
}

function buildToolBatchTagTitle(invocationCount: number): string {
  return `工具调用（${formatCompactToolInvocationCount(invocationCount)}）`
}

function flushToolBatch(state: ParseState, pending: PendingToolBatch): void {
  const invocationCount = Math.max(pending.invocationCount, pending.callIds.length, 1)
  const detailBodyText = pending.sections
    .map((section, index) => {
      return [`事件 ${index + 1} · ${section.title}`, section.bodyText].filter(Boolean).join('\n')
    })
    .join('\n\n')
  const detailRawText = pending.sections
    .map((section, index) => {
      return `事件 ${index + 1} · ${section.title}\n${section.rawText}`
    })
    .join('\n\n')
  const finishedAt = pending.endedAt ?? pending.startedAt ?? ''
  const durationMs = getDurationMsBetween(pending.startedAt, pending.endedAt)

  pushEvent(
    state,
    {
      line: pending.startLine,
      timestamp: finishedAt,
      recordType: 'tool_batch',
      payloadType: 'tool_batch',
      category: 'tool',
      role: null,
      turnId: pending.turnId,
      callId: pending.callIds[0] ?? null,
      title: buildToolBatchTitle(pending),
      // 顶部可见范围概览里，工具批次保持单条汇总即可，避免被具体工具名刷屏。
      tagTitles: [buildToolBatchTagTitle(invocationCount)],
      summary: clampPreview(detailBodyText, PREVIEW_LIMIT),
      statusLabel: buildToolStatusLabel(
        durationMs,
        true,
        invocationCount,
      ),
      bodyText: '',
      bodyPreview: clampPreview(detailBodyText, BODY_PREVIEW_LIMIT),
      hiddenByDefault: false,
    },
    {
      eventId: '',
      bodyText: detailBodyText,
      rawText: detailRawText,
      sections: pending.sections,
    },
  )
}

function flushPendingToolBatch(state: ParseState): void {
  if (!state.pendingToolBatch) {
    return
  }

  flushToolBatch(state, state.pendingToolBatch)
  state.pendingToolBatch = null
}

function createProgress(state: ParseState): ParseProgress {
  return {
    loadedBytes: state.loadedBytes,
    totalBytes: state.totalBytes,
    parsedLines: state.parsedLines,
    parsedRecords: state.totalRecords,
  }
}

function buildSessionSummary(state: ParseState): SessionSummary {
  const startedMs = state.startedAt ? Date.parse(state.startedAt) : Number.NaN
  const endedMs = state.endedAt ? Date.parse(state.endedAt) : Number.NaN

  return {
    fileName: state.fileName,
    sessionId: state.sessionId,
    cwd: state.cwd,
    model: state.model,
    cliVersion: state.cliVersion,
    source: state.source,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    durationMs:
      Number.isNaN(startedMs) || Number.isNaN(endedMs) ? 0 : Math.max(endedMs - startedMs, 0),
    totalRecords: state.totalRecords,
    totalTurns: state.turnIds.size,
    totalToolCalls: state.toolCallIds.size,
    totalTokens: state.lastTokenTotals.totalTokens,
    totalInputTokens: state.lastTokenTotals.inputTokens,
    totalOutputTokens: state.lastTokenTotals.outputTokens,
    parseIssueCount: state.issues.length,
  }
}

function processParsedRecord(
  parsed: Record<string, unknown>,
  rawLine: string,
  lineNumber: number,
  state: ParseState,
): void {
  const record: RawRecord = {
    timestamp: getString(parsed.timestamp) ?? '',
    type: getString(parsed.type) ?? 'unknown',
    payload: isObject(parsed.payload) ? parsed.payload : null,
  }

  state.totalRecords += 1
  state.startedAt = state.startedAt ?? record.timestamp
  state.endedAt = record.timestamp || state.endedAt

  if (record.type === 'session_meta') {
    state.sessionId = getString(record.payload?.id ?? null) ?? state.sessionId
    state.cwd = getString(record.payload?.cwd ?? null) ?? state.cwd
    state.cliVersion = getString(record.payload?.cli_version ?? null) ?? state.cliVersion
    state.source = getString(record.payload?.source ?? null) ?? state.source
  }

  if (record.type === 'turn_context') {
    state.model = getString(record.payload?.model ?? null) ?? state.model
    state.cwd = getString(record.payload?.cwd ?? null) ?? state.cwd
  }

  const directTurnId = getString(record.payload?.turn_id ?? null)
  if (directTurnId) {
    state.activeTurnId = directTurnId
    state.turnIds.add(directTurnId)
  }

  const callId = getString(record.payload?.call_id ?? null)
  if (callId) {
    state.toolCallIds.add(callId)
  }

  const payloadType = getString(record.payload?.type ?? null)
  if (payloadType === 'token_count') {
    const info = isObject(record.payload?.info) ? record.payload.info : null
    const total = isObject(info?.total_token_usage) ? info.total_token_usage : null
    state.lastTokenTotals = {
      totalTokens: getNumber(total?.total_tokens),
      inputTokens: getNumber(total?.input_tokens),
      outputTokens: getNumber(total?.output_tokens),
    }
  }

  const category = inferCategory(record)
  const bodyText = buildBodyText(record)
  const resolvedTurnId = directTurnId ?? state.activeTurnId

  if (state.pendingToolBatch && category !== 'tool' && !shouldHideByDefault(record, category)) {
    flushPendingToolBatch(state)
  }

  // 把连续工具活动折叠成一条主消息流记录，避免多个 tool event 把对话切碎。
  if (category === 'tool') {
    if (!state.pendingToolBatch) {
      state.pendingToolBatch = createToolBatch(record, rawLine, lineNumber, resolvedTurnId)
    } else {
      appendToolBatchRecord(state.pendingToolBatch, record, rawLine)
    }
    return
  }

  pushEvent(
    state,
    {
      line: lineNumber,
      timestamp: record.timestamp,
      recordType: record.type,
      payloadType,
      category,
      role: getString(record.payload?.role ?? null),
      turnId: resolvedTurnId,
      callId,
      title: buildTitle(record),
      tagTitles: [buildTitle(record)],
      summary: buildSummary(record),
      statusLabel: null,
      // 主消息流里的用户和助手气泡默认直接展示完整正文，工具与调试节点仍保持摘要模式。
      bodyText: shouldInlineFullBody(category) ? bodyText : '',
      bodyPreview: clampPreview(bodyText, BODY_PREVIEW_LIMIT),
      hiddenByDefault: shouldHideByDefault(record, category),
    },
    {
      eventId: '',
      bodyText,
      rawText: formatRawDetailSection('原始事件', rawLine),
    },
  )
}

function processLine(rawLine: string, lineNumber: number, state: ParseState): void {
  state.parsedLines = lineNumber

  if (!rawLine.trim()) {
    return
  }

  try {
    const parsed = JSON.parse(rawLine)

    if (!isObject(parsed)) {
      state.issues.push({
        line: lineNumber,
        message: '这一行不是合法的对象 JSON',
      })
      return
    }

    processParsedRecord(parsed, rawLine, lineNumber, state)
  } catch (error) {
    state.issues.push({
      line: lineNumber,
      message: error instanceof Error ? error.message : '未知解析错误',
    })
  }
}

async function parseFile(file: File, generation: number): Promise<void> {
  const state = createInitialState(file)
  currentState = state

  const reader = file.stream().getReader()
  let buffer = ''
  let lineNumber = 0
  let lastProgressSentAt = 0

  async function emitProgressIfNeeded(force = false): Promise<void> {
    const now = performance.now()
    if (!force && now - lastProgressSentAt < PROGRESS_INTERVAL_MS) {
      return
    }

    lastProgressSentAt = now
    self.postMessage({
      type: 'parse-progress',
      progress: createProgress(state),
    })

    // 给主线程一个渲染进度条的机会，避免大文件解析时只在结束瞬间看到结果。
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  while (true) {
    if (generation !== parseGeneration) {
      return
    }

    const { value, done } = await reader.read()
    if (done) {
      break
    }

    state.loadedBytes += value.byteLength
    buffer += decoder.decode(value, { stream: true })

    const lastNewlineIndex = buffer.lastIndexOf('\n')
    if (lastNewlineIndex === -1) {
      continue
    }

    const chunkText = buffer.slice(0, lastNewlineIndex)
    buffer = buffer.slice(lastNewlineIndex + 1)

    const lines = chunkText.split('\n')
    for (const line of lines) {
      lineNumber += 1
      processLine(line.replace(/\r$/, ''), lineNumber, state)
    }

    await emitProgressIfNeeded()
  }

  buffer += decoder.decode()
  if (buffer.length > 0) {
    lineNumber += 1
    processLine(buffer.replace(/\r$/, ''), lineNumber, state)
  }

  if (generation !== parseGeneration) {
    return
  }

  flushPendingToolBatch(state)

  const session: SessionIndex = {
    summary: buildSessionSummary(state),
    issues: state.issues,
    events: state.events,
  }

  await emitProgressIfNeeded(true)
  self.postMessage({
    type: 'parse-complete',
    session,
  })
}

function loadDetail(eventId: string): SessionEventDetail {
  const detail = currentState?.detailByEventId.get(eventId)
  if (!detail) {
    throw new Error('找不到对应事件的原始内容')
  }
  return detail
}

self.addEventListener('message', async (event: MessageEvent<WorkerInboundMessage>) => {
  const message = event.data

  if (message.type === 'parse') {
    parseGeneration += 1

    try {
      await parseFile(message.file, parseGeneration)
    } catch (error) {
      self.postMessage({
        type: 'parse-error',
        message: error instanceof Error ? error.message : '解析文件时发生未知错误',
      })
    }
    return
  }

  try {
    const detail = loadDetail(message.eventId)
    self.postMessage({
      type: 'detail-loaded',
      requestId: message.requestId,
      detail,
    })
  } catch (error) {
    self.postMessage({
      type: 'detail-error',
      requestId: message.requestId,
      message: error instanceof Error ? error.message : '加载详情失败',
    })
  }
})
