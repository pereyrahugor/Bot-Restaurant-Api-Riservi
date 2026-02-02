export class WebChatSession {
  public history: { role: string, content: string }[] = [];
  public thread_id: string | null = null;
  public data: any = {};

  addUserMessage(msg: string) {
    if (!this.history.length || this.history[this.history.length - 1].content !== msg) {
      this.history.push({ role: 'user', content: msg });
    }
  }

  addAssistantMessage(msg: string) {
    if (!this.history.length || this.history[this.history.length - 1].content !== msg) {
      this.history.push({ role: 'assistant', content: msg });
    }
  }

  get(key: string) {
    if (key === 'history') return this.history;
    if (key === 'thread_id') return this.thread_id;
    return this.data[key];
  }

  async update(obj: any) {
    if (typeof obj === 'object') {
      if (obj.thread_id) this.thread_id = obj.thread_id;
      Object.assign(this.data, obj);
    }
  }

  clear() {
    this.history = [];
    this.thread_id = null;
    this.data = {};
  }
}