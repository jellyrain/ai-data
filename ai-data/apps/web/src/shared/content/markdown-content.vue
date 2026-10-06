<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ElButton } from "element-plus";
import { renderMarkdown } from "./markdown";
import { highlightCode } from "./code-highlight";
const props = defineProps<{ text: string; streaming?: boolean }>();
const visibleText = ref(props.text);
let renderTimer: ReturnType<typeof setTimeout> | undefined;
// 输出时最多每 80ms 更新一次 Markdown，段落完成时立即采用权威正文。
watch(
  () => [props.text, props.streaming] as const,
  () => {
    if (!props.streaming) {
      clearTimeout(renderTimer);
      renderTimer = undefined;
      visibleText.value = props.text;
    } else
      renderTimer ??= setTimeout(() => {
        renderTimer = undefined;
        visibleText.value = props.text;
      }, 80);
  },
);
const root = ref<HTMLElement>();
const expanded = ref(false);
const feedback = ref("");
const display = computed(() =>
  props.streaming || expanded.value || visibleText.value.length <= 8000
    ? visibleText.value
    : `${visibleText.value.slice(0, 4000)}\n\n…`,
);
const rendered = computed(() => {
  try {
    return renderMarkdown(display.value, props.streaming);
  } catch {
    return null;
  }
});
let generation = 0;
let observer: IntersectionObserver | undefined;
let themes: MutationObserver | undefined;
const enhancements = new Map<string, Promise<string | null>>();
async function enhance() {
  const current = ++generation;
  observer?.disconnect();
  await nextTick();
  if (current !== generation || !root.value || !rendered.value) return;
  const blocks = rendered.value.blocks;
  async function visible(element: Element) {
    const diagram = element.hasAttribute("data-diagram-index");
    const index = Number(element.getAttribute(diagram ? "data-diagram-index" : "data-code-index"));
    const block = blocks[index];
    if (!block) return;
    try {
      const key = JSON.stringify([
        index,
        diagram,
        block.language,
        block.code,
        document.documentElement.className,
        document.documentElement.dataset.palette,
      ]);
      let enhancement = enhancements.get(key);
      if (!enhancement) {
        if (enhancements.size >= 32) enhancements.clear();
        enhancement = diagram
          ? import("./diagram").then((module) => module.renderDiagram(block.code))
          : highlightCode(block.code, block.language);
        enhancements.set(key, enhancement);
      }
      const html = await enhancement;
      if (current === generation && html !== null && element.isConnected) element.innerHTML = html;
    } catch {
      if (current === generation && diagram)
        element.textContent = "流程图暂时无法绘制，可查看上方原始代码";
    }
  }
  if (typeof IntersectionObserver === "undefined") return;
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries)
      if (entry.isIntersecting) {
        observer?.unobserve(entry.target);
        void visible(entry.target);
      }
  });
  root.value
    .querySelectorAll("[data-code-index], [data-diagram-index]")
    .forEach((element) => observer!.observe(element));
}
async function clicked(event: MouseEvent) {
  const button = (event.target as Element).closest<HTMLButtonElement>("button[data-copy-index]");
  if (!button || !root.value?.contains(button)) return;
  const block = rendered.value?.blocks[Number(button.dataset.copyIndex)];
  if (!block) return;
  try {
    await navigator.clipboard.writeText(block.code);
    feedback.value = "代码已复制";
  } catch {
    feedback.value = "复制失败，请选中代码手动复制";
  }
}
watch(display, () => {
  void enhance();
});
watch(
  () => props.text,
  () => {
    feedback.value = "";
  },
);
onMounted(() => {
  void enhance();
  themes = new MutationObserver(() => {
    void enhance();
  });
  themes.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-palette"],
  });
});
onBeforeUnmount(() => {
  clearTimeout(renderTimer);
  generation++;
  observer?.disconnect();
  themes?.disconnect();
  enhancements.clear();
});
</script>
<template>
  <div class="markdown-content">
    <!-- HTML 只接收关闭原始 HTML 后、经 DOMPurify 清洗的本地渲染结果。 -->
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div v-if="rendered" ref="root" class="markdown-body" @click="clicked" v-html="rendered.html" />
    <pre v-else class="plain-content">{{ display }}</pre>
    <ElButton v-if="text.length > 8000 && !streaming" text @click="expanded = !expanded">{{
      expanded ? "收起长内容" : `展开全部内容（${text.length.toLocaleString()} 字符）`
    }}</ElButton>
    <p v-if="feedback" role="status" class="muted">{{ feedback }}</p>
  </div>
</template>
