<script setup lang="ts">
import { computed } from "vue";
import { ElSelect, ElOption, ElInputNumber, ElInput } from "element-plus";
import type {
  ApiDatasetColumnPolicy,
  DatasetColumn,
  ManagedRole,
  MaskingRule,
} from "@ai-data/contracts";
import { vNumberAccessibility } from "../../../shared/management/number-accessibility";
const model = defineModel<ApiDatasetColumnPolicy | undefined>();
const props = defineProps<{ column: DatasetColumn; roles: ManagedRole[]; disabled: boolean }>();
const rule = computed(() => model.value?.default_masking);
const sample = "REP2026100912346789";
const preview = computed(() => {
  const value = rule.value;
  if (!value || value.type === "none" || props.column.data_type !== "string") return sample;
  // 与 DAS 字符串出口一致：两端重叠时全串遮罩；仅使用固定示例，不读取业务行。
  const visible = value.prefix_length + value.suffix_length;
  if (sample.length <= visible) return value.mask_character.repeat(sample.length);
  return (
    sample.slice(0, value.prefix_length) +
    value.mask_character.repeat(sample.length - visible) +
    (value.suffix_length ? sample.slice(-value.suffix_length) : "")
  );
});
function change(value: string) {
  if (value === "inherit") {
    model.value = undefined;
    return;
  }
  model.value = {
    field: props.column.name,
    default_masking:
      value === "none"
        ? { type: "none" }
        : { type: "partial_mask", prefix_length: 0, suffix_length: 0, mask_character: "*" },
    unmasked_role_ids: model.value?.unmasked_role_ids ?? [],
  };
}
function update(value: Partial<Extract<MaskingRule, { type: "partial_mask" }>>) {
  if (model.value?.default_masking.type === "partial_mask")
    model.value = { ...model.value, default_masking: { ...model.value.default_masking, ...value } };
}
const missingRoles = computed(
  () =>
    model.value?.unmasked_role_ids.filter((id) => !props.roles.some((role) => role.id === id)) ??
    [],
);
</script>
<template>
  <div class="field-mask">
    <h4>{{ column.name }} · 脱敏配置</h4>
    <div class="mask-controls">
      <label
        >脱敏方式<ElSelect
          :model-value="rule?.type ?? 'inherit'"
          :aria-label="`${column.name} 脱敏规则`"
          :disabled="disabled"
          @update:model-value="change"
        >
          <ElOption label="未配置" value="inherit" /><ElOption
            label="原值返回"
            value="none"
          /><ElOption
            label="部分遮罩"
            value="partial_mask"
            :disabled="column.data_type !== 'string'"
          /> </ElSelect
      ></label>
      <template v-if="rule?.type === 'partial_mask'">
        <label
          >保留开头字符<ElInputNumber
            v-number-accessibility
            :model-value="rule.prefix_length"
            :min="0"
            :precision="0"
            :disabled="disabled"
            :aria-label="`${column.name} 保留开头字符`"
            @update:model-value="update({ prefix_length: $event ?? 0 })"
        /></label>
        <label
          >保留结尾字符<ElInputNumber
            v-number-accessibility
            :model-value="rule.suffix_length"
            :min="0"
            :precision="0"
            :disabled="disabled"
            :aria-label="`${column.name} 保留结尾字符`"
            @update:model-value="update({ suffix_length: $event ?? 0 })"
        /></label>
        <label
          >遮罩字符<ElInput
            :model-value="rule.mask_character"
            maxlength="1"
            :disabled="disabled"
            :aria-label="`${column.name} 遮罩字符`"
            @update:model-value="update({ mask_character: $event || '*' })"
        /></label>
      </template>
    </div>
    <p v-if="column.data_type !== 'string'" class="management-help">
      部分遮罩仅适用于文本字段；当前字段按原类型返回。
    </p>
    <p v-else-if="!model" class="management-help">
      当前字段未设置默认脱敏。选择部分遮罩后配置保留字符与免脱敏角色。
    </p>
    <div v-if="model" class="mask-details">
      <label
        >免脱敏角色<ElSelect
          :model-value="model.unmasked_role_ids"
          :aria-label="`${column.name} 免脱敏角色`"
          multiple
          filterable
          collapse-tags
          collapse-tags-tooltip
          :disabled="disabled"
          placeholder="选择可查看原值的角色"
          @update:model-value="model = { ...model!, unmasked_role_ids: $event }"
        >
          <ElOption v-for="role in roles" :key="role.id" :label="role.name" :value="role.id" />
          <ElOption
            v-for="role in missingRoles"
            :key="role"
            :label="`${role}（不可用）`"
            :value="role"
            disabled
          /> </ElSelect
      ></label>
      <div v-if="column.data_type === 'string'" class="mask-example">
        <span>效果示例</span
        ><output :aria-label="`${column.name} 脱敏效果示例`">{{ preview }}</output>
        <small>示例原值：{{ sample }}</small>
      </div>
    </div>
  </div>
</template>
<style scoped>
.field-mask {
  margin: 0 10px 14px;
  padding: 18px;
  border-left: 3px solid var(--app-primary);
  background: var(--app-surface);
  border-radius: var(--app-radius);
}
.field-mask h4 {
  margin: 0 0 18px;
  font-size: 13px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.mask-controls {
  display: grid;
  grid-template-columns: 1.2fr 1fr 1fr 0.8fr;
  gap: 16px;
}
.field-mask label {
  display: grid;
  align-content: start;
  gap: 8px;
  font-size: 12px;
  min-width: 0;
}
.mask-details {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
  gap: 24px;
  margin-top: 20px;
}
.mask-example {
  display: grid;
  gap: 8px;
  min-width: 0;
  font-size: 12px;
}
.mask-example output {
  font-family: var(--app-font-mono, monospace);
  font-size: 14px;
  overflow-wrap: anywhere;
}
.mask-example small {
  color: var(--app-muted);
  overflow-wrap: anywhere;
}
@container (max-width: 720px) {
  .mask-controls {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@container (max-width: 480px) {
  .field-mask {
    padding: 14px;
  }
  .mask-controls,
  .mask-details {
    grid-template-columns: minmax(0, 1fr);
    gap: 14px;
  }
}
</style>
