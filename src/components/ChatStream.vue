<script setup lang="ts">
import { useVirtualizer } from '@tanstack/vue-virtual'
import { computed, nextTick, ref, shallowRef, watch } from 'vue'
import type { SessionEventDetail, SessionEventLite } from '../types/session'
import ChatMessageRow from './ChatMessageRow.vue'

const props = defineProps<{
  events: SessionEventLite[]
  focusedEventId?: string | null
  focusedEventPulse?: number
  loadDetail: (eventId: string) => Promise<SessionEventDetail>
}>()

const emit = defineEmits<{
  visibleChange: [eventIds: string[]]
}>()

const scrollElement = ref<HTMLElement | null>(null)
const detailMap = shallowRef(new Map<string, SessionEventDetail>())
const loadingIds = shallowRef(new Set<string>())

const rowVirtualizer = useVirtualizer(
  computed(() => ({
    count: props.events.length,
    getScrollElement: () => scrollElement.value,
    estimateSize: () => 168,
    overscan: 10,
    getItemKey: (index: number) => props.events[index]?.id ?? index,
    measureElement: (element: Element | null) => element?.getBoundingClientRect().height ?? 168,
  })),
)

watch(
  () => props.events,
  () => {
    scrollElement.value?.scrollTo({ top: 0 })
    rowVirtualizer.value.scrollToOffset(0)
  },
)

const virtualItems = computed(() => rowVirtualizer.value.getVirtualItems())

watch(
  virtualItems,
  (items) => {
    // 把当前虚拟列表窗口里的消息 id 回传给父组件，用于同步顶部概览标签。
    const nextVisibleEventIds = items
      .map((item) => props.events[item.index]?.id ?? null)
      .filter((eventId): eventId is string => Boolean(eventId))

    emit('visibleChange', nextVisibleEventIds)
  },
  { immediate: true },
)

const eventIndexMap = computed(() => {
  const indexMap = new Map<string, number>()

  // Keep a fast lookup table so search results can jump to a message without scanning the list.
  props.events.forEach((event, index) => {
    indexMap.set(event.id, index)
  })

  return indexMap
})

function getVirtualItemDomKey(virtualItem: { key: string | number | bigint }) {
  // Vue's DOM key type excludes bigint, so normalize virtualizer keys before rendering.
  return typeof virtualItem.key === 'bigint' ? virtualItem.key.toString() : virtualItem.key
}

async function scrollToEvent(eventId: string): Promise<void> {
  const targetIndex = eventIndexMap.value.get(eventId)

  if (targetIndex === undefined) {
    return
  }

  await nextTick()
  rowVirtualizer.value.scrollToIndex(targetIndex, { align: 'center' })
}

async function handleRequestDetail(eventId: string): Promise<void> {
  if (detailMap.value.has(eventId) || loadingIds.value.has(eventId)) {
    return
  }

  const nextLoadingIds = new Set(loadingIds.value)
  nextLoadingIds.add(eventId)
  loadingIds.value = nextLoadingIds

  try {
    const detail = await props.loadDetail(eventId)
    const nextDetailMap = new Map(detailMap.value)
    nextDetailMap.set(eventId, detail)
    detailMap.value = nextDetailMap
  } finally {
    const nextLoadingIdsAfterLoad = new Set(loadingIds.value)
    nextLoadingIdsAfterLoad.delete(eventId)
    loadingIds.value = nextLoadingIdsAfterLoad
  }
}

defineExpose({
  scrollToEvent,
})
</script>

<template>
  <section
    ref="scrollElement"
    class="chat-stream"
  >
    <div
      class="chat-stream__inner"
      :style="{ height: `${rowVirtualizer.getTotalSize()}px` }"
    >
      <div
        v-for="virtualItem in virtualItems"
        :key="getVirtualItemDomKey(virtualItem)"
        :data-index="virtualItem.index"
        :ref="(element) => rowVirtualizer.measureElement(element as Element)"
        class="chat-stream__item"
        :style="{ transform: `translateY(${virtualItem.start}px)` }"
      >
        <ChatMessageRow
          :event="events[virtualItem.index]"
          :detail="detailMap.get(events[virtualItem.index].id) ?? null"
          :detail-loading="loadingIds.has(events[virtualItem.index].id)"
          :is-focused="events[virtualItem.index].id === focusedEventId"
          :focus-pulse-token="events[virtualItem.index].id === focusedEventId ? (focusedEventPulse ?? 0) : 0"
          @request-detail="handleRequestDetail"
        />
      </div>
    </div>
  </section>
</template>
