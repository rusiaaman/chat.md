// Fix type conflicts between @types/eventsource and @types/node
declare module 'eventsource' {
  interface EventSourceInit {
    withCredentials?: boolean;
    headers?: object;
    proxy?: string;
    https?: object;
    rejectUnauthorized?: boolean;
  }

  interface EventSource {
    readonly url: string;
    readonly readyState: number;
    readonly withCredentials: boolean;
    onopen: ((event: MessageEvent) => void) | null;
    onmessage: ((event: MessageEvent) => void) | null;
    onerror: ((event: Event & { message?: string }) => void) | null;
    addEventListener(type: string, listener: (event: MessageEvent) => void): void;
    removeEventListener(type: string, listener: (event: MessageEvent) => void): void;
    close(): void;
  }

  interface EventSourceConstructor {
    new (url: string, eventSourceInitDict?: EventSourceInit): EventSource;
    readonly CONNECTING: number;
    readonly OPEN: number;
    readonly CLOSED: number;
  }

  const EventSource: EventSourceConstructor;
  export = EventSource;
}
