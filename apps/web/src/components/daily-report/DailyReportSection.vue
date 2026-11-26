<script setup lang="ts">
defineProps<{
  title: string;
}>();
</script>

<template>
  <section class="block">
    <slot name="before-title" />
    <h3 class="block-title">{{ title }}</h3>
    <slot />
  </section>
</template>

<style scoped>
.block {
  padding: 16px;
  border: 1px solid var(--fs-border, var(--el-border-color));
  border-radius: var(--fs-radius-md, 10px);
  background: var(--fs-surface-elevated, var(--el-bg-color));
  box-shadow: none;
}

.block-title {
  margin: 0 0 12px;
  font-size: 14px;
  font-weight: 700;
  color: var(--fs-ink, var(--el-text-color-primary));
}
@media (max-width: 640px) {
  .block { padding: 12px; }
  .block-title { margin-bottom: 10px; }
}
</style>
