import Antd from 'ant-design-vue';
import { createPinia } from 'pinia';
import { createApp } from 'vue';

import App from './App.vue';
import { router } from './router';
import './styles/global.css';

/**
 * 管理后台入口。
 *
 * 使用 Ant Design Vue 提供组件与主题；Pinia 管理会话状态；
 * Vue Router 负责首次初始化/登录的导航守卫。
 */
createApp(App).use(createPinia()).use(router).use(Antd).mount('#app');
