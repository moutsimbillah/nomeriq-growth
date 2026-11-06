/**
 * A JSON response with whitespace heartbeats while a slow, read-only AI action runs. JSON permits
 * leading whitespace; existing clients can keep using response.json(). X-Accel-Buffering disables
 * proxy buffering for this response so a proxy's idle timeout does not cut off full-context calls.
 */
export function keepAliveJson(work: () => Promise<unknown>, onError: (error: unknown) => Promise<unknown>): Response {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("\n"));
      timer = setInterval(() => {
        if (!cancelled) controller.enqueue(encoder.encode("\n"));
      }, 15_000);
      void (async () => {
        let payload: unknown;
        try { payload = await work(); }
        catch (error) { payload = await onError(error); }
        finally { clearInterval(timer); }
        if (cancelled) return;
        controller.enqueue(encoder.encode(JSON.stringify(payload)));
        controller.close();
      })().catch(() => {
        clearInterval(timer);
        if (!cancelled) {
          controller.enqueue(encoder.encode(JSON.stringify({ ok: false, error: "The AI request could not complete. Please retry." })));
          controller.close();
        }
      });
    },
    cancel() { cancelled = true; clearInterval(timer); },
  });
  return new Response(stream, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}
