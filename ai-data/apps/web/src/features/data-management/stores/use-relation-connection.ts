import { ref, type Ref } from "vue";
import type { Connection, FlowEvents } from "@vue-flow/core";
/** 拖到已有对象直接配置，拖到空白处在松手位置选择目标对象。 */
export function useRelationConnection(
  root: Ref<HTMLElement | undefined>,
  locked: () => boolean,
  connect: (connection: Connection, point?: { x: number; y: number }) => void,
) {
  const menu = ref<{ source: string; x: number; y: number; point: { x: number; y: number } }>();
  let origin = "",
    connected = false;
  function close() {
    menu.value = undefined;
  }
  function open(source: string, event?: MouseEvent | TouchEvent) {
    if (locked()) return;
    const bounds = root.value?.getBoundingClientRect();
    const cursor = event && ("changedTouches" in event ? event.changedTouches[0] : event);
    const point = {
      x: cursor && bounds ? cursor.clientX - bounds.left : 300,
      y: cursor && bounds ? cursor.clientY - bounds.top : 120,
    };
    menu.value = {
      source,
      point,
      x: Math.max(12, Math.min(point.x, (bounds?.width ?? 800) - 354)),
      y: Math.max(12, Math.min(point.y, (bounds?.height ?? 700) - 440)),
    };
  }
  function start(event: FlowEvents["connectStart"]) {
    close();
    origin = event.handleType === "source" ? (event.nodeId ?? "") : "";
    connected = false;
  }
  function complete(connection: Connection) {
    connected = true;
    if (!locked()) connect(connection);
  }
  function end(event: FlowEvents["connectEnd"]) {
    if (
      !connected &&
      origin &&
      event?.target instanceof Element &&
      event.target.classList.contains("vue-flow__pane")
    )
      open(origin, event);
    origin = "";
  }
  function choose(target: string) {
    if (!menu.value || locked()) return;
    const { source, point } = menu.value;
    close();
    connect({ source, target, sourceHandle: null, targetHandle: null }, point);
  }
  function paneDown(event: PointerEvent) {
    if (event.target instanceof Element && event.target.classList.contains("vue-flow__pane"))
      close();
  }
  return { menu, close, open, start, complete, end, choose, paneDown };
}
