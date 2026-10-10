import { DefaultChatTransport, type UIMessage, type UIMessageChunk } from 'ai';

type SendMessagesOptions = Parameters<DefaultChatTransport<UIMessage>['sendMessages']>[0];

/**
 * afterActivity is true when the turn may already have acted: it produced
 * output or tool/data events before failing, or its response broke while being
 * read after the request reached the backend.
 */
export type ReportTurnError = (messageId: string | null, errorText: string, afterActivity: boolean) => void;

const errorText = (error: unknown) => (error instanceof Error ? error.message : '');

// A user stop aborts the request; that is not a failed turn. Abort errors are
// DOMExceptions, which are not Error instances in every runtime.
const isAbort = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';

// Framing chunks (start, text-start, step markers, metadata, finish) carry no
// work. Anything else means the companion had started acting on the turn.
const isTurnActivity = (chunk: UIMessageChunk) =>
  (chunk.type === 'text-delta' && chunk.delta.length > 0)
  || chunk.type === 'reasoning-delta'
  || chunk.type === 'file'
  || chunk.type.startsWith('tool-')
  || chunk.type.startsWith('data-')
  || chunk.type.startsWith('source-');

/**
 * Reports each turn's terminal error together with the id of the message that
 * started it: a rejected request, an `error` chunk, or a failure while the
 * response is read (a broken body or an unparseable event). The AI SDK resolves
 * sendMessage in all of these cases, so a caller that must know whether its own
 * turn failed looks it up by the message id it sent. Chunks and errors still
 * reach the SDK unchanged.
 */
export class TurnErrorReportingChatTransport extends DefaultChatTransport<UIMessage> {
  private readonly reportTurnError: ReportTurnError | undefined;

  constructor(
    options: ConstructorParameters<typeof DefaultChatTransport<UIMessage>>[0],
    reportTurnError?: ReportTurnError,
  ) {
    super(options);
    this.reportTurnError = reportTurnError;
  }

  override async sendMessages(options: SendMessagesOptions): Promise<ReadableStream<UIMessageChunk>> {
    const report = this.reportTurnError;
    const messageId = options.messages[options.messages.length - 1]?.id ?? null;
    let stream: ReadableStream<UIMessageChunk>;
    try {
      stream = await super.sendMessages(options);
    } catch (error) {
      // Rejected before any response stream: nothing was streamed back.
      if (!isAbort(error)) report?.(messageId, errorText(error), false);
      throw error;
    }
    if (!report) return stream;
    const reader = stream.getReader();
    let sawActivity = false;
    return new ReadableStream<UIMessageChunk>({
      async pull(controller) {
        let result: ReadableStreamReadResult<UIMessageChunk>;
        try {
          result = await reader.read();
        } catch (error) {
          // The request reached the backend; what ran before the break is unknown.
          if (!isAbort(error)) report(messageId, errorText(error), true);
          controller.error(error);
          return;
        }
        if (result.done) {
          controller.close();
          return;
        }
        if (result.value.type === 'error') {
          report(messageId, result.value.errorText, sawActivity);
        } else if (isTurnActivity(result.value)) {
          sawActivity = true;
        }
        controller.enqueue(result.value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
  }
}
