import { onBeforeUnmount, onMounted, ref, type Ref } from "vue";
import { useVueFlow } from "@vue-flow/core";

/** Ctrl + 左键优先平移视口，节点拖动、框选与右键菜单各自保持独立。 */
function useCanvasNavigation(root: Ref<HTMLElement | undefined>) {
  const { viewport, setViewport } = useVueFlow();
  const panning = ref(false);
  let gesture:
    | {
        id: number;
        x: number;
        y: number;
        viewX: number;
        viewY: number;
        zoom: number;
        moved: boolean;
      }
    | undefined;
  let suppressClick = false;
  function canvasTarget(event: Event) {
    return (
      event.target instanceof Element &&
      !!event.target.closest(".vue-flow") &&
      !event.target.closest("input, textarea, select, button, a, [contenteditable='true']")
    );
  }
  function down(event: PointerEvent) {
    // 新手势开始时清理上次拖动的点击屏蔽。
    suppressClick = false;
    if (!canvasTarget(event) || !(event.button === 0 && event.ctrlKey)) return;
    gesture = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      viewX: viewport.value.x,
      viewY: viewport.value.y,
      zoom: viewport.value.zoom,
      moved: false,
    };
    event.preventDefault();
    event.stopImmediatePropagation();
    root.value?.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent) {
    if (!gesture || gesture.id !== event.pointerId) return;
    const dx = event.clientX - gesture.x,
      dy = event.clientY - gesture.y;
    if (!gesture.moved && Math.hypot(dx, dy) < 4) return;
    gesture.moved = true;
    panning.value = true;
    event.preventDefault();
    event.stopImmediatePropagation();
    void setViewport({ x: gesture.viewX + dx, y: gesture.viewY + dy, zoom: gesture.zoom });
  }
  function finish() {
    const old = gesture;
    gesture = undefined;
    panning.value = false;
    if (old?.moved) suppressClick = true;
    if (old && root.value?.hasPointerCapture(old.id)) root.value.releasePointerCapture(old.id);
  }
  function up(event: PointerEvent) {
    if (!gesture || gesture.id !== event.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    finish();
  }
  function mouseDown(event: MouseEvent) {
    if (!gesture) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  function click(event: MouseEvent) {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  onMounted(() => window.addEventListener("blur", finish));
  onBeforeUnmount(() => {
    finish();
    window.removeEventListener("blur", finish);
  });
  return { panning, down, move, up, finish, mouseDown, click };
}
export { useCanvasNavigation };
