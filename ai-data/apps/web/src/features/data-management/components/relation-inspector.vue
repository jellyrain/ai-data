<script setup lang="ts">
import { computed } from "vue";
import { ElButton, ElForm, ElFormItem, ElInput, ElOption, ElSelect } from "element-plus";
import { X, Plus } from "lucide-vue-next";
import type { Dataset, PublishedRelationInput } from "@ai-data/contracts";
const draft = defineModel<PublishedRelationInput>({ required: true });
const sourceId = defineModel<string>("source", { required: true });
const props = defineProps<{
  datasets: Dataset[];
  existing: boolean;
  disabled: boolean;
  canDisable: boolean;
}>();
const emit = defineEmits<{ close: []; apply: []; disable: [] }>();
const source = computed(() => props.datasets.find((item) => item.object_id === sourceId.value));
const target = computed(() =>
  props.datasets.find((item) => item.object_id === draft.value.target_object_id),
);
</script>
<template>
  <aside class="relation-inspector" aria-label="关联设置">
    <header>
      <strong>关联设置</strong
      ><ElButton text aria-label="关闭关联设置" @click="emit('close')"><X :size="17" /></ElButton>
    </header>
    <ElForm label-position="top" :disabled="disabled" @submit.prevent>
      <ElFormItem label="源对象" required
        ><ElSelect
          v-model="sourceId"
          aria-label="源对象"
          filterable
          :disabled="existing"
          @change="draft.column_pairs = [{ source_column: '', target_column: '' }]"
          ><ElOption
            v-for="item in datasets"
            :key="item.object_id"
            :label="`${item.name} · ${item.object_id}`"
            :value="item.object_id" /></ElSelect
      ></ElFormItem>
      <ElFormItem label="目标对象" required
        ><ElSelect
          v-model="draft.target_object_id"
          aria-label="目标对象"
          filterable
          :disabled="existing"
          @change="draft.column_pairs.forEach((pair) => (pair.target_column = ''))"
          ><ElOption
            v-for="item in datasets"
            :key="item.object_id"
            :label="`${item.name} · ${item.object_id}`"
            :value="item.object_id" /></ElSelect
      ></ElFormItem>
      <ElFormItem label="业务说明" required
        ><ElInput
          v-model="draft.description"
          aria-label="关系业务说明"
          type="textarea"
          :rows="2"
          placeholder="例如：每条就诊记录所属的科室"
      /></ElFormItem>
      <section class="relation-field-pairs">
        <h3>字段对应</h3>
        <p class="muted">{{ source?.name ?? "源对象" }} → {{ target?.name ?? "目标对象" }}</p>
        <div v-for="(pair, index) in draft.column_pairs" :key="index" class="relation-pair">
          <ElSelect
            v-model="pair.source_column"
            filterable
            :aria-label="`源字段 ${index + 1}`"
            placeholder="源字段"
            ><ElOption
              v-for="column in source?.columns ?? []"
              :key="column.name"
              :value="column.name"
              :label="column.name" /></ElSelect
          ><span>=</span>
          <ElSelect
            v-model="pair.target_column"
            filterable
            :aria-label="`目标字段 ${index + 1}`"
            placeholder="目标字段"
            ><ElOption
              v-for="column in target?.columns ?? []"
              :key="column.name"
              :value="column.name"
              :label="column.name"
          /></ElSelect>
          <ElButton
            text
            :aria-label="`移除字段对 ${index + 1}`"
            :disabled="draft.column_pairs.length === 1"
            @click="draft.column_pairs.splice(index, 1)"
            ><X :size="14"
          /></ElButton>
        </div>
        <ElButton text @click="draft.column_pairs.push({ source_column: '', target_column: '' })"
          ><Plus :size="14" />添加字段对</ElButton
        >
      </section>
      <ElFormItem label="关系基数（可选）"
        ><ElSelect
          v-model="draft.cardinality"
          aria-label="关系基数"
          clearable
          placeholder="未声明，查询时校验"
          ><ElOption
            v-for="item in [
              { value: 'one_to_one', label: '一对一（1 : 1）' },
              { value: 'one_to_many', label: '一对多（1 : N）' },
              { value: 'many_to_one', label: '多对一（N : 1）' },
              { value: 'many_to_many', label: '多对多（N : N）' },
            ]"
            :key="item.value"
            :value="item.value"
            :label="item.label" /></ElSelect
      ></ElFormItem>
      <p class="management-help">
        可留空。按源对象 →
        目标对象声明：一对一要求两侧、一对多要求源侧、多对一要求目标侧的关联字段包含一整组已配置唯一键，发布和查询时会校验。
      </p>
      <hr class="relation-settings-divider" />
      <ElFormItem label="允许的关联方式" required
        ><ElSelect v-model="draft.allowed_join_types" aria-label="允许的关联方式" multiple
          ><ElOption label="内关联 · 仅匹配记录" value="inner" /><ElOption
            label="左关联 · 保留源对象记录"
            value="left" /><ElOption label="右关联 · 保留目标对象记录" value="right" /></ElSelect
      ></ElFormItem>
      <p class="management-help">
        查询按所选字段关联；统计时仍会检查重复计算风险，必要时需先分组或聚合。
      </p>
      <details class="relation-identity">
        <summary>关系标识</summary>
        <ElInput v-model="draft.relation_id" aria-label="关系标识" :disabled="existing" />
        <p class="management-help">新关系自动生成标识，发布后固定。</p>
      </details>
    </ElForm>
    <footer>
      <ElButton v-if="canDisable" type="danger" plain :disabled="disabled" @click="emit('disable')"
        >停用关系</ElButton
      ><ElButton type="primary" :disabled="disabled" @click="emit('apply')">应用修改</ElButton>
    </footer>
  </aside>
</template>
