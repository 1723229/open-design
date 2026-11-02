/** Bound streamed provider reads even when Content-Length is absent. */
export async function readProviderResponse(response: Response, signal: AbortSignal, maxBytes: number, consume: (text: string) => boolean): Promise<void> {
  if (!response.body) throw new Error('Missing body');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let bytes = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) { consume(decoder.decode()); break; }
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new Error('Response too large');
      if (consume(decoder.decode(chunk.value, { stream: true }))) break;
    }
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
