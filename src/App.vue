<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import ChatStream from './components/ChatStream.vue'
import FileDropzone from './components/FileDropzone.vue'
import type { ParseProgress, SessionEventLite, SessionIndex } from './types/session'
import { formatDuration, loadEventDetail, parseSessionFile } from './utils/sessionParser'

type SearchResult = {
  event: SessionEventLite
  excerpt: string
}

type RoleFilterValue = 'all' | SessionEventLite['category']
type VisibleTagItem = {
  id: string
  title: string
  category: SessionEventLite['category']
}

const session = shallowRef<SessionIndex | null>(null)
const loading = ref(false)
const errorMessage = ref<string | null>(null)
const parseProgress = shallowRef<ParseProgress | null>(null)
const searchInput = ref('')
const searchKeyword = ref('')
const focusedEventId = ref<string | null>(null)
const focusedEventPulse = ref(0)
const showVerbose = ref(false)
const roleFilter = ref<RoleFilterValue>('all')
const visibleEventIds = ref<string[]>([])
const chatStreamRef = ref<{ scrollToEvent: (eventId: string) => Promise<void> } | null>(null)

let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null

watch(searchInput, (value) => {
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer)
  }

  searchDebounceTimer = setTimeout(() => {
    searchKeyword.value = value.trim().toLowerCase()
  }, 180)
})

onBeforeUnmount(() => {
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer)
  }
})

const baseVisibleEvents = computed<SessionEventLite[]>(() => {
  if (!session.value) return []

  return session.value.events.filter((event) => {
    if (!showVerbose.value && event.hiddenByDefault) {
      return false
    }
    return true
  })
})

function roleFilterLabel(category: RoleFilterValue): string {
  if (category === 'all') return '全部消息'
  if (category === 'user') return '用户'
  if (category === 'assistant') return '助手'
  if (category === 'tool') return '工具'
  if (category === 'system') return '系统'
  if (category === 'context') return '上下文'
  if (category === 'reasoning') return '推理'
  if (category === 'metrics') return '指标'
  if (category === 'lifecycle') return '生命周期'
  return '其他'
}

const roleFilterOptions = computed(() => {
  const counts = new Map<RoleFilterValue, number>()

  for (const event of baseVisibleEvents.value) {
    const nextCount = counts.get(event.category) ?? 0
    counts.set(event.category, nextCount + 1)
  }

  const priorityOrder: SessionEventLite['category'][] = [
    'user',
    'assistant',
    'tool',
    'system',
    'context',
    'reasoning',
    'metrics',
    'lifecycle',
    'other',
  ]

  const options = priorityOrder
    .filter((category) => counts.has(category))
    .map((category) => ({
      value: category,
      label: roleFilterLabel(category),
      count: counts.get(category) ?? 0,
    }))

  return [
    {
      value: 'all' as const,
      label: roleFilterLabel('all'),
      count: baseVisibleEvents.value.length,
    },
    ...options,
  ]
})

watch(roleFilterOptions, (options) => {
  if (options.some((option) => option.value === roleFilter.value)) {
    return
  }

  roleFilter.value = 'all'
})

const displayEvents = computed<SessionEventLite[]>(() => {
  const filteredByRole =
    roleFilter.value === 'all'
      ? baseVisibleEvents.value
      : baseVisibleEvents.value.filter((event) => event.category === roleFilter.value)

  return filteredByRole.filter((event, index) => {
    const previous = filteredByRole[index - 1]
    if (!previous) return true

    // 工具调用现在会聚合成单条耗时分隔线；这里不要再把相邻工具行误判成重复记录。
    if (previous.category === 'tool' || event.category === 'tool') {
      return true
    }

    return !(
      previous.category === event.category &&
      previous.turnId === event.turnId &&
      previous.summary === event.summary
    )
  })
})

function getSearchableText(event: SessionEventLite): string {
  // 搜索只依赖主线程已有的轻量索引字段，避免为了检索再触发详情加载。
  return `${event.title}\n${event.summary}\n${event.bodyText}\n${event.bodyPreview}`.toLowerCase()
}

function buildSearchExcerpt(event: SessionEventLite): string {
  const excerptSource = event.summary || event.bodyText || event.bodyPreview || event.title
  const normalized = excerptSource.replace(/\s+/g, ' ').trim()

  return normalized.slice(0, 120)
}

const searchState = computed(() => {
  if (!searchKeyword.value) {
    return {
      total: 0,
      results: [] as SearchResult[],
    }
  }

  const results: SearchResult[] = []
  let total = 0

  // Stop collecting visible rows after a small cap, but keep counting the full match total for feedback.
  for (const event of displayEvents.value) {
    if (!getSearchableText(event).includes(searchKeyword.value)) {
      continue
    }

    total += 1

    if (results.length < 8) {
      results.push({
        event,
        excerpt: buildSearchExcerpt(event),
      })
    }
  }

  return {
    total,
    results,
  }
})

function formatStatNumber(value: number | null): string {
  return value === null ? '未知' : value.toLocaleString('zh-CN')
}

