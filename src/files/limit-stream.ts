/** Byte counter that cuts off a body that is longer or shorter than declared. */
export interface LengthGuard {
  readonly expected: number;
  seen: number;
  /** Set when the body ran past `expected`; the upload is refused with 413. */
  overflow: boolean;
  /** Set when the body ended before `expected`; the upload is refused with 400. */
  underflow: boolean;
}

export function newLengthGuard(expected: number): LengthGuard {
  return { expected, seen: 0, overflow: false, underflow: false };
}

/**
 * Streams `body` through a counting TransformStream into a FixedLengthStream, so R2 receives a
 * stream of known length and nothing is ever buffered whole. A body that lies about its length
 * errors the stream, which makes the R2 write fail; `guard` records why.
 */
export function limitBody(
  body: ReadableStream<Uint8Array> | null,
  guard: LengthGuard,
): ReadableStream<Uint8Array> {
  const source =
    body ??
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      guard.seen += chunk.byteLength;
      if (guard.seen > guard.expected) {
        guard.overflow = true;
        controller.error(new Error("body longer than declared"));
        return;
      }
      controller.enqueue(chunk);
    },
    flush(controller) {
      if (guard.seen < guard.expected) {
        guard.underflow = true;
        controller.error(new Error("body shorter than declared"));
      }
    },
  });
  return source.pipeThrough(counter).pipeThrough(new FixedLengthStream(guard.expected));
}
