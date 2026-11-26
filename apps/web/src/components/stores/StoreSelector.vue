<script setup lang="ts">
import { STORES, type StoreScope } from '@fsk/domain';
defineProps<{ modelValue: StoreScope; allowAll: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: StoreScope] }>();
</script>
<template>
  <el-select class="store-selector" :model-value="modelValue" aria-label="店舗" @update:model-value="emit('update:modelValue', $event)">
    <el-option v-if="allowAll" value="all" label="全店舗" />
    <el-option v-for="store in STORES" :key="store.id" :value="store.id" :label="store.name" />
  </el-select>
</template>
<style scoped>
.store-selector { width: 120px; flex-shrink: 0; }
</style>
