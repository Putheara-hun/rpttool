import { createApp } from 'vue';
import ViewerApp from './ViewerApp.vue';
import { state } from '../store/designer';
import '../styles.css';

// the viewer never edits: no autosave of "unsaved work" into this browser (it would replace the designer's)
state.embedded = true;
state.viewer = true;
state.mode = 'preview';

createApp(ViewerApp).mount('#app');
