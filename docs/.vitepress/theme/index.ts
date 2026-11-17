import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import RsCard from './components/RsCard.vue'
import { setupDiagramZoom } from './diagram-zoom'
import './custom.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app, router }) {
    app.component('RsCard', RsCard)
    setupDiagramZoom(router)
  }
} satisfies Theme
