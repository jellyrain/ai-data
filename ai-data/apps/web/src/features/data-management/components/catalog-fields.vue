<script setup lang="ts">
import { computed, ref, useId, watch } from "vue";
import { ElInput, ElButton, ElPagination } from "element-plus";
import { Search, ShieldCheck } from "lucide-vue-next";
import type {
  ApiDatasetConfig,
  ApiDatasetColumnPolicy,
  Dataset,
  ManagedRole,
} from "@ai-data/contracts";
import CatalogFieldMask from "./catalog-field-mask.vue";
const config = defineModel<ApiDatasetConfig>({ required: true });
const props = defineProps<{ dataset: Dataset; roles: ManagedRole[]; disabled: boolean }>();
const search = ref(""),
  page = ref(1),
  expanded = ref("");
const id = useId();
const descriptions = computed(
  () => new Map(config.value.column_descriptions.map((c) => [c.field, c.business_description])),
);
const policies = computed(() => new Map(config.value.column_policies.map((p) => [p.field, p])));
const filtered = computed(() => {
  const term = search.value.trim().toLowerCase();
  return props.dataset.columns.filter((item) =>
    `${item.name} ${item.source_description ?? ""} ${descriptions.value.get(item.name) ?? ""}`
      .toLowerCase()
      .includes(term),
  );
});
const visible = computed(() => filtered.value.slice((page.value - 1) * 20, page.value * 20));
watch(
  () => filtered.value.length,
  (count) => {
    page.value = Math.min(page.value, Math.max(1, Math.ceil(count / 20)));
  },
);
function describe(field: string, value: string) {
  config.value.column_descriptions = config.value.column_descriptions.filter(
    (item) => item.field !== field,
  );
  if (value.trim()) config.value.column_descriptions.push({ field, business_description: value });
}
function setPolicy(field: string, policy: ApiDatasetColumnPolicy | undefined) {
  config.value.column_policies = config.value.column_policies.filter(
    (item) => item.field !== field,
  );
  if (policy) config.value.column_policies.push(policy);
}
function status(field: string) {
  const rule = policies.value.get(field)?.default_masking;
  return rule?.type === "partial_mask" ? "部分遮罩" : rule ? "原值返回" : "未配置";
}
</script>
<template>
  <section class="management-section catalog-fields" aria-label="字段说明与脱敏">
    <h3>字段说明与脱敏</h3>
    <p class="management-help">数据库注释自动读取，业务说明用于补充或覆盖。</p>
    <div class="field-toolbar">
      <ElInput
        v-model="search"
        clearable
        placeholder="搜索字段名、注释或业务说明"
        aria-label="搜索字段"
        @input="page = 1"
      >
        <template #prefix><Search :size="16" aria-hidden="true" /></template>
      </ElInput>
      <span class="field-count" aria-live="polite">{{
        search.trim()
          ? `找到 ${filtered.length} / 共 ${dataset.columns.length} 个字段`
          : `共 ${dataset.columns.length} 个字段`
      }}</span>
    </div>
    <div class="field-list">
      <div class="field-columns" aria-hidden="true">
        <span>字段</span><span>字段说明</span><span>脱敏规则</span>
      </div>
      <div
        v-for="(column, index) in visible"
        :key="column.name"
        class="field-row"
        role="group"
        :aria-label="`字段 ${column.name}`"
      >
        <div class="field-summary">
          <div class="field-name">
            <strong>{{ column.name }}</strong
            ><small>{{ column.data_type }} · {{ column.nullable ? "可空" : "非空" }}</small>
          </div>
          <div class="field-description">
            <div class="field-source">
              <span>数据库注释</span>
              <p :class="{ 'field-empty-note': !column.source_description }">
                {{ column.source_description || "数据库未提供注释" }}
              </p>
            </div>
            <label class="field-business"
              ><span>业务说明</span
              ><ElInput
                :model-value="descriptions.get(column.name) ?? ''"
                :aria-label="`${column.name} 业务说明`"
                :disabled="disabled"
                :placeholder="
                  column.source_description ? '留空沿用数据库注释' : '填写字段的业务含义'
                "
                type="textarea"
                :autosize="{ minRows: 1, maxRows: 4 }"
                @update:model-value="describe(column.name, $event)"
            /></label>
          </div>
          <div class="field-policy">
            <span
              :class="{
                'field-masked': policies.get(column.name)?.default_masking.type === 'partial_mask',
              }"
              ><ShieldCheck
                v-if="policies.get(column.name)?.default_masking.type === 'partial_mask'"
                :size="15"
                aria-hidden="true"
              />{{ status(column.name) }}</span
            >
            <ElButton
              :disabled="disabled"
              :aria-label="`${expanded === column.name ? '收起脱敏' : '配置脱敏'} ${column.name}`"
              :aria-expanded="expanded === column.name"
              :aria-controls="`${id}-mask-${index}`"
              @click="expanded = expanded === column.name ? '' : column.name"
              >{{ expanded === column.name ? "收起配置" : "配置脱敏" }}</ElButton
            >
          </div>
        </div>
        <CatalogFieldMask
          v-if="expanded === column.name"
          :id="`${id}-mask-${index}`"
          :model-value="policies.get(column.name)"
          :column="column"
          :roles="roles"
          :disabled="disabled"
          @update:model-value="setPolicy(column.name, $event)"
        />
      </div>
      <div v-if="!filtered.length" class="field-empty">
        {{ dataset.columns.length ? "没有匹配的字段" : "当前对象没有字段定义" }}
      </div>
    </div>
    <div v-if="filtered.length" class="field-pagination">
      <span class="management-help">每页 20 项</span>
      <ElPagination
        v-if="filtered.length > 20"
        v-model:current-page="page"
        :total="filtered.length"
        :page-size="20"
        layout="prev,pager,next"
        small
      />
    </div>
  </section>
