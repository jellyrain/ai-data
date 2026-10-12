<script setup lang="ts">
import { ElButton, ElImage } from "element-plus";
import { X } from "lucide-vue-next";
import type { DraftImage } from "../stores/analysis-workspace-types";
defineProps<{ images: DraftImage[]; disabled: boolean }>();
defineEmits<{ remove: [id: string] }>();
</script>
<template>
  <div v-if="images.length" class="draft-images" aria-label="待发送图片">
    <figure v-for="(image, index) in images" :key="image.id" class="draft-image">
      <ElImage
        :src="image.preview"
        :alt="image.file.name"
        :preview-src-list="images.map((item) => item.preview)"
        :initial-index="index"
        fit="cover"
        preview-teleported
        tabindex="0"
        @keydown.enter="($event.currentTarget as HTMLElement).click()"
      />
      <ElButton
        class="remove-image"
        circle
        size="small"
        :aria-label="`移除图片 ${image.file.name}`"
        :disabled="disabled"
        @click="$emit('remove', image.id)"
        ><X :size="14"
      /></ElButton>
      <figcaption
        :title="image.error || image.file.name"
        :class="{ 'inline-error': image.status === 'error' }"
        role="status"
      >
        {{
          image.status === "uploading"
            ? "正在上传…"
            : image.status === "error"
              ? "上传失败，可重试发送"
              : image.status === "uploaded"
                ? "上传完成"
                : image.file.name
        }}
      </figcaption>
    </figure>
  </div>
</template>
