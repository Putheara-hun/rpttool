import { createApp } from 'vue';
import ViewerApp from './ViewerApp.vue';
import { state } from '../store/designer';
import '../styles.css';
import './viewer.css';

// the viewer never edits: no autosave of "unsaved work" into this browser (it would replace the designer's)
state.embedded = true;
state.viewer = true;
state.mode = 'preview';

// the host application's interface fonts (the report itself loads the fonts it uses)
const fonts = document.createElement('link');
fonts.rel = 'stylesheet';
fonts.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+Khmer:wght@400;500;600;700&display=swap';
document.head.appendChild(fonts);

createApp(ViewerApp).mount('#app');