function getFreshInputTokens(summary: SessionIndex['summary']): number | null {
  if (summary.totalInputTokens === null) {
    return null
  }

  // input 里已经包含缓存命中的部分，这里额外减出来，方便看真实新增输入量。
  return Math.max(summary.totalInputTokens - (summary.totalCachedInputTokens ?? 0), 0)
}

const headlineStats = computed(() => {
  if (!session.value) return []

  return [
    `模型 ${session.value.summary.model ?? '未知'}`,
    `${session.value.summary.totalTurns} 个 turn`,
    `${session.value.summary.totalToolCalls} 次工具调用`,
    formatDuration(session.value.summary.durationMs),
  ]
})

const baseStats = computed(() => {
  if (!session.value) return []

  const summary = session.value.summary

  return [
    {
      label: '文件',
      value: summary.fileName,
    },
    {
      label: '工作目录',
      value: summary.cwd ?? '未知',
    },
    {
      label: '可见消息',
      value: String(displayEvents.value.length),
    },
    {
      label: '解析告警',
      value: String(session.value.issues.length),
    },
  ]
})

const tokenStats = computed(() => {
  if (!session.value) return []

  const summary = session.value.summary

  return [
    {
      label: '总 Token',
      value: formatStatNumber(summary.totalTokens),
    },
    {
      label: '输入 Token（含缓存）',
      value: formatStatNumber(summary.totalInputTokens),
    },
    {
      label: '输入缓存命中',
      value: formatStatNumber(summary.totalCachedInputTokens),
    },
    {
      label: '输入 Token（非缓存）',
      value: formatStatNumber(getFreshInputTokens(summary)),
    },
    {
      label: '输出 Token',
      value: formatStatNumber(summary.totalOutputTokens),
    },
    {
      label: '推理输出 Token',
      value: formatStatNumber(summary.totalReasoningOutputTokens),
    },
  ]
})

const visibleTagEvents = computed(() => {
  if (!displayEvents.value.length) {
    return []
  }

  if (!visibleEventIds.value.length) {
    return displayEvents.value.slice(0, 10)
  }

  const visibleIdSet = new Set(visibleEventIds.value)
  const visibleEvents = displayEvents.value.filter((event) => visibleIdSet.has(event.id))

  return visibleEvents.slice(0, 10)
})

const visibleTagItems = computed<VisibleTagItem[]>(() => {
  return visibleTagEvents.value
    .flatMap((event) => {
      const tagTitles = event.tagTitles.length ? event.tagTitles : [event.title]

      return tagTitles.map((title, index) => ({
        id: `${event.id}-tag-${index}`,
        title,
        category: event.category,
      }))
    })
    .slice(0, 10)
})

const progressPercent = computed(() => {
  if (!parseProgress.value?.totalBytes) return 0
  return Math.min(
    100,
    Math.round((parseProgress.value.loadedBytes / parseProgress.value.totalBytes) * 100),
  )
})

async function handleFileSelect(file: File): Promise<void> {
  loading.value = true
  errorMessage.value = null
  session.value = null
  focusedEventId.value = null
  visibleEventIds.value = []
  parseProgress.value = {
    loadedBytes: 0,
    totalBytes: file.size,
    parsedLines: 0,
    parsedRecords: 0,
  }

  try {
    session.value = await parseSessionFile(file, (progress) => {
      parseProgress.value = progress
    })
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '解析文件时发生未知错误'
  } finally {
    loading.value = false
  }
}

async function jumpToEvent(eventId: string): Promise<void> {
  focusedEventId.value = eventId
  focusedEventPulse.value += 1
  await chatStreamRef.value?.scrollToEvent(eventId)
}

async function handleSearchEnter(): Promise<void> {
  const firstMatch = searchState.value.results[0]

  if (!firstMatch) {
    return
  }

  await jumpToEvent(firstMatch.event.id)
}

function handleVisibleChange(eventIds: string[]): void {
  visibleEventIds.value = eventIds
}

function pillClass(category: SessionEventLite['category']): string {
  return `pill--${category}`
}
</script>

