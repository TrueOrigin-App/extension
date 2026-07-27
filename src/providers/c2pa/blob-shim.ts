// @contentauth/c2pa-wasm reads asset bytes through FileReaderSync and
// Blob.slice — APIs that exist only in dedicated/shared workers, which an MV3
// service worker cannot spawn (the service worker spec forbids nested
// workers). Providers always hold the full bytes already, so a byte-backed
// stand-in gives the WASM the same synchronous random access with no worker.
// See DECISIONS.md (task 3) for the full rationale and rejected alternatives.
//
// The WASM touches exactly three members of the blob it is given: `size`,
// `slice(start, end)`, and `FileReaderSync#readAsArrayBuffer(blob)`. If an
// SDK upgrade starts using more of the Blob surface, the provider's
// integration tests (which run the real WASM) fail loudly.

export class ByteBlob {
  readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get size(): number {
    return this.bytes.length;
  }

  get type(): string {
    return "";
  }

  slice(start?: number, end?: number): ByteBlob {
    return new ByteBlob(this.bytes.subarray(start, end));
  }
}

class FileReaderSyncShim {
  readAsArrayBuffer(blob: unknown): ArrayBuffer {
    if (!(blob instanceof ByteBlob)) {
      throw new TypeError(
        "FileReaderSync shim can only read ByteBlob instances",
      );
    }
    const out = new ArrayBuffer(blob.bytes.length);
    new Uint8Array(out).set(blob.bytes);
    return out;
  }
}

/** Installs the FileReaderSync polyfill if the environment lacks it (MV3
 * service worker, Node). A real worker's native implementation is left
 * untouched. */
export function installFileReaderSyncShim(): void {
  const globals = globalThis as { FileReaderSync?: unknown };
  globals.FileReaderSync ??= FileReaderSyncShim;
}
