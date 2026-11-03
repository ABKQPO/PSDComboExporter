import './styles.css';
import { initLocale, onLocaleChange, setLocale, systemLocale, t } from './i18n';
import { mount, installGlobalDrop } from './ui/app';
import { importFile } from './ui/importPanel';
import { installDebugApi } from './debug';
import * as store from './ui/store';

initLocale();
setLocale(store.state.prefs.locale === 'auto' ? systemLocale() : store.state.prefs.locale);
document.title = t('app.name');
onLocaleChange(() => store.notify());

const el = document.getElementById('app');
if (!el) throw new Error('#app not found');

mount(el);
installGlobalDrop();

// Electron: files handed over by the OS ("Open with", second instance, menu)
const native = (window as any).psdExportNative;
if (native?.onOpenFile) {
  native.onOpenFile(async (payload: { name: string; data: ArrayBuffer | Uint8Array; error?: string }) => {
    if (payload.error) return store.toast(t('app.fileReadError', { error: payload.error }), 'bad');
    const bytes = payload.data instanceof Uint8Array ? payload.data : new Uint8Array(payload.data);
    await importFile(new File([bytes as BlobPart], payload.name, { type: 'image/vnd.adobe.photoshop' }));
  });
  native.ready?.();
}

// Android back button closes dialogs / the panel sheet before leaving the app
document.addEventListener('backbutton', () => {
  const s = store.state;
  if (s.editingOption || s.helpOpen) {
    s.editingOption = null;
    s.helpOpen = false;
  } else if (s.nodeEditorOpen) s.nodeEditorOpen = false;
  else if (s.sheetOpen) s.sheetOpen = false;
  store.notify();
});

const api = {
  importBuffer: async (name: string, data: ArrayBuffer) => {
    await importFile(new File([data], name, { type: 'image/vnd.adobe.photoshop' }));
    return { layers: store.state.project?.layers.length ?? 0, combos: store.state.result?.combos.length ?? 0 };
  },
  state: () => store.state,
};
(window as any).psdExportApp = api;
installDebugApi(api);
