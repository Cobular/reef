/**
 * Pipes `body` through a native FixedLengthStream so R2 gets a stream of known length.
 *
 * No JavaScript touches the chunks: a JS TransformStream here cost ~1.4 s of CPU per 90 MiB part
 * in production. The runtime already enforces Content-Length framing on request bodies, and the
 * caller has checked Content-Length equals the declared size, so FixedLengthStream erroring on a
 * short or long body is a backstop. Nothing is buffered whole.
 */
export function fixedLengthBody(
  body: ReadableStream<Uint8Array> | null,
  expected: number,
): ReadableStream<Uint8Array> {
  const source =
    body ??
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
  return source.pipeThrough(new FixedLengthStream(expected));
}
