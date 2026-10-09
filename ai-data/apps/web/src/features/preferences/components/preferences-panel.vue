<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElButton, ElSkeleton } from "element-plus";
import {
  stableStringify,
  userPreferenceInputSchema,
  type UserPreference,
  type UserPreferenceInput,
  type PreferenceConfirmation,
} from "@ai-data/contracts";
import { createUuid } from "../../../shared/identity/create-uuid";
import { PreferenceApi } from "../api/preference-api";
import PreferenceForm from "./preference-form.vue";
import ResourceList from "../../../shared/management/resource-list.vue";
import ManagementFeedback from "../../../shared/management/management-feedback.vue";
import {
  useManagementPage,
  confirmManagement,
} from "../../../shared/management/use-management-page";
import { ApiError } from "../../../shared/http/api-error";
const blank = (): UserPreferenceInput => ({
  key: "",
  scope: {},
  value: {
    type: "time_range",
    range: { type: "relative", period: "this_year", extent: "full_period" },
  },
  auto_apply: true,
});
const items = ref<UserPreference[]>([]),
  confirmations = ref<PreferenceConfirmation[]>([]),
  selected = ref<UserPreference | null>(null),
  draft = ref(blank()),
  editing = ref(false),
  baseline = ref(""),
  expected = ref<number | null>(null),
  boundKey = ref(""),
  blocked = ref(false);
