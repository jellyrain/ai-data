import { watch } from "vue";
import { onBeforeRouteUpdate, useRoute, useRouter } from "vue-router";

/** 资源详情地址只保存标识和版本；草稿与凭据始终留在当前页面内存。 */
function useResourceLocation(options: {
  discard(): Promise<boolean>;
  clear(): void;
  load(id: string, version?: number): Promise<void>;
}) {
  const route = useRoute(),
    router = useRouter();
  const identity = () => [route.query.resource, route.query.version];
  async function restore() {
    options.clear();
    const id = route.query.resource;
    if (typeof id !== "string" || !id) return;
    const raw = route.query.version;
    const version =
      typeof raw === "string" && /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(Number(raw))
        ? Number(raw)
        : undefined;
    await options.load(id, version);
  }
  onBeforeRouteUpdate(() => options.discard());
  watch(identity, restore);
  function select(id: string, version?: number, replace = false) {
    const query = { ...route.query, resource: id, version: version ? String(version) : undefined };
    return replace ? router.replace({ query }) : router.push({ query });
  }
  async function close() {
    if (route.query.resource) {
      const query = { ...route.query };
      delete query.resource;
      delete query.version;
      await router.push({ query });
    } else if (await options.discard()) options.clear();
  }
  return { route, restore, select, close };
}
export { useResourceLocation };
