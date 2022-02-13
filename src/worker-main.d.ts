// These interfaces and functions are only used by worker-main.test.ts, as
// worker-main.js has its own entrypoint outside of testing.
interface RequestMessage {
  id: number;
  modulePath: string;
  functionName: string;
  args?: any[];
}

interface ReplyMessage {
  id: number;
  result?: any;
  err?: Error;
}

export function handleRequest(message: RequestMessage);
export function onSend(handler: (message: ReplyMessage) => void);