let attempt = { content: "", id: "" };
const { scope, discard } = useManagementPage(
  () => {
    items.value = [];
    confirmations.value = [];
    selected.value = null;
    draft.value = blank();
    editing.value = false;
    baseline.value = "";
    expected.value = null;
    boundKey.value = "";
    blocked.value = false;
    attempt = { content: "", id: "" };
  },
  () => editing.value && stableStringify(draft.value) !== baseline.value,
);
const labels = {
  metric: "常用指标",
  time_range: "时间范围",
  filters: "筛选条件",
  grouping: "分组",
  presentation: "展示方式",
  query_habit: "查询习惯",
};
const rows = computed(() =>
  items.value.map((item) => ({
    id: item.key,
    title: item.key,
    description: labels[item.value.type] + " · v" + item.version,
    status: item.auto_apply ? "自动应用" : "手动使用",
  })),
);
function input(record: UserPreference): UserPreferenceInput {
  return {
    key: record.key,
    scope: record.scope,
    value: record.value,
    auto_apply: record.auto_apply,
  };
}
function accept(record: UserPreference) {
  selected.value = record;
  draft.value = JSON.parse(JSON.stringify(input(record)));
  expected.value = record.version;
  boundKey.value = record.key;
  baseline.value = stableStringify(draft.value);
  editing.value = true;
  blocked.value = false;
}
function load() {
  return scope.run(async (request) => {
    const api = new PreferenceApi(request);
    items.value = await api.list();
    confirmations.value = await api.confirmations();
  });
}
async function open(key: string) {
  if (!(await discard())) return;
  await scope.run(async (request) => {
    const state = await new PreferenceApi(request).editState(key);
    if (state.status !== "live") throw new ApiError("偏好已删除，请刷新列表", 404);
    accept(state.preference);
  });
}
async function create() {
  if (!(await discard())) return;
  selected.value = null;
  draft.value = blank();
  expected.value = null;
  boundKey.value = "";
  baseline.value = stableStringify(draft.value);
  editing.value = true;
  blocked.value = false;
}
async function save() {
  if (blocked.value) return;
  await scope.run(async (request) => {
    const api = new PreferenceApi(request),
      parsed = userPreferenceInputSchema.parse(draft.value);
    if (expected.value === null || boundKey.value !== parsed.key) {
      const state = await api.editState(parsed.key);
      if (state.status === "live") {
        blocked.value = true;
        throw new ApiError("此标识已有偏好，请核对当前设置后再修改", 409);
      }
      expected.value = state.version;
      boundKey.value = parsed.key;
    }
    const content = stableStringify({ ...parsed, expected_version: expected.value });
    if (attempt.content !== content) attempt = { content, id: createUuid() };
    try {
      const result = await api.save({
        ...parsed,
        expected_version: expected.value,
        idempotency_key: attempt.id,
      });
      if (result.status === "saved") accept(result.preference);
      else throw new ApiError("请在原会话完成偏好确认", 409);
    } catch (error) {
      if (error instanceof ApiError && [401, 403].includes(error.status)) throw error;
      const current = await api.editState(parsed.key);
      if (
        current.status === "live" &&
        stableStringify(input(current.preference)) === stableStringify(parsed)
      )
        accept(current.preference);
      else {
        if (error instanceof ApiError && error.status === 409) blocked.value = true;
        throw error;
      }
    }
    items.value = await api.list();
    confirmations.value = await api.confirmations();
    scope.state.notice = "偏好已保存，后续会话会按当前设置使用。";
  });
}
async function rebase() {
  if (
    !(await confirmManagement("将保留草稿并读取当前版本。请核对当前设置后再保存。", "核对偏好版本"))
  )
    return;
  await scope.run(async (request) => {
    const state = await new PreferenceApi(request).editState(draft.value.key);
    expected.value = state.version;
    boundKey.value = draft.value.key;
    selected.value = state.status === "live" ? state.preference : null;
    blocked.value = false;
    attempt = { content: "", id: "" };
    scope.state.notice =
      state.status === "live"
        ? "当前设置：" + JSON.stringify(state.preference.value)
        : "当前偏好未生效，可以重新设置。";
  });
}
async function remove() {
  const record = selected.value;
  if (
    !record ||
    !(await confirmManagement("删除后不会自动应用此偏好；需要时可重新设置。", "删除偏好"))
  )
    return;
  await scope.run(async (request) => {
    const api = new PreferenceApi(request),
      key = createUuid();
    try {
      await api.remove(record.key, record.version, key);
    } catch (error) {
      if (error instanceof ApiError && [401, 403].includes(error.status)) throw error;
      if ((await api.editState(record.key)).status !== "deleted") throw error;
    }
    items.value = await api.list();
    confirmations.value = await api.confirmations();
    selected.value = null;
    editing.value = false;
    draft.value = blank();
    scope.state.notice = "偏好已删除。";
  });
}
async function useProposal(item: PreferenceConfirmation) {
  if (!(await discard())) return;
  await scope.run(async (request) => {
    const state = await new PreferenceApi(request).editState(item.proposed.key);
    selected.value = state.status === "live" ? state.preference : null;
    draft.value = JSON.parse(JSON.stringify(item.proposed));
    expected.value = state.version;
    boundKey.value = item.proposed.key;
    baseline.value = selected.value ? stableStringify(input(selected.value)) : "";
    editing.value = true;
    blocked.value = false;
  });
}
onMounted(load);
defineExpose({ discard, busy: computed(() => scope.state.busy) });
</script>
<template>
  <div class="management-toolbar">
    <ElButton type="primary" :disabled="scope.state.busy" @click="create">新增偏好</ElButton
    ><ElButton :loading="scope.state.busy" @click="load">刷新偏好</ElButton
    ><span class="muted">本次返回 {{ items.length }} 条</span>
  </div>
  <ManagementFeedback v-bind="scope.state" />
  <ElSkeleton v-if="scope.state.busy && !items.length && !editing" :rows="5" />
  <div class="management-grid">
    <ResourceList
      :items="rows"
      :selected="selected?.key"
      :disabled="scope.state.busy"
      @select="open"
    />
    <div class="management-detail">
      <template v-if="editing"
        ><h2>{{ selected ? "编辑偏好" : "新增偏好" }}</h2>
        <p v-if="selected" class="management-help">
          版本 {{ selected.version }} · 更新于 {{ selected.updated_at }} · 已使用
          {{ selected.use_count }} 次
        </p>
        <p v-if="selected" class="management-help">
          最近使用：{{ selected.last_used_at ?? "尚未使用" }} · 来源：{{
            selected.source.conversation_id ? "分析会话" : "手动设置"
          }}<RouterLink
            v-if="selected.source.conversation_id"
            :to="'/analysis/' + encodeURIComponent(selected.source.conversation_id)"
            >查看来源</RouterLink
          >
        </p>
        <fieldset class="knowledge-fieldset" :disabled="scope.state.busy">
          <PreferenceForm v-model="draft" :existing="!!selected" />
        </fieldset>
        <div class="management-footer">
          <ElButton type="primary" :loading="scope.state.busy" :disabled="blocked" @click="save"
            >保存偏好</ElButton
          ><ElButton v-if="blocked" @click="rebase">核对当前版本</ElButton
          ><ElButton v-if="selected" :disabled="scope.state.busy" @click="remove"
            >删除偏好</ElButton
          >
        </div></template
      >
      <div v-else class="report-empty">
        <h2>让后续分析记住你的习惯</h2>
        <p class="muted">设置常用指标、时间和筛选条件；本次提问中明确指定的条件优先。</p>
      </div>
    </div>
  </div>
  <section class="management-section">
    <h2>待确认建议</h2>
    <p v-if="!confirmations.length" class="muted">当前没有待确认的偏好建议。</p>
    <article
      v-for="item in confirmations"
      :key="item.confirmation_id"
      class="knowledge-confirmation"
    >
      <h3>{{ item.proposed.key }}</h3>
      <p>
        {{ item.reason === "auto_apply_disabled" ? "建议重新开启自动应用" : "建议与当前设置不同" }}
      </p>
      <p class="management-help">
        当前：{{
          JSON.stringify(items.find((value) => value.key === item.proposed.key)?.value ?? {})
        }}
      </p>
      <p class="management-help">建议：{{ JSON.stringify(item.proposed.value) }}</p>
      <div class="management-actions">
        <RouterLink
          v-if="item.source.conversation_id"
          :to="'/analysis/' + encodeURIComponent(item.source.conversation_id)"
          >打开来源会话</RouterLink
        ><ElButton text :disabled="scope.state.busy" @click="useProposal(item)"
          >查看建议并手动修改</ElButton
        >
      </div>
    </article>
  </section>
</template>
