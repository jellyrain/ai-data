<script setup lang="ts">
import { ref } from "vue";
import { ElPopover, ElButton } from "element-plus";
import { Palette, Sun, Moon, Monitor } from "lucide-vue-next";
import { useServices } from "../../app/services";
import { palettes } from "../theme/theme";
const { theme } = useServices();
const open = ref(false);
const panel = ref<HTMLElement>();
const trigger = ref<InstanceType<typeof ElButton>>();
function focusOptions() {
  panel.value?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus();
}
function close() {
  open.value = false;
  trigger.value?.$el.focus();
}
const modes = [
  { id: "light", name: "亮色", icon: Sun },
  { id: "dark", name: "暗色", icon: Moon },
  { id: "system", name: "跟随系统", icon: Monitor },
] as const;
</script>
<template>
  <ElPopover
    v-model:visible="open"
    trigger="click"
    :width="288"
    placement="bottom-end"
    @after-enter="focusOptions"
  >
    <template #reference
      ><ElButton
        ref="trigger"
        class="appearance-trigger"
        aria-label="外观设置"
        :aria-expanded="open"
        @keydown.esc="close"
        ><Palette :size="17" aria-hidden="true" /><span>外观</span></ElButton
      ></template
    >
    <section ref="panel" class="appearance-panel" aria-label="外观设置" @keydown.esc.stop="close">
      <h2>外观</h2>
      <p>选择适合你的工作界面</p>
      <fieldset>
        <legend>显示模式</legend>
        <div class="mode-options">
          <button
            v-for="mode in modes"
            :key="mode.id"
            type="button"
            :aria-pressed="theme.state.mode === mode.id"
            @click="theme.set({ ...theme.state, mode: mode.id })"
          >
            <component :is="mode.icon" :size="18" aria-hidden="true" />{{ mode.name }}
          </button>
        </div>
      </fieldset>
      <fieldset>
        <legend>主题色</legend>
        <div class="palette-options">
          <button
            v-for="palette in palettes"
            :key="palette.id"
            type="button"
            :aria-label="palette.name"
            :aria-pressed="theme.state.palette === palette.id"
            @click="theme.set({ ...theme.state, palette: palette.id })"
          >
            <span :style="{ backgroundColor: palette.swatch }" aria-hidden="true"></span
            >{{ palette.name }}
          </button>
        </div>
      </fieldset>
      <p class="appearance-note">自动保存到当前浏览器</p>
    </section>
  </ElPopover>
</template>
