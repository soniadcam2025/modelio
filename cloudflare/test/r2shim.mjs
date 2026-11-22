// Minimal in-memory stand-in for an R2 bucket binding (head/get/put/delete/list), for tests.
export function makeR2() {
  const store = new Map();
  const obj = (key, v, range) => {
    const data = range ? v.data.slice(range.offset, range.length ? range.offset + range.length : undefined) : v.data;
    return { key, size: v.data.byteLength, uploaded: v.uploaded, httpMetadata: v.httpMetadata, customMetadata: v.customMetadata,
      range: range ? { offset: range.offset, length: data.byteLength } : undefined,
      body: new Blob([data]).stream(), arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
  };
  return {
    store,
    async head(k) { const v = store.get(k); return v ? obj(k, v) : null; },
    async get(k, o) { const v = store.get(k); return v ? obj(k, v, o?.range) : null; },
    async put(k, body, o = {}) {
      const data = typeof body === "string" ? new TextEncoder().encode(body) : body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body);
      store.set(k, { data: new Uint8Array(data), uploaded: new Date(), httpMetadata: o.httpMetadata || {}, customMetadata: o.customMetadata || {} });
    },
    async delete(k) { store.delete(k); },
    async list({ prefix = "", cursor } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0, page = keys.slice(start, start + 1000);
      return { objects: page.map((k) => obj(k, store.get(k))), truncated: start + 1000 < keys.length, cursor: String(start + 1000) };
    },
  };
}
export const JPEG = (n = 2000) => { const b = new Uint8Array(n); b.set([0xff, 0xd8, 0xff, 0xe0]); return b; };
export const MP4 = (n = 4000) => { const b = new Uint8Array(n); b.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]); return b; };
export const HEIC = () => { const b = new Uint8Array(100); b.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]); return b; };
