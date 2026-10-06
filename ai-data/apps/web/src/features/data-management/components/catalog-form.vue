<script setup lang="ts">
import { ElForm, ElFormItem, ElInput, ElSelect, ElOption, ElButton } from "element-plus";
import type { Dataset, ManagedRole } from "@ai-data/contracts";
import type { CatalogDraft } from "../stores/catalog-draft-types";
import CatalogFields from "./catalog-fields.vue";
import JsonField from "../../../shared/management/json-field.vue";
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
      <JsonField
        v-model="draft.capabilities"
        label="业务查询能力"
        hint="留空表示继承 DAS 能力。可填写 sortable_fields、groupable_fields、filter_conditions、aggregations；空数组明确禁用对应能力。"
        :disabled="disabled"
      /><JsonField
        v-model="draft.parameters"
        label="参数策略"
        hint='留空继承。示例：[{"name":"department_id","allowed_ops":["eq"],"required":true}]，按实际参数定义填写。'
        :disabled="disabled"
      /><JsonField
        v-model="draft.bindings"
        label="已验收的权限参数绑定"
        hint='示例：[{"field":"department_id","parameter":"department_id","operator":"eq"}]。仅在数据源已保证输出字段与参数精确对应时配置。'
        :disabled="disabled"
      />
      <h4>当前源能力和参数</h4>
      <pre class="management-code">{{
        JSON.stringify(
          {
            query_capabilities: dataset.query_capabilities,
            query_parameters: dataset.query_parameters,
          },
          null,
          2,
        )
      }}</pre>
    </details></ElForm
  >
</template>
