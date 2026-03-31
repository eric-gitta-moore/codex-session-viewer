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

const session = shallowRef<SessionIndex | null>(null)
const loading = ref(false)
const errorMessage = ref<string | null>(null)
const parseProgress = shallowRef<ParseProgress | null>(null)
const searchInput = ref('')
const searchKeyword = ref('')
const focusedEventId = ref<string | null>(null)
const focusedEventPulse = ref(0)
const showVerbose = ref(false)
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

const displayEvents = computed<SessionEventLite[]>(() => {
  if (!session.value) return []

  const filtered = session.value.events.filter((event) => {
    if (!showVerbose.value && event.hiddenByDefault) {
      return false
    }
    return true
  })

  return filtered.filter((event, index) => {
    const previous = filtered[index - 1]
    if (!previous) return true

    return !(
      previous.category === event.category &&
      previous.turnId === event.turnId &&
      previous.summary === event.summary
    )
  })
})

function getSearchableText(event: SessionEventLite): string {
  // Search operates on the lightweight event fields so we can avoid loading full message details.
  return `${event.title}\n${event.summary}\n${event.bodyPreview}`.toLowerCase()
}

function buildSearchExcerpt(event: SessionEventLite): string {
  const excerptSource = event.summary || event.bodyPreview || event.title
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

const headlineStats = computed(() => {
  if (!session.value) return []

  return [
    `模型 ${session.value.summary.model ?? '未知'}`,
    `${session.value.summary.totalTurns} 个 turn`,
    `${session.value.summary.totalToolCalls} 次工具调用`,
    `${session.value.summary.totalTokens?.toLocaleString('zh-CN') ?? '未知'} tokens`,
    formatDuration(session.value.summary.durationMs),
  ]
})

const feedStats = computed(() => {
  if (!session.value) return []

  return [
    {
      label: '文件',
      value: session.value.summary.fileName,
    },
    {
      label: '工作目录',
      value: session.value.summary.cwd ?? '未知',
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
            v-for="stat in feedStats"
            :key="stat.label"
            class="chat-shell__meta-item"
          >
            <span>{{ stat.label }}</span>
            <strong>{{ stat.value }}</strong>
          </div>
        </div>

        <div class="chat-shell__tags">
          <span
            v-for="event in displayEvents.slice(0, 10)"
            :key="event.id"
            class="pill"
            :class="pillClass(event.category)"
          >
            {{ event.title }}
          </span>
        </div>

        <ChatStream
          ref="chatStreamRef"
          :events="displayEvents"
          :focused-event-id="focusedEventId"
          :focused-event-pulse="focusedEventPulse"
          :load-detail="loadEventDetail"
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
    </section>
  </div>
</template>
