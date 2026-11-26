<script setup lang="ts">
import { RouterView } from 'vue-router';
</script>

<template>
  <RouterView :key="$route.name === 'owner-report-edit' ? String($route.params.reportKey) : $route.name === 'owner-report-new' ? $route.fullPath : undefined" />
</template>
