<script setup lang="ts">
import { ElForm, ElFormItem, ElInput, ElSelect, ElOption } from "element-plus";
import type { CreateManagedUser, UserAssignmentOptions } from "@ai-data/contracts";
const draft = defineModel<CreateManagedUser>({ required: true });
defineProps<{ options: UserAssignmentOptions; disabled: boolean }>();
</script>
<template>
  <ElForm label-position="top" :disabled="disabled" @submit.prevent
    ><div class="management-form-grid">
      <ElFormItem label="登录名" required
        ><ElInput v-model="draft.username" maxlength="256" autocomplete="off" /></ElFormItem
      ><ElFormItem label="显示名称" required
        ><ElInput v-model="draft.display_name" maxlength="256" /></ElFormItem
      ><ElFormItem label="初始密码" required class="wide"
        ><ElInput
          v-model="draft.password"
          type="password"
          autocomplete="new-password"
          maxlength="1024"
        />
        <p class="management-help">至少 8 个字符。创建后仅返回账号资料。</p></ElFormItem
      ><ElFormItem label="已有角色" class="wide"
        ><ElSelect
          v-model="draft.role_ids"
          multiple
          filterable
          placeholder="选择服务器允许分配的角色"
          ><ElOption
            v-for="role in options.roles"
            :key="role.id"
            :label="`${role.name} · ${role.code}${role.is_privileged ? ' · 管理权限' : ''}`"
            :value="role.id" /></ElSelect></ElFormItem
      ><ElFormItem label="个人例外范围" class="wide"
        ><ElSelect
          v-model="draft.exception_data_scope_ids"
          multiple
          filterable
          placeholder="选择已有范围"
          ><ElOption
            v-for="item in options.exception_data_scopes"
            :key="item.id"
            :label="`${item.resource}.${item.field} ${item.operator} ${item.value}`"
            :value="item.id"
        /></ElSelect>
        <p class="management-help">个人例外属于强制数据限制，会进一步收窄访问范围。</p></ElFormItem
      >
    </div></ElForm
  >
</template>
