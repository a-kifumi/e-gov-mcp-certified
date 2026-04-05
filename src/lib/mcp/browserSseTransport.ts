import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

type MessageHandler = (message: JSONRPCMessage) => void;
type ErrorHandler = (error: Error) => void;
type CloseHandler = () => void;

export class BrowserSseTransport {
  private endpoint?: URL;
  private abortController?: AbortController;
  private protocolVersion?: string;
  private streamPromise?: Promise<void>;
  private closed = false;

  onmessage?: MessageHandler;
  onerror?: ErrorHandler;
  onclose?: CloseHandler;

  constructor(private readonly url: URL) {}

  async start(): Promise<void> {
    if (this.streamPromise) {
      throw new Error('BrowserSseTransport already started');
    }

    this.abortController = new AbortController();
    this.closed = false;

    let endpointResolved = false;
    let resolveEndpoint!: () => void;
    let rejectEndpoint!: (error: Error) => void;

    const endpointReady = new Promise<void>((resolve, reject) => {
      resolveEndpoint = resolve;
      rejectEndpoint = reject;
    });

    this.streamPromise = this.consumeStream(resolveEndpoint, (error) => {
      if (!endpointResolved) {
        rejectEndpoint(error);
      }
      this.onerror?.(error);
    });

    try {
      await endpointReady;
      endpointResolved = true;
    } catch (error) {
      this.streamPromise = undefined;
      throw error;
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.endpoint) {
      throw new Error('SSE endpoint not established');
    }

    const headers = new Headers({
      'content-type': 'application/json',
    });

    if (this.protocolVersion) {
      headers.set('mcp-protocol-version', this.protocolVersion);
    }

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(message),
      signal: this.abortController?.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`POST ${this.endpoint.pathname} failed (${response.status}): ${text}`);
    }
  }

  async close(): Promise<void> {
    this.abortController?.abort();
    this.endpoint = undefined;
    this.streamPromise = undefined;
    this.emitClose();
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }

  private async consumeStream(
    onEndpoint: () => void,
    onError: (error: Error) => void,
  ): Promise<void> {
    try {
      const response = await fetch(this.url, {
        headers: {
          Accept: 'text/event-stream',
        },
        signal: this.abortController?.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`SSE connection failed (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let eventName = 'message';
      let dataLines: string[] = [];

      const flushEvent = () => {
        const data = dataLines.join('\n');
        if (!data) {
          eventName = 'message';
          dataLines = [];
          return;
        }

        try {
          if (eventName === 'endpoint') {
            this.endpoint = new URL(data, this.url);
            onEndpoint();
          } else if (eventName === 'message') {
            const message = JSON.parse(data) as JSONRPCMessage;
            this.onmessage?.(message);
          }
        } catch (error) {
          onError(error instanceof Error ? error : new Error(String(error)));
        }

        eventName = 'message';
        dataLines = [];
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventName = line.slice('event:'.length).trim();
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice('data:'.length).trimStart());
          } else if (line === '') {
            flushEvent();
          }
        }
      }

      if (buffer.length > 0 || dataLines.length > 0) {
        flushEvent();
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }

      onError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.emitClose();
    }
  }

  private emitClose(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.onclose?.();
  }
}
