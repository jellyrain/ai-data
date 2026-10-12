import { ref, type Ref } from "vue";
/** 从空白、节点或连线定位菜单上下文，字段输入保留浏览器原生文本菜单。 */
function useCanvasMenu(root: Ref<HTMLElement | undefined>) {
  const current = ref<{ point: { x: number; y: number }; node?: string; edge?: string }>();
  function open(event: MouseEvent) {
    const target = event.target;
    if (
      !(target instanceof Element) ||
      !target.closest(".vue-flow") ||
      target.closest('input,textarea,[contenteditable="true"]')
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const bounds = root.value?.getBoundingClientRect();
    current.value = {
      point: {
        x: event.clientX || (bounds?.left ?? 0) + 40,
        y: event.clientY || (bounds?.top ?? 0) + 40,
      },
      node: target.closest(".vue-flow__node")?.getAttribute("data-id") ?? undefined,
      edge:
        target.closest("[data-edge-id]")?.getAttribute("data-edge-id") ??
        target.closest(".vue-flow__edge")?.getAttribute("data-id") ??
        undefined,
    };
  }
  function close() {
    current.value = undefined;
  }
  return { current, open, close };
}
export { useCanvasMenu };
