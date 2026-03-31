<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { SessionEventDetail, SessionEventLite } from '../types/session'

const props = defineProps<{
  event: SessionEventLite
  detail: SessionEventDetail | null
  detailLoading: boolean
  isFocused: boolean
  focusPulseToken: number
}>()

const emit = defineEmits<{
  requestDetail: [eventId: string]
}>()

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value))
}

function speakerLabel(category: SessionEventLite['category']): string {
  if (category === 'user') return 'User'
  if (category === 'assistant') return 'Assistant'
  if (category === 'tool') return 'Tool'
  if (category === 'metrics') return 'Metrics'
  if (category === 'lifecycle') return 'Lifecycle'
  if (category === 'context') return 'Context'
  if (category === 'reasoning') return 'Reasoning'
  if (category === 'system') return 'System'
  return 'Event'
}

function avatarText(category: SessionEventLite['category']): string {
  if (category === 'user') return 'U'
  if (category === 'assistant') return 'A'
  if (category === 'tool') return 'T'
  return 'I'
}

function bodyClass(category: SessionEventLite['category']): string {
  return `chat-message--${category}`
}

const isBubble = computed(() => {
  return props.event.category === 'user' || props.event.category === 'assistant'
})
const isFlashing = ref(false)

let flashResetTimer: ReturnType<typeof setTimeout> | null = null

function handleToggle(nextOpen: boolean): void {
  if (nextOpen && !props.detail && !props.detailLoading) {
    emit('requestDetail', props.event.id)
  }
}

watch(
  () => [props.isFocused, props.focusPulseToken] as const,
  async ([isFocusedNow, pulseToken], [, previousPulseToken]) => {
    if (!isFocusedNow || pulseToken === 0 || pulseToken === previousPulseToken) {
      return
    }

    if (flashResetTimer) {
      clearTimeout(flashResetTimer)
    }

    // Reset once before replaying so repeated jumps to the same message still animate.
    isFlashing.value = false
    await Promise.resolve()
    isFlashing.value = true
    flashResetTimer = setTimeout(() => {
      isFlashing.value = false
      flashResetTimer = null
    }, 1400)
  },
)

onBeforeUnmount(() => {
  if (flashResetTimer) {
    clearTimeout(flashResetTimer)
  }
})
</script>

<template>
  <article
    class="chat-row"
    :class="{
      'chat-row--user': event.category === 'user',
      'chat-row--assistant': event.category === 'assistant',
      'chat-row--meta': !isBubble,
    }"
  >
    <template v-if="isBubble">
      <div
        class="chat-avatar"
        :class="bodyClass(event.category)"
      >
        {{ avatarText(event.category) }}
      </div>

      <div
        class="chat-message"
        :class="[
          bodyClass(event.category),
          {
            'chat-message--focused': isFocused,
            'chat-message--flash': isFlashing,
          },
        ]"
      >
        <div class="chat-message__meta">
          <span>{{ speakerLabel(event.category) }}</span>
          <time>{{ formatTime(event.timestamp) }}</time>
        </div>
        <p class="chat-message__title">{{ event.title }}</p>
        <pre class="chat-message__body">{{ event.bodyPreview }}</pre>
        <details
          class="chat-message__details"
          @toggle="handleToggle(($event.target as HTMLDetailsElement).open)"
        >
          <summary>查看完整内容</summary>
          <p
            v-if="detailLoading"
            class="chat-message__loading"
          >
            正在加载详情…
          </p>
          <template v-else-if="detail">
            <pre>{{ detail.bodyText }}</pre>
            <pre>{{ detail.rawText }}</pre>
          </template>
        </details>
      </div>
    </template>

    <template v-else>
      <details
        class="chat-inline-card chat-inline-card--compact"
        :class="{
          'chat-inline-card--focused': isFocused,
          'chat-inline-card--flash': isFlashing,
        }"
        @toggle="handleToggle(($event.target as HTMLDetailsElement).open)"
      >
        <summary class="chat-inline-card__summary">
          <span class="chat-inline-card__dot" />
          <span class="chat-inline-card__speaker">{{ speakerLabel(event.category) }}</span>
          <span class="chat-inline-card__title">{{ event.title }}</span>
          <span class="chat-inline-card__time">{{ formatTime(event.timestamp) }}</span>
        </summary>

        <div class="chat-inline-card__content">
          <pre class="chat-inline-card__body">{{ event.bodyPreview }}</pre>
          <p
            v-if="detailLoading"
            class="chat-message__loading"
          >
            正在加载详情…
          </p>
          <template v-else-if="detail">
            <pre>{{ detail.bodyText }}</pre>
            <pre>{{ detail.rawText }}</pre>
          </template>
        </div>
      </details>
    </template>
  </article>
</template>
