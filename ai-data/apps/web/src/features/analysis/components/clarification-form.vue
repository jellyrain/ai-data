<script setup lang="ts">
import { ref } from "vue";
import { ElButton, ElInput } from "element-plus";
import type { Clarification } from "@ai-data/contracts";
defineProps<{ question: Clarification; loading: boolean }>();
defineEmits<{ answer: [value: { option_id?: string; custom_input?: string }] }>();
const custom = ref("");
</script>
<template>
  <section class="clarification-panel" aria-label="待回答问题">
    <h3>{{ question.preference_confirmation_id ? "确认偏好" : "补充分析条件" }}</h3>
    <p>{{ question.question }}</p>
    <div class="clarification-options">
      <ElButton
        v-for="option in question.options"
        :key="option.id"
        :disabled="loading"
        @click="$emit('answer', { option_id: option.id })"
        >{{ option.label }}</ElButton
      >
    </div>
    <form
      v-if="question.allow_custom_input"
      class="custom-answer"
      @submit.prevent="$emit('answer', { custom_input: custom })"
    >
      <ElInput
        v-model="custom"
        aria-label="自定义回答"
        placeholder="也可以补充你的要求"
        :maxlength="8000"
        :disabled="loading"
      /><ElButton native-type="submit" :loading="loading" :disabled="!custom.trim()"
        >提交补充</ElButton
      >
    </form>
  </section>
</template>
