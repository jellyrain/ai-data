<script setup lang="ts">
import { ref, watch } from "vue";
import { ElInput } from "element-plus";
const props = defineProps<{ modelValue: string; label: string }>();
const emit = defineEmits<{ change: [value: string] }>();
// 标识逐字输入时可能暂时为空，失焦后才进行引用迁移和合法性校验。
const draft = ref(props.modelValue);
watch(
  () => props.modelValue,
  (value) => {
    draft.value = value;
  },
);
</script>
<template><ElInput v-model="draft" :aria-label="label" @change="emit('change', draft)" /></template>
