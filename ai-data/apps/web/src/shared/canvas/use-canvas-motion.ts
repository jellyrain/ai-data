import { ref } from "vue";

const preferenceKey = "ai-data.canvas-motion";
const enabled = ref(true);
let initialized = false;
/** 两处画布共用本浏览器的连线动效偏好；存储受限时仍可在本次会话切换。 */
function useCanvasMotion() {
  if (!initialized) {
    initialized = true;
    try {
      enabled.value = localStorage.getItem(preferenceKey) !== "off";
    } catch {
      /* 使用默认动效。 */
    }
  }
  function toggle() {
    enabled.value = !enabled.value;
    try {
      localStorage.setItem(preferenceKey, enabled.value ? "on" : "off");
    } catch {
      /* 内存偏好仍生效。 */
    }
  }
  return { enabled, toggle };
}
export { useCanvasMotion };
