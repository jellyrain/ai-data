<script setup lang="ts">
import { ElForm, ElFormItem, ElInput, ElSelect, ElOption, ElButton } from "element-plus";
import type { Dataset, ManagedRole } from "@ai-data/contracts";
import type { CatalogDraft } from "../stores/catalog-draft-types";
import CatalogFields from "./catalog-fields.vue";
import QueryCapabilityEditor from "./query-capability-editor.vue";
import ParameterPolicyEditor from "./parameter-policy-editor.vue";
import PermissionBindingEditor from "./permission-binding-editor.vue";
const draft = defineModel<CatalogDraft>({ required: true });
defineProps<{ dataset: Dataset; roles: ManagedRole[]; disabled: boolean }>();
</script>
<template>
  <ElForm label-position="top" :disabled="disabled" @submit.prevent
    ><ElFormItem label="业务说明"
      ><ElInput v-model="draft.config.business_description" type="textarea" :rows="3" /></ElFormItem
    ><ElFormItem label="一行数据的业务粒度"
      ><ElInput v-model="draft.config.grain" placeholder="例如：一条住院费用明细记录"
    /></ElFormItem>
    <section class="management-section">
      <h3>唯一键</h3>
      <p class="management-help">每组字段必须共同唯一标识一行，关系基数会依据这些声明校验。</p>
      <div
        v-for="(key, index) in draft.config.unique_keys ?? []"
        :key="index"
        class="management-inline-row"
      >
        <ElSelect
          :model-value="key"
          multiple
          filterable
          :aria-label="`唯一键 ${index + 1}`"
          @update:model-value="draft.config.unique_keys![index] = $event"
          ><ElOption
            v-for="column in dataset.columns"
            :key="column.name"
            :label="column.name"
            :value="column.name" /></ElSelect
        ><ElButton @click="draft.config.unique_keys!.splice(index, 1)">移除</ElButton>
      </div>
      <ElButton @click="draft.config.unique_keys = [...(draft.config.unique_keys ?? []), []]"
        >添加唯一键</ElButton
      >
    </section>
    <CatalogFields v-model="draft.config" :dataset="dataset" :roles="roles" :disabled="disabled" />
    <details class="management-section">
      <summary>高级能力与参数策略</summary>
      <div class="catalog-advanced">
        <QueryCapabilityEditor
          v-model="draft.config.query_capabilities"
          title="业务查询能力"
          :columns="dataset.columns"
          :base="dataset.query_capabilities"
          inherit
          :disabled="disabled"
        />
        <ParameterPolicyEditor
          v-model="draft.config.query_parameter_policies"
          :dataset="dataset"
          :disabled="disabled"
        />
        <PermissionBindingEditor
          v-model="draft.config.query_permission_bindings"
          :dataset="dataset"
          :policies="draft.config.query_parameter_policies"
          :disabled="disabled"
        />
      </div></details
  ></ElForm>
</template>
<style scoped>
.catalog-advanced {
  margin-top: 24px;
  display: grid;
  gap: 28px;
}
.catalog-advanced > :not(:first-child) {
  border-top: 1px solid var(--app-border);
  padding-top: 24px;
}
</style>
