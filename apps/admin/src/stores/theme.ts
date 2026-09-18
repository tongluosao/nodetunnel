import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';

/**
 * 主题（深浅色）。
 *
 * 支持「跟随系统」与手动固定两种模式：手动选择必须能覆盖系统偏好，
 * 否则用户在浅色系统上无法使用深色界面。选择持久化到 localStorage，
 * 刷新后保持。
 *
 * 真正的生效方式是给 <html> 打 data-theme：CSS 变量与 Ant Design 的
 * algorithm 都以它为唯一依据，避免两套主题状态各自为政。
 */

export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

/** 与 index.html 内联脚本共用同一个键，否则首屏会闪一下再变色。 */
const STORAGE_KEY = 'nt-theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function readStoredMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') {
      return saved;
    }
  } catch {
    // 隐私模式等场景下 localStorage 可能不可用，回退到跟随系统。
  }
  return 'system';
}

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia(DARK_QUERY).matches;
  } catch {
    return true;
  }
}

export const useThemeStore = defineStore('theme', () => {
  const mode = ref<ThemeMode>(readStoredMode());
  const systemDark = ref(systemPrefersDark());

  const resolved = computed<ResolvedTheme>(() => {
    if (mode.value === 'system') {
      return systemDark.value ? 'dark' : 'light';
    }
    return mode.value;
  });

  /** 把解析结果写到 <html>，CSS 变量与 Ant Design 都以它为准。 */
  function apply(): void {
    document.documentElement.dataset.theme = resolved.value;
  }

  function setMode(next: ThemeMode): void {
    mode.value = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // 存不下也不影响本次会话生效。
    }
  }

  // 系统偏好变化时，仅在「跟随系统」模式下才需要重新解析。
  try {
    window.matchMedia(DARK_QUERY).addEventListener('change', (event) => {
      systemDark.value = event.matches;
    });
  } catch {
    // 老浏览器不支持 addEventListener，退化为不跟随系统实时变化。
  }

  watch(resolved, apply, { immediate: true });

  return { mode, resolved, setMode };
});
