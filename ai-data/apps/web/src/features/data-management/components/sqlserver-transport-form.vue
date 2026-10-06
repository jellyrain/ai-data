<script setup lang="ts">
import { ElFormItem, ElSwitch } from "element-plus";
import "element-plus/theme-chalk/el-switch.css";
import type { SqlServerTransport } from "@ai-data/contracts";
const model = defineModel<SqlServerTransport>({ required: true });
</script>
<template>
  <div class="management-form-grid">
    <ElFormItem label="加密连接">
      <ElSwitch v-model="model.encrypt" aria-label="加密连接" />
      <p class="management-help">请求加密连接；服务器也可能要求强制加密。</p>
    </ElFormItem>
    <ElFormItem label="信任服务器证书">
      <ElSwitch v-model="model.trust_server_certificate" aria-label="信任服务器证书" />
      <p class="management-help">开启后跳过服务器证书校验，可用于自签名证书连接。</p>
    </ElFormItem>
  </div>
</template>