<template>
  <div class="shell">
    <header class="hero-panel">
      <div class="hero-panel__copy">
        <p class="hero-panel__eyebrow">Codex Session Viewer</p>
        <h1>查看单个 Session 文件</h1>
        <p class="hero-panel__lede">
          上传一个 `jsonl` 文件后，按消息流回放用户、助手和工具事件。默认隐藏调试噪音，保留主要对话过程。
        </p>

        <div
          v-if="session"
          class="hero-panel__chips"
        >
          <span
            v-for="item in headlineStats"
            :key="item"
            class="pill pill--lifecycle"
          >
            {{ item }}
          </span>
        </div>

        <div
          v-else-if="parseProgress"
          class="hero-panel__progress"
        >
          <div class="hero-panel__progress-meta">
            <span>解析进度</span>
            <strong>{{ progressPercent }}%</strong>
          </div>
          <div class="hero-panel__progress-bar">
            <div
              class="hero-panel__progress-fill"
              :style="{ width: `${progressPercent}%` }"
            />
          </div>
          <p class="hero-panel__progress-copy">
            已读取 {{ parseProgress.parsedLines.toLocaleString('zh-CN') }} 行，
            提取 {{ parseProgress.parsedRecords.toLocaleString('zh-CN') }} 条记录
          </p>
        </div>
      </div>

      <FileDropzone
        class="hero-panel__dropzone"
        :loading="loading"
        @select="handleFileSelect"
      />
    </header>

    <p
      v-if="errorMessage"
      class="error-banner"
    >
      {{ errorMessage }}
    </p>

    <template v-if="session">
      <section class="chat-shell">
        <header class="chat-shell__header">
          <div>
            <p class="chat-shell__eyebrow">Conversation Replay</p>
            <h2>像在 ChatGPT 里读一段历史对话</h2>
          </div>

          <div class="chat-shell__controls">
            <div class="toolbar__search-wrap">
              <input
                v-model="searchInput"
                class="toolbar__search"
                type="search"
                placeholder="搜索消息、工具、输出"
                @keydown.enter.prevent="handleSearchEnter"
              />

              <div
                v-if="searchKeyword"
                class="toolbar__search-results"
              >
                <div class="toolbar__search-results-head">
                  <span>检索结果</span>
                  <strong>{{ searchState.total }}</strong>
                </div>

                <p
                  v-if="!searchState.total"
                  class="toolbar__search-empty"
                >
                  没有找到匹配消息
                </p>

                <button
                  v-for="result in searchState.results"
                  :key="result.event.id"
                  class="toolbar__search-result"
                  type="button"
                  @click="jumpToEvent(result.event.id)"
                >
                  <span
                    class="pill"
                    :class="pillClass(result.event.category)"
                  >
                    {{ result.event.category }}
                  </span>
                  <span class="toolbar__search-result-copy">
                    <strong>{{ result.event.title }}</strong>
                    <small>{{ result.excerpt || '无摘要内容' }}</small>
                  </span>
                  <time>{{ new Date(result.event.timestamp).toLocaleTimeString('zh-CN') }}</time>
                </button>
              </div>
            </div>
            <label class="toolbar__select-wrap">
              <span>只看</span>
              <select
                v-model="roleFilter"
                class="toolbar__select"
              >
                <option
                  v-for="option in roleFilterOptions"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}（{{ option.count }}）
                </option>
              </select>
            </label>
            <label class="toolbar__toggle">
              <input
                v-model="showVerbose"
                type="checkbox"
              />
              显示调试节点
            </label>
          </div>
        </header>

        <div class="chat-shell__meta">
          <div
            v-for="stat in baseStats"
            :key="stat.label"
            class="chat-shell__meta-item"
          >
            <span>{{ stat.label }}</span>
            <strong>{{ stat.value }}</strong>
          </div>
        </div>

        <section class="token-panel">
          <div class="token-panel__header">
            <span class="token-panel__eyebrow">Token Stats</span>
            <strong>输入、输出与缓存命中拆分</strong>
          </div>

          <div class="token-panel__grid">
            <div
              v-for="stat in tokenStats"
              :key="stat.label"
              class="token-panel__item"
            >
              <span>{{ stat.label }}</span>
              <strong>{{ stat.value }}</strong>
            </div>
          </div>
        </section>

        <div class="chat-shell__tags">
          <span
            v-for="item in visibleTagItems"
            :key="item.id"
            class="pill"
            :class="pillClass(item.category)"
          >
            {{ item.title }}
          </span>
        </div>

        <ChatStream
          ref="chatStreamRef"
          :events="displayEvents"
          :focused-event-id="focusedEventId"
          :focused-event-pulse="focusedEventPulse"
          :load-detail="loadEventDetail"
          @visible-change="handleVisibleChange"
        />
      </section>
    </template>

    <section
      v-else
      class="empty-panel"
    >
      <p class="empty-panel__eyebrow">Overview</p>
      <h2>上传后会看到什么</h2>
      <div class="empty-panel__grid">
        <article>
          <h3>用户消息</h3>
          <p>按时间顺序展示输入内容，方便快速定位问题起点。</p>
        </article>
        <article>
          <h3>助手回复</h3>
          <p>把主要回答直接铺开，不需要先切换结构化视图。</p>
        </article>
        <article>
          <h3>工具与调试</h3>
          <p>需要时再展开查看，不会默认打断主消息流。</p>
        </article>
      </div>

      <section class="empty-panel__paths">
        <h3>去哪里找 session.jsonl</h3>
        <p>默认情况下，Codex 的 session 文件通常在下面这些目录里。如果你改过 `CODEX_HOME`，就优先去对应的 `sessions` 子目录找。</p>
        <ul>
          <li>macOS / Linux: <code>~/.codex/sessions/YYYY/MM/DD/*.jsonl</code></li>
          <li>Windows: <code>%USERPROFILE%\\.codex\\sessions\\YYYY\\MM\\DD\\*.jsonl</code></li>
          <li>自定义 CODEX_HOME: <code>$CODEX_HOME/sessions</code> 或 <code>%CODEX_HOME%\\sessions</code></li>
        </ul>
      </section>
    </section>
  </div>
</template>
