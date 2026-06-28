import { createApp } from 'vue';
import App from './App.vue';

// Minimal shadow-DOM fixture for Phase 5 (Shadow DOM support) E2E coverage —
// a plain custom element with an open shadow root containing a button, so
// the toolbar's hover/click/hit-test logic has something to pierce.
class TianDemoWidget extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>button { padding: 6px 12px; border-radius: 6px; border: 1px solid #d4d4d8; background: #fff; cursor: pointer; }</style>
      <button class="shadow-btn">Inside shadow DOM</button>
    `;
  }
}
if (!customElements.get('tian-demo-widget')) {
  customElements.define('tian-demo-widget', TianDemoWidget);
}

createApp(App).mount('#app');
