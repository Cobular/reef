import { bytesToBase64, bytesToHex } from "../lib/base64";

/** The caller's key does not match the key the object was encrypted with. Maps to 403. */
export class WrongKeyError extends Error {
  constructor() {
    super("wrong key");
    this.name = "WrongKeyError";
  }
}

export function objectKey(fileId: string): string {
  return `files/${fileId}`;
}

async function keyMd5Forms(key: ArrayBuffer): Promise<string[]> {
  const digest = new Uint8Array(await crypto.subtle.digest("MD5", key));
  return [bytesToHex(digest), bytesToBase64(digest)];
}

// R2 reports SSE-C problems as plain errors; these words appear in its SSE-C error messages.
const SSEC_ERROR = /ssec|sse-c|customer[- ]?(provided|key)|encryption key|key md5/i;

/**
 * Thin wrapper over the R2 binding. Every read and write passes the caller's key as an SSE-C
 * key, so R2 stores ciphertext and cannot return plaintext without the same key.
 */
export class Storage {
  constructor(private readonly bucket: R2Bucket) {}

  async put(fileId: string, body: ReadableStream | ArrayBuffer, key: ArrayBuffer): Promise<void> {
    await this.bucket.put(objectKey(fileId), body, { ssecKey: key });
  }

  async createMultipart(fileId: string, key: ArrayBuffer): Promise<string> {
    const upload = await this.bucket.createMultipartUpload(objectKey(fileId), { ssecKey: key });
    return upload.uploadId;
  }

  async uploadPart(
    fileId: string,
    uploadId: string,
    partNumber: number,
    body: ReadableStream,
    key: ArrayBuffer,
  ): Promise<string> {
    const upload = this.bucket.resumeMultipartUpload(objectKey(fileId), uploadId);
    try {
      const part = await upload.uploadPart(partNumber, body, { ssecKey: key });
      return part.etag;
    } catch (error) {
      if (error instanceof Error && SSEC_ERROR.test(error.message)) throw new WrongKeyError();
      throw error;
    }
  }

  async completeMultipart(
    fileId: string,
    uploadId: string,
    parts: R2UploadedPart[],
  ): Promise<void> {
    await this.bucket.resumeMultipartUpload(objectKey(fileId), uploadId).complete(parts);
  }

  async abortMultipart(fileId: string, uploadId: string): Promise<void> {
    try {
      await this.bucket.resumeMultipartUpload(objectKey(fileId), uploadId).abort();
    } catch {
      // Already completed, aborted or expired: nothing left to clean up.
    }
  }

  /**
   * Reads an object with the caller's key. Returns null if the object does not exist and throws
   * WrongKeyError if R2 refuses the key. The body is not read here, so the caller can still
   * cancel it.
   */
  async get(fileId: string, key: ArrayBuffer, range?: R2Range): Promise<R2ObjectBody | null> {
    const name = objectKey(fileId);
    try {
      const object = await this.bucket.get(
        name,
        range ? { ssecKey: key, range } : { ssecKey: key },
      );
      if (object === null) return null;
      if (!("body" in object)) throw new Error("R2 returned an object without a body");
      return object;
    } catch (error) {
      if (error instanceof WrongKeyError) throw error;
      // Work out whether the failure was the key: the stored object's key MD5 tells us.
      const head = await this.bucket.head(name).catch(() => undefined);
      if (head === null) return null;
      if (head?.ssecKeyMd5) {
        const forms = await keyMd5Forms(key);
        if (!forms.includes(head.ssecKeyMd5)) throw new WrongKeyError();
      } else if (error instanceof Error && SSEC_ERROR.test(error.message)) {
        throw new WrongKeyError();
      }
      throw error;
    }
  }

  async delete(fileIds: string[]): Promise<void> {
    for (let i = 0; i < fileIds.length; i += 1000) {
      await this.bucket.delete(fileIds.slice(i, i + 1000).map(objectKey));
    }
  }
}
