/** A model file the designer can re-read and overwrite. The store checks the on-disk revision before every write. */
export interface ModelFile {
  readonly name: string;
  read(): Promise<string>;
  write(text: string): Promise<void>;
}

// The File System Access API is not in TypeScript's DOM library; only the members used here are declared.
interface WritableStream {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}
interface FileHandle {
  readonly name: string;
  getFile(): Promise<{ text(): Promise<string> }>;
  createWritable(): Promise<WritableStream>;
}
type OpenPicker = (options: { types: { description: string; accept: Record<string, string[]> }[]; multiple: false }) => Promise<FileHandle[]>;

function picker(): OpenPicker | null {
  const p = (globalThis as { showOpenFilePicker?: OpenPicker }).showOpenFilePicker;
  return typeof p === 'function' ? p : null;
}

/** True when the browser can reopen and overwrite the file it opened; otherwise saving falls back to a download. */
export function persistentFilesAvailable(): boolean {
  return picker() !== null;
}

/** Ask the user for a model file through the File System Access API; null when they cancel or the API is absent. */
export async function pickModelFile(): Promise<ModelFile | null> {
  const open = picker();
  if (!open) return null;
  let handles: FileHandle[];
  try {
    handles = await open({ types: [{ description: 'Loom model', accept: { 'application/json': ['.json'] } }], multiple: false });
  } catch {
    return null;
  }
  const handle = handles[0];
  if (!handle) return null;
  return {
    name: handle.name,
    read: async () => (await handle.getFile()).text(),
    write: async (text) => {
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
    },
  };
}
