<script setup lang="ts">
import { computed, ref } from 'vue'

const props = defineProps<{
  loading: boolean
}>()

const emit = defineEmits<{
  select: [file: File]
}>()

const fileInput = ref<HTMLInputElement | null>(null)
const isDragging = ref(false)
const selectedFileName = ref('')

const statusText = computed(() => {
  if (props.loading) {
    return '正在解析文件…'
  }

  if (selectedFileName.value) {
    return selectedFileName.value
  }

  return '尚未选择文件'
})

function handleFiles(fileList: FileList | null): void {
  const file = fileList?.[0]
  if (!file) return
  selectedFileName.value = file.name
  emit('select', file)
}

function openPicker(): void {
  if (props.loading) return
  const input = fileInput.value
  if (!input) return

  // 优先使用浏览器原生的 showPicker，避免隐藏 file input 在不同内核里出现点击不稳定的问题。
  if (typeof input.showPicker === 'function') {
    input.showPicker()
    return
  }

  input.click()
}

function handleDrop(event: DragEvent): void {
  event.preventDefault()
  isDragging.value = false
  if (props.loading) return
  handleFiles(event.dataTransfer?.files ?? null)
}
</script>

<template>
  <section
    class="dropzone"
    :class="{ 'dropzone--dragging': isDragging, 'dropzone--loading': loading }"
    @click="openPicker"
    @dragenter.prevent="isDragging = true"
    @dragover.prevent="isDragging = true"
    @dragleave.prevent="isDragging = false"
    @drop="handleDrop"
  >
    <input
      ref="fileInput"
      class="dropzone__input"
      type="file"
      accept=".jsonl,application/json,text/plain"
      @change="handleFiles(($event.target as HTMLInputElement).files)"
    />

    <div class="dropzone__header">
      <p class="dropzone__eyebrow">Session File</p>
      <p class="dropzone__label">选择一个 `.jsonl` 文件</p>
    </div>

    <div class="dropzone__picker">
      <button
        class="dropzone__button"
        type="button"
        @click.stop="openPicker"
      >
        {{ loading ? '解析中' : '选择文件' }}
      </button>
      <div class="dropzone__status">
        <span class="dropzone__status-label">当前文件</span>
        <strong class="dropzone__status-value">{{ statusText }}</strong>
      </div>
    </div>

    <div class="dropzone__assist">
      <p class="dropzone__copy">支持点击选择，也支持把文件拖到这里。</p>
      <p class="dropzone__hint">仅处理单个 `jsonl` 文件，不会扫描本地目录。</p>
    </div>
  </section>
</template>
