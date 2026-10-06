import { onBeforeUnmount } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import { ElMessageBox } from "element-plus";
import { useServices } from "../../app/services";
import { ManagementScope } from "./management-scope";
/** 页面离开时确认未保存内容；换号和权限失败直接清理资源。 */
function useManagementPage(clear: () => void, dirty: () => boolean) {
  const { request, resources } = useServices();
  const scope = new ManagementScope({ request, resources, clear });
  async function discard() {
    if (scope.state.busy) return false;
    if (!dirty()) return true;
    try {
      await ElMessageBox.confirm("有尚未保存的修改，离开后将丢弃这些内容。", "放弃修改", {
        confirmButtonText: "放弃修改",
        cancelButtonText: "继续编辑",
        type: "warning",
      });
      return true;
    } catch {
      return false;
    }
  }
  onBeforeRouteLeave(discard);
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (dirty() || scope.state.busy) {
      event.preventDefault();
      event.returnValue = "";
    }
  };
  window.addEventListener("beforeunload", beforeUnload);
  onBeforeUnmount(() => {
    window.removeEventListener("beforeunload", beforeUnload);
    scope.dispose();
  });
  return { scope, discard };
}
/** 确认启停、清空等具体影响，取消时不发请求。 */
async function confirmManagement(message: string, title: string): Promise<boolean> {
  try {
    await ElMessageBox.confirm(message, title, {
      confirmButtonText: "确认",
      cancelButtonText: "取消",
      type: "warning",
    });
    return true;
  } catch {
    return false;
  }
}
export { useManagementPage, confirmManagement };
