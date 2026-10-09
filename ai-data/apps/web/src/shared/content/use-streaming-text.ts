import { onBeforeUnmount, ref, watch } from "vue";

const catchUpMs = 200;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** 少量文字逐字显示，大批文字在短窗口内追上；结束时立即采用完整正文。 */
function useStreamingText(text: () => string, streaming: () => boolean | undefined) {
  const visible = ref(streaming() ? "" : text());
  const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  let target = "";
  let pending: string[] = [];
  let position = 0;
  let frame: number | undefined;
  let lastFrame = 0;
  let deadline = 0;

  function cancel() {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    pending = [];
    position = 0;
  }
  function finish() {
    cancel();
    target = text();
    visible.value = target;
  }
  function reveal(now: number) {
    frame = undefined;
    const elapsed = Math.max(1, now - lastFrame);
    const remaining = pending.length - position;
    const count = Math.min(
      remaining,
      Math.max(1, Math.ceil((remaining * elapsed) / Math.max(elapsed, deadline - lastFrame))),
    );
    visible.value += pending.slice(position, position + count).join("");
    position += count;
    lastFrame = now;
    if (position < pending.length) frame = requestAnimationFrame(reveal);
    else cancel();
  }
  function update() {
    const next = text();
    if (!streaming() || motion?.matches || document.hidden || !next.startsWith(target)) {
      finish();
      return;
    }
    target = next;
    pending = Array.from(
      segmenter.segment(next.slice(visible.value.length)),
      (part) => part.segment,
    );
    position = 0;
    if (!pending.length) {
      cancel();
      return;
    }
    if (frame === undefined) {
      lastFrame = performance.now();
      deadline = lastFrame + catchUpMs;
      frame = requestAnimationFrame(reveal);
    }
  }

  watch(() => [text(), streaming()] as const, update, { immediate: true });
  motion?.addEventListener("change", update);
  document.addEventListener("visibilitychange", update);
  onBeforeUnmount(() => {
    cancel();
    motion?.removeEventListener("change", update);
    document.removeEventListener("visibilitychange", update);
  });
  return visible;
}

export { useStreamingText };
