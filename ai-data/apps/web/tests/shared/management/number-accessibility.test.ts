import { mount } from "@vue/test-utils";
import { ElForm, ElInputNumber } from "element-plus";
import { defineComponent, ref } from "vue";
import { describe, expect, it } from "vitest";
import { vNumberAccessibility } from "../../../src/shared/management/number-accessibility";

describe("管理数字输入的无障碍状态", () => {
  it("表单加载结束后同步可用状态与模型版本上限", async () => {
    const wrapper = mount(
      defineComponent({
        components: { ElForm, ElInputNumber },
        directives: { numberAccessibility: vNumberAccessibility },
        props: { disabled: Boolean, max: { type: Number, default: 1 } },
        setup: () => ({ value: ref(1) }),
        template:
          '<ElForm :disabled="disabled"><ElInputNumber v-model="value" v-number-accessibility :min="1" :max="max" /></ElForm>',
      }),
      { props: { disabled: true, max: 1 } },
    );
    await wrapper.setProps({ disabled: false, max: 2 });
    expect(wrapper.get("input").attributes("aria-disabled")).toBe("false");
    expect(wrapper.get("input").attributes("aria-valuemax")).toBe("2");
    wrapper.unmount();
  });
});
