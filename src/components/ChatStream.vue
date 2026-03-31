<script setup lang="ts">
import { useVirtualizer } from '@tanstack/vue-virtual'
import { computed, ref, shallowRef, watch } from 'vue'
import type { SessionEventDetail, SessionEventLite } from '../types/session'
import ChatMessageRow from './ChatMessageRow.vue'

const props = defineProps<{
  events: SessionEventLite[]
  loadDetail: (eventId: string) => Promise<SessionEventDetail>
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

function getVirtualItemDomKey(virtualItem: { key: string | number | bigint }) {
  // Vue's DOM key type excludes bigint, so normalize virtualizer keys before rendering.
  return typeof virtualItem.key === 'bigint' ? virtualItem.key.toString() : virtualItem.key
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
          @request-detail="handleRequestDetail"
        />
      </div>
    </div>
  </section>
</template>
