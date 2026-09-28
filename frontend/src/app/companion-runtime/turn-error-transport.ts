import { DefaultChatTransport, type UIMessage, type UIMessageChunk } from 'ai';

type SendMessagesOptions = Parameters<DefaultChatTransport<UIMessage>['sendMessages']>[0];

export type ReportTurnError = (messageId: string | null, errorText: string) => void;

/**
 * Reports each turn's terminal error together with the id of the message that
 * started it. The AI SDK resolves sendMessage even when a turn ends in error,
 * so a caller that must know whether its own turn failed looks it up by the
 * message id it sent. Chunks and errors still flow to the SDK unchanged.
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
      report?.(messageId, error instanceof Error ? error.message : '');
      throw error;
    }
    if (!report) return stream;
    return stream.pipeThrough(new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        if (chunk.type === 'error') report(messageId, chunk.errorText);
        controller.enqueue(chunk);
      },
    }));
  }
}
