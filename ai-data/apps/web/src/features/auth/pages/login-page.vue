<script setup lang="ts">
import { reactive, ref } from "vue";
import { useRouter, useRoute } from "vue-router";
import { ElForm, ElFormItem, ElInput, ElButton, ElAlert, type FormInstance } from "element-plus";
import {
  ChartNoAxesCombined,
  ArrowRight,
  Database,
  ChartColumnIncreasing,
  BookOpen,
} from "lucide-vue-next";
import { useServices } from "../../../app/services";
import { safeReturnPath } from "../../../app/router";
import AppearancePicker from "../../../shared/ui/appearance-picker.vue";
import { ApiError } from "../../../shared/http/api-error";

const { auth } = useServices();
const router = useRouter();
const route = useRoute();
const form = ref<FormInstance>();
const input = reactive({ username: "", password: "" });
const submitting = ref(false);
const error = ref<ApiError | null>(null);
const rules = {
  username: [{ required: true, whitespace: true, message: "请输入用户名", trigger: "blur" }],
  password: [{ required: true, message: "请输入密码", trigger: "blur" }],
};
async function submit() {
  if (submitting.value) return;
  if (!(await form.value?.validate().catch(() => false))) return;
  submitting.value = true;
  error.value = null;
  const returnTo = safeReturnPath(route.query.returnTo, router);
  try {
    await auth.login(input);
    input.password = "";
    await router.replace(returnTo);
  } catch (failure) {
    error.value = failure instanceof ApiError ? failure : new ApiError("登录失败，请稍后重试");
    input.password = "";
  } finally {
    submitting.value = false;
  }
}
</script>
<template>
  <div class="login-page">
    <header class="login-header">
      <a class="brand" href="/login" aria-label="AI Data 登录"
        ><span class="brand-mark"><ChartNoAxesCombined :size="22" aria-hidden="true" /></span
        ><span>AI Data</span></a
      ><AppearancePicker />
    </header>
    <main class="login-main">
      <section class="login-intro" aria-label="产品介绍">
        <p class="eyebrow">数据分析工作台</p>
        <h1>从问题出发，<br />让数据给出答案。</h1>
        <p class="intro-description">
          连接业务数据，沉淀分析成果。<br />让每一次探索，都成为下一次决策的依据。
        </p>
        <div class="intro-capabilities">
          <span><Database :size="17" aria-hidden="true" />业务数据</span
          ><span><ChartColumnIncreasing :size="17" aria-hidden="true" />分析报表</span
          ><span><BookOpen :size="17" aria-hidden="true" />企业知识</span>
        </div>
        <div class="intro-rule" aria-hidden="true">
          <i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i>
        </div>
      </section>
      <section class="login-form-panel" aria-labelledby="login-title">
        <p class="eyebrow">你的工作空间</p>
        <h2 id="login-title">欢迎回来</h2>
        <p class="login-description">使用组织账号登录，继续你的分析。</p>
        <ElAlert
          v-if="error"
          class="login-error"
          type="error"
          :closable="false"
          show-icon
          :title="error.message"
          ><span v-if="error.requestId" class="request-id"
            >请求编号：{{ error.requestId }}</span
          ></ElAlert
        >
        <ElForm
          ref="form"
          :model="input"
          :rules="rules"
          label-position="top"
          size="large"
          @submit.prevent="submit"
        >
          <ElFormItem label="用户名" prop="username"
            ><ElInput
              v-model="input.username"
              name="username"
              autocomplete="username"
              placeholder="请输入用户名"
              :disabled="submitting"
              maxlength="128"
          /></ElFormItem>
          <ElFormItem label="密码" prop="password"
            ><ElInput
              v-model="input.password"
              name="password"
              type="password"
              autocomplete="current-password"
              placeholder="请输入密码"
              show-password
              :disabled="submitting"
          /></ElFormItem>
          <ElButton
            type="primary"
            native-type="submit"
            size="large"
            class="login-submit"
            :loading="submitting"
            >{{ submitting ? "正在登录" : "登录工作台"
            }}<ArrowRight v-if="!submitting" :size="17" aria-hidden="true"
          /></ElButton>
        </ElForm>
        <p class="login-help">需要账号或重置密码？请联系组织管理员。</p>
      </section>
    </main>
    <footer class="login-footer"><span>AI Data</span><span>让业务与数据更近一步</span></footer>
  </div>
</template>
