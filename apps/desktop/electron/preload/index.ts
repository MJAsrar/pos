import { contextBridge, ipcRenderer } from 'electron';

/**
 * The entire bridge between the page and the application.
 *
 * One function. The renderer has no database handle, no file system access and
 * no Node built-ins — it can only ask the main process to run a named operation,
 * which the main process validates and authorises before doing anything.
 */
const api = {
  call(op: string, payload?: unknown): Promise<unknown> {
    return ipcRenderer.invoke('pos:call', { op, payload });
  },
};

contextBridge.exposeInMainWorld('pos', api);

export type PosBridge = typeof api;
