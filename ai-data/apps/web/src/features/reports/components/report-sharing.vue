<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { ElAlert, ElButton, ElCheckbox, ElDrawer, ElInput, ElTag } from "element-plus";
import { useServices } from "../../../app/services";
const props = defineProps<{ reportId: string; title: string; resultQuery: string }>();
const { reportSharing } = useServices(),
  state = reportSharing.state;
const opened = ref(false),
  search = ref(""),
  copied = ref("");
let timer: ReturnType<typeof setTimeout> | undefined;
const locked = computed(() => state.saving || !!state.conflict || state.uncertain);
const changed = computed(
  () =>
    !!state.baseline &&
    (state.selected.length !== state.baseline.shared_with.length ||
      state.selected.some((m) => !state.baseline!.shared_with.includes(m.user_id))),
);
async function open() {
  opened.value = true;
  search.value = "";
  await reportSharing.open(props.reportId);
  await reportSharing.search("");
}
watch(search, () => {
  clearTimeout(timer);
  timer = setTimeout(() => void reportSharing.search(search.value), 250);
});
watch(
  () => props.reportId,
  () => {
    opened.value = false;
    reportSharing.leave();
  },
);
async function copy(result: boolean) {
  try {
    await navigator.clipboard.writeText(
      `${location.origin}/reports/${encodeURIComponent(props.reportId)}${result ? props.resultQuery : ""}`,
    );
    copied.value = "链接已复制，成员登录后按权限访问";
  } catch {
    copied.value = "复制失败，请从地址栏复制报表链接";
  }
}
onBeforeUnmount(() => {
  clearTimeout(timer);
  reportSharing.leave();
});
</script>
<template>
  <ElButton @click="open">分享</ElButton>
  <ElDrawer
    v-model="opened"
    title="报表分享"
    size="min(480px, 100vw)"
    @closed="reportSharing.leave()"
  >
    <div class="sharing-content">
      <strong>{{ title }}</strong>
      <p class="muted">选择本组织成员。接收人按自己的数据权限查看和运行报表。</p>
      <p v-if="state.loading" role="status">正在读取分享设置…</p>
      <ElAlert v-if="state.error" :title="state.error" type="warning" :closable="false" />
      <ElButton v-if="!state.baseline && !state.loading" @click="open">重新读取</ElButton>
      <template v-if="state.baseline">
        <h3>已选成员（{{ state.selected.length }}）</h3>
        <div class="sharing-selected">
          <ElTag
            v-for="member in state.selected"
            :key="member.user_id"
            :closable="!locked"
            :type="member.status === 'active' ? 'info' : 'warning'"
            @close="reportSharing.toggle(member, false)"
          >
            {{ member.display_name ?? member.user_id }} · {{ member.username ?? "账号不可用"
            }}<span v-if="member.status !== 'active'"
              >（{{ member.status === "disabled" ? "停用" : "不可用" }}）</span
            >
          </ElTag>
          <span v-if="!state.selected.length" class="muted">当前仅自己可见</span>
        </div>
        <label for="sharing-search">添加成员</label>
        <ElInput
          id="sharing-search"
          v-model="search"
          :maxlength="80"
          :disabled="locked"
          placeholder="搜索姓名或账号"
          clearable
        />
        <div class="sharing-candidates" aria-label="可分享成员">
          <ElCheckbox
            v-for="member in state.candidates"
            :key="member.user_id"
            :model-value="state.selected.some((m) => m.user_id === member.user_id)"
            :disabled="locked"
            @change="reportSharing.toggle(member, Boolean($event))"
          >
            {{ member.display_name }} <span class="muted">{{ member.username }}</span>
          </ElCheckbox>
          <p v-if="!state.searching && !state.candidates.length" class="muted">
            没有匹配的可用成员
          </p>
          <ElButton
            v-if="state.nextCursor"
            :loading="state.searching"
            :disabled="locked"
            @click="reportSharing.search(search, true)"
            >加载更多成员</ElButton
          >
          <p v-else-if="state.searching" role="status">正在搜索…</p>
        </div>
        <section v-if="state.conflict" class="sharing-conflict">
          <h3>最新分享范围</h3>
          <p>
            {{
              state.conflict.members
                .map((m) => `${m.display_name ?? m.user_id}（${m.username ?? "不可用"}）`)
                .join("、") || "仅作者可见"
            }}
          </p>
          <p class="muted">
            合并会应用你本次的添加和移除，并保留其他页面新增的成员。核对后再保存。
          </p>
          <ElButton @click="reportSharing.merge()">确认合并草稿</ElButton>
        </section>
        <ElButton v-if="state.uncertain" :disabled="state.saving" @click="reportSharing.reconcile()"
          >核对保存结果</ElButton
        >
        <p v-if="state.saved" role="status">分享设置已保存</p>
        <ElButton
          type="primary"
          :loading="state.saving"
          :disabled="!changed || locked"
          @click="reportSharing.save()"
          >保存分享设置</ElButton
        >
        <div class="sharing-links">
          <ElButton text @click="copy(false)">复制报表链接</ElButton
          ><ElButton v-if="resultQuery" text @click="copy(true)">复制当前结果链接</ElButton>
        </div>
        <p v-if="copied" class="muted" role="status">{{ copied }}</p>
      </template>
    </div>
  </ElDrawer>
</template>
<style scoped>
.sharing-content {
  display: grid;
  gap: 16px;
}
.sharing-content p,
.sharing-content h3 {
  margin: 0;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.sharing-content h3 {
  font-size: 14px;
}
.sharing-selected {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.sharing-selected :deep(.el-tag) {
  max-width: 100%;
  height: auto;
  white-space: normal;
}
.sharing-candidates {
  display: grid;
  gap: 8px;
}
.sharing-candidates :deep(.el-checkbox) {
  height: auto;
  min-height: 36px;
  margin: 0;
}
.sharing-candidates :deep(.el-checkbox__label) {
  white-space: normal;
  overflow-wrap: anywhere;
}
.sharing-conflict {
  padding: 16px 0;
  border-block: 1px solid var(--app-border);
  display: grid;
  gap: 12px;
}
.sharing-links {
  display: flex;
  flex-wrap: wrap;
}
</style>
