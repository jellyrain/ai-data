<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElButton } from "element-plus";
import { useServices } from "../../../app/services";
import DasManager from "../components/das-manager.vue";
import CatalogManager from "../components/catalog-manager.vue";
const { auth } = useServices();
const allowed = (permission: string) =>
  !!auth.state.context &&
  (auth.state.context.roles.includes("system_admin") ||
    auth.state.context.permissions.includes(permission));
const canDas = computed(() => allowed("data-access:manage")),
  canCatalog = computed(() => allowed("catalog:manage"));
const tab = ref(canDas.value ? "das" : "catalog"),
  das = ref<InstanceType<typeof DasManager>>(),
  catalog = ref<InstanceType<typeof CatalogManager>>();
async function select(value: string) {
  if (value === tab.value) return;
  if (!(await (das.value?.canLeave() ?? catalog.value?.canLeave() ?? true))) return;
  tab.value = value;
}
watch([canDas, canCatalog], () => {
  if (tab.value === "das" && !canDas.value) tab.value = "catalog";
  else if (tab.value === "catalog" && !canCatalog.value) tab.value = "das";
});
</script>
<template>
  <section class="management-page">
    <header class="management-heading">
      <div>
        <h1>数据管理</h1>
        <p class="muted">接入业务数据，完善目录与可复用关系。</p>
      </div>
    </header>
    <nav class="management-tabs" aria-label="数据管理功能">
      <ElButton v-if="canDas" :type="tab === 'das' ? 'primary' : 'default'" @click="select('das')"
        >DAS 与数据源</ElButton
      ><ElButton
        v-if="canCatalog"
        :type="tab === 'catalog' ? 'primary' : 'default'"
        @click="select('catalog')"
        >业务目录与关系</ElButton
      >
    </nav>
    <DasManager v-if="tab === 'das' && canDas" ref="das" /><CatalogManager
      v-else-if="canCatalog"
      ref="catalog"
    />
  </section>
</template>
