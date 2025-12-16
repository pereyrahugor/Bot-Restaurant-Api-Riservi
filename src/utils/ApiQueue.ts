// src/utils/ApiQueue.ts
// Utilidad para gestionar colas por endpoint en TypeScript


export type ApiQueueResult<R> = { response: R; threadId: string };
export type ApiRequest<T, R> = {
  data: T;
  threadId: string;
  resolve: (result: ApiQueueResult<R>) => void;
  reject: (error: any) => void;
};

export class ApiQueue<T, R> {
  private queue: ApiRequest<T, R>[] = [];
  private processing = false;
  private endpoint: (data: T) => Promise<R>;

  constructor(endpoint: (data: T) => Promise<R>) {
    this.endpoint = endpoint;
  }

  enqueue(data: T, threadId: string): Promise<ApiQueueResult<R>> {
    return new Promise((resolve, reject) => {
      this.queue.push({ data, threadId, resolve, reject });
      this.processNext();
    });
  }

  private async processNext() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;
    const { data, threadId, resolve, reject } = this.queue.shift()!;
    try {
      const response = await this.endpoint(data);
      resolve({ response, threadId });
    } catch (error) {
      reject(error);
    } finally {
      this.processing = false;
      this.processNext();
    }
  }
}
