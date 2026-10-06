<script setup lang="ts">
import { vNumberAccessibility } from "../../../shared/management/number-accessibility";
import { computed, ref } from "vue";
import { ElInput, ElSelect, ElOption, ElInputNumber, ElButton, ElPagination } from "element-plus";
import type { ApiDatasetConfig, Dataset, ManagedRole } from "@ai-data/contracts";
const config = defineModel<ApiDatasetConfig>({ required: true });
const props = defineProps<{ dataset: Dataset; roles: ManagedRole[]; disabled: boolean }>();
const search = ref(""),
  page = ref(1),
  expanded = ref("");
const filtered = computed(() =>
  props.dataset.columns.filter((item) =>
    `${item.name} ${item.source_description ?? ""}`
      .toLowerCase()
      .includes(search.value.toLowerCase()),
  ),
);
const visible = computed(() => filtered.value.slice((page.value - 1) * 20, page.value * 20));
const policy = (field: string) => config.value.column_policies.find((item) => item.field === field);
function describe(field: string, value: string) {
  config.value.column_descriptions = config.value.column_descriptions.filter(
    (item) => item.field !== field,
  );
  if (value.trim()) config.value.column_descriptions.push({ field, business_description: value });
}
function masking(field: string, value: string) {
  config.value.column_policies = config.value.column_policies.filter(
    (item) => item.field !== field,
  );
  if (value !== "inherit")
    config.value.column_policies.push({
      field,
      default_masking:
        value === "none"
          ? { type: "none" }
          : { type: "partial_mask", prefix_length: 0, suffix_length: 0, mask_character: "*" },
      unmasked_role_ids: [],
    });
}
</script>
<template>
  <section class="management-section">
    <h3>字段说明与脱敏</h3>
    <ElInput v-model="search" placeholder="搜索字段" aria-label="搜索字段" @input="page = 1" />
    <p class="management-help">共 {{ filtered.length }} 个字段，每页 20 项。</p>
    <div v-for="column in visible" :key="column.name" class="management-section">
      <div class="management-actions">
        <strong>{{ column.name }}</strong
        ><small class="muted"
          >{{ column.data_type }} · {{ column.nullable ? "可空" : "非空" }}</small
        ><ElButton
          text
          :disabled="disabled"
          @click="expanded = expanded === column.name ? '' : column.name"
          >{{ expanded === column.name ? "收起策略" : "脱敏策略" }}</ElButton
        >
      </div>
      <p v-if="column.source_description" class="management-help">
        源说明：{{ column.source_description }}
      </p>
      <ElInput
        :model-value="
          config.column_descriptions.find((item) => item.field === column.name)
            ?.business_description ?? ''
        "
        :aria-label="`${column.name} 业务说明`"
        :disabled="disabled"
        placeholder="填写业务含义"
        @update:model-value="describe(column.name, $event)"
      />
      <div v-if="expanded === column.name" class="management-section">
        <ElSelect
          :model-value="policy(column.name)?.default_masking.type ?? 'inherit'"
          :disabled="disabled"
          :aria-label="`${column.name} 脱敏规则`"
          @update:model-value="masking(column.name, $event)"
          ><ElOption label="不附加默认脱敏" value="inherit" /><ElOption
            label="原值返回"
            value="none" /><ElOption label="部分遮罩" value="partial_mask" /></ElSelect
        ><template
          v-for="item in config.column_policies.filter((item) => item.field === column.name)"
          :key="item.field"
          ><div
            v-if="item.default_masking.type === 'partial_mask'"
            class="management-form-grid management-section"
          >
            <label
              >保留开头字符<ElInputNumber
                v-model="item.default_masking.prefix_length"
                v-number-accessibility
                :min="0"
                :precision="0"
                :disabled="disabled" /></label
            ><label
              >保留结尾字符<ElInputNumber
                v-model="item.default_masking.suffix_length"
                v-number-accessibility
                :min="0"
                :precision="0"
                :disabled="disabled" /></label
            ><label
              >遮罩字符<ElInput
                v-model="item.default_masking.mask_character"
                maxlength="1"
                :disabled="disabled"
            /></label>
          </div>
          <label
            >免脱敏角色<ElSelect
              v-model="item.unmasked_role_ids"
              multiple
              filterable
              :disabled="disabled"
              ><ElOption
                v-for="role in roles"
                :key="role.id"
                :label="role.name"
                :value="role.id" /></ElSelect></label
        ></template>
      </div>
    </div>
    <ElPagination
      v-if="filtered.length > 20"
      v-model:current-page="page"
      :total="filtered.length"
      :page-size="20"
      layout="prev,pager,next"
      small
    />
  </section>
</template>
