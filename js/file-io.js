// Saving text files to the user's computer, whichever way this page allows:
//
// 1. a file handle from an earlier save (Save writes to the same file again),
// 2. the browser's Save dialog (File System Access API: Chrome and Edge),
// 3. the claude.ai viewer's download capability, when the page runs as an
//    artifact (its frame blocks the other methods),
// 4. a plain download (Firefox, Safari).

let downloadsPromise = null;

function downloadsCapability() {
  if (!downloadsPromise) {
    const use = window.claude?.use;
    downloadsPromise = (typeof use === 'function' ? use.call(window.claude, 'downloads') : Promise.resolve(null))
      .catch(() => null);
  }
  return downloadsPromise;
}

// Start looking up the download capability early, so the first save isn't slowed.
export function prepareSaving() {
  downloadsCapability();
}

const inFrame = (() => {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
})();

// Can Save write straight back to the last file without asking?
export const canSaveInPlace = !inFrame && typeof window.showSaveFilePicker === 'function';

/**
 * Save a file. Resolves to { status: 'saved' | 'downloaded' | 'cancelled', name, handle }.
 *   data           text, or bytes (Uint8Array) for a zip
 *   filename       suggested name
 *   frameFilename  name to use with the claude.ai download capability, which
 *                  only accepts some extensions (e.g. not .tps)
 *   handle         a handle from an earlier save, to overwrite that file
 *   types          file types for the Save dialog
 */
export async function saveFile({ filename, data, frameFilename = filename, handle = null, types }) {
  if (handle) {
    try {
      await writeHandle(handle, data);
      return { status: 'saved', name: handle.name, handle };
    } catch (err) {
      if (err?.name === 'AbortError') return { status: 'cancelled' };
      // Permission lost or file gone: fall through and ask again.
    }
  }

  if (canSaveInPlace) {
    try {
      const h = await window.showSaveFilePicker({ suggestedName: filename, types });
      await writeHandle(h, data);
      return { status: 'saved', name: h.name, handle: h };
    } catch (err) {
      if (err?.name === 'AbortError') return { status: 'cancelled' };
    }
  }

  const downloads = await downloadsCapability();
  if (downloads) {
    try {
      await downloads.save({ filename: frameFilename, data });
      return { status: 'downloaded', name: frameFilename };
    } catch (err) {
      if (err?.code === 'declined') return { status: 'cancelled' };
      if (err?.code === 'rate_limited') throw new Error('A save is already waiting for your answer. Finish that one first.');
      // Anything else: try a plain download below.
    }
  }

  const type = typeof data === 'string' ? 'text/plain;charset=utf-8' : 'application/octet-stream';
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return { status: 'downloaded', name: filename };
}

async function writeHandle(handle, data) {
  const w = await handle.createWritable();
  await w.write(data);
  await w.close();
}