</template>
<style scoped>
.catalog-fields {
  container-type: inline-size;
}
.catalog-fields h3 {
  margin-bottom: 6px;
}
.field-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  margin: 18px 0;
}
.field-toolbar .el-input {
  width: min(100%, 380px);
}
.field-count {
  font-size: 12px;
  color: var(--app-muted);
}
.field-list {
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius);
}
.field-columns,
.field-summary {
  display: grid;
  grid-template-columns: minmax(130px, 1fr) minmax(0, 2.7fr) 118px;
  gap: 20px;
  padding: 18px;
}
.field-columns {
  background: var(--app-surface);
  border-radius: var(--app-radius) var(--app-radius) 0 0;
  font-size: 12px;
  color: var(--app-muted);
  padding-block: 12px;
}
.field-row {
  border-top: 1px solid var(--app-border);
}
.field-name strong {
  display: block;
  overflow-wrap: anywhere;
  line-height: 1.5;
}
.field-name small {
  display: block;
  color: var(--app-muted);
  margin-top: 6px;
  font-size: 12px;
}
.field-description {
  display: grid;
  gap: 12px;
  min-width: 0;
}
.field-source,
.field-business {
  display: grid;
  grid-template-columns: 78px minmax(0, 1fr);
  align-items: start;
  gap: 10px;
  font-size: 13px;
  line-height: 1.7;
}
.field-source > span,
.field-business > span {
  color: var(--app-muted);
}
.field-business > span {
  padding-top: 5px;
}
.field-source p {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.field-empty-note {
  color: var(--app-muted);
}
.field-policy {
  display: flex;
  align-items: flex-start;
  flex-direction: column;
  gap: 12px;
  font-size: 13px;
}
.field-policy > span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  line-height: 1.7;
}
.field-masked {
  color: var(--app-primary);
}
.field-pagination {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: 16px;
}
.field-empty {
  padding: 32px 18px;
  text-align: center;
  color: var(--app-muted);
  font-size: 13px;
}
@container (max-width: 720px) {
  .field-columns,
  .field-summary {
    grid-template-columns: minmax(110px, 1fr) minmax(0, 2fr) 100px;
    gap: 14px;
    padding-inline: 14px;
  }
  .field-source,
  .field-business {
    grid-template-columns: minmax(0, 1fr);
    gap: 4px;
  }
  .field-business > span {
    padding-top: 0;
  }
}
@container (max-width: 480px) {
  .field-columns {
    display: none;
  }
  .field-row:first-of-type {
    border-top: 0;
  }
  .field-summary {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .field-policy {
    grid-column: 2;
    grid-row: 1;
  }
  .field-description {
    grid-column: 1 / -1;
    grid-row: 2;
  }
  .field-toolbar .el-input {
    width: 100%;
  }
}
</style>
