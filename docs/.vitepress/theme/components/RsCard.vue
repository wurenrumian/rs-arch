<script setup lang="ts">
import { withBase } from 'vitepress'

defineProps<{
  to: string
  title: string
  label?: string
}>()
</script>

<template>
  <a class="rs-card" :href="withBase(to)">
    <span v-if="label" class="rs-n">{{ label }}</span>
    <h3>{{ title }}</h3>
    <p><slot /></p>
  </a>
</template>
