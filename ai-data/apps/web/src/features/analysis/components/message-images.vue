<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { ElButton, ElImage } from "element-plus";
import type { ImageAttachment } from "@ai-data/contracts";
import { useServices } from "../../../app/services";

const props = defineProps<{ images: ImageAttachment[] }>();
const { request, resources } = useServices();
const entries = ref<{ image: ImageAttachment; url: string; error: string }[]>([]);
let controller = new AbortController();
function clear() {
  controller.abort();
  for (const entry of entries.value) if (entry.url) URL.revokeObjectURL(entry.url);
  entries.value = [];
}
async function load(index: number) {
  const entry = entries.value[index],
    signal = controller.signal;
  if (!entry) return;
  entry.error = "";
  try {
    const blob = await request(`/api/attachments/${entry.image.attachment_id}`, {
      responseType: "blob",
      signal,
    });
    if (signal.aborted) return;
    if (!(blob instanceof Blob)) throw new Error("图片响应无效");
    entry.url = URL.createObjectURL(blob);
  } catch (error) {
    if (!signal.aborted) entry.error = error instanceof Error ? error.message : "图片读取失败";
  }
}
watch(
  () => props.images,
  (images) => {
    clear();
    controller = new AbortController();
    entries.value = images.map((image) => ({ image, url: "", error: "" }));
    for (let index = 0; index < images.length; index++) void load(index);
  },
  { immediate: true },
);
const unregister = resources.register(clear);
onBeforeUnmount(() => {
  clear();
  unregister();
});
</script>
<template>
  <div class="message-images" aria-label="消息图片">
    <figure
      v-for="(entry, index) in entries"
      :key="entry.image.attachment_id"
      class="message-image"
    >
      <ElImage
        v-if="entry.url"
        :src="entry.url"
        :alt="entry.image.name"
        :preview-src-list="entries.filter((item) => item.url).map((item) => item.url)"
        :initial-index="entries.filter((item) => item.url).indexOf(entry)"
        fit="contain"
        preview-teleported
        tabindex="0"
        @keydown.enter="($event.currentTarget as HTMLElement).click()"
      />
      <div v-else class="image-placeholder" role="status">
        <template v-if="entry.error"
          ><span>{{ entry.error }}</span
          ><ElButton text @click="load(index)">重新读取图片</ElButton></template
        >
        <span v-else>正在读取图片…</span>
      </div>
      <figcaption :title="entry.image.name">{{ entry.image.name }}</figcaption>
    </figure>
  </div>
</template>
