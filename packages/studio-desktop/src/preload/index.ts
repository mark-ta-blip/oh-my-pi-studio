import { contextBridge, ipcRenderer } from "electron";

const api = {
	openExternal: (url: string): Promise<void> => ipcRenderer.invoke("omp-studio:open-external", url),
	selectWorkspace: (): Promise<string | null> => ipcRenderer.invoke("omp-studio:select-workspace"),
	notify: (title: string, body: string): Promise<void> => ipcRenderer.invoke("omp-studio:notify", title, body),
};

contextBridge.exposeInMainWorld("ompStudio", api);
