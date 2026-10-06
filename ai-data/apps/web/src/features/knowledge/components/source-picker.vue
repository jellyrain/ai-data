<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { ElSelect, ElOption, ElButton } from "element-plus";
import type { z } from "zod";
import type { MemorySource, QueryEvidence } from "@ai-data/contracts";
import {
  conversationListSchema,
  conversationDetailSchema,
  evidenceListSchema,
} from "../../analysis/api/analysis-schema";
import { useServices } from "../../../app/services";
import { ManagementScope } from "../../../shared/management/management-scope";
/** 来源选择使用当前账号的会话、消息运行及已授权证据。 */
type Conversations = z.infer<typeof conversationListSchema>["items"];
const props = defineProps<{ modelValue: MemorySource }>();
const emit = defineEmits<{ "update:modelValue": [MemorySource] }>();
const conversations = ref<Conversations>([]),
  runs = ref<string[]>([]),
  evidence = ref<QueryEvidence[]>([]);
const { request, resources } = useServices();
const scope = new ManagementScope({
  request,
  resources,
  clear: () => {
    conversations.value = [];
    runs.value = [];
    evidence.value = [];
  },
});
function load() {
  return scope.run(async (request) => {
    conversations.value = conversationListSchema.parse(await request("/api/conversations")).items;
  });
}
function conversation(id: string) {
  emit("update:modelValue", id ? { conversation_id: id, evidence_ids: [] } : { evidence_ids: [] });
  runs.value = [];
  evidence.value = [];
  if (id)
    void scope.run(async (request) => {
      const detail = conversationDetailSchema.parse(
        await request("/api/conversations/" + encodeURIComponent(id)),
      );
      runs.value = [
        ...new Set(
          detail.messages
            .map((item) => item.analysisRunId)
            .filter((value): value is string => !!value),
        ),
      ];
    });
}
function run(id: string) {
  emit("update:modelValue", {
    conversation_id: props.modelValue.conversation_id,
    ...(id ? { analysis_run_id: id } : {}),
    evidence_ids: [],
  });
  evidence.value = [];
  if (id)
    void scope.run(async (request) => {
      evidence.value = evidenceListSchema.parse(
        await request("/api/analysis-runs/" + encodeURIComponent(id) + "/evidence"),
      ).items;
    });
}
onMounted(load);
onBeforeUnmount(() => scope.dispose());
</script>
<template>
  <div class="management-form-grid">
    <label
      >来源会话（可选）<ElSelect
        :model-value="modelValue.conversation_id ?? ''"
        clearable
        filterable
        aria-label="来源会话"
        :disabled="scope.state.busy"
        @update:model-value="conversation(String($event))"
        ><ElOption
          v-for="item in conversations"
          :key="item.id"
          :value="item.id"
          :label="item.title ?? item.id" /></ElSelect></label
    ><label
      >分析运行（可选）<ElSelect
        :model-value="modelValue.analysis_run_id ?? ''"
        clearable
        aria-label="来源运行"
        :disabled="scope.state.busy"
        @update:model-value="run(String($event))"
        ><ElOption v-for="id in runs" :key="id" :value="id" :label="id" /></ElSelect></label
    ><label class="wide"
      >证据（可选）<ElSelect
        :model-value="modelValue.evidence_ids"
        multiple
        aria-label="来源证据"
        :disabled="scope.state.busy"
        @update:model-value="emit('update:modelValue', { ...modelValue, evidence_ids: $event })"
        ><ElOption
          v-for="item in evidence"
          :key="item.evidence_id"
          :value="item.evidence_id"
          :label="item.evidence_id" /></ElSelect
    ></label>
  </div>
  <p v-if="scope.state.error" class="inline-error" role="alert">
    {{ scope.state.error }}<ElButton text @click="load">重新读取来源</ElButton>
  </p>
</template>
