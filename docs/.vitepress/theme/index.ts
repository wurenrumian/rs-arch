import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import RsCard from './components/RsCard.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('RsCard', RsCard)
  }
} satisfies Theme
