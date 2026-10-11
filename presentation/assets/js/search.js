import {
  api,
  errorMessage,
  id,
  newKey
} from './api.js';

export class SceneSearch {
  constructor({
    onReset,
    onPage,
    onBusy,
    onError,
    onSession
  }) {
    Object.assign(this, {
      onReset,
      onPage,
      onBusy,
      onError,
      onSession
    });
  }

  async prepare(index) {
    if (this.session && this.index === index) return;
    this.reset();
    this.onReset();
    if (!index) return;
    const controller = new AbortController();
    this.controller = controller;
    try {
      await this.ensureSession(index, controller);
    } catch (error) {
      if (controller === this.controller && error.name !== 'AbortError') this.onError(errorMessage(error));
    }
  }

  async ensureSession(index, controller) {
    if (this.session && this.index === index) return;
    const session = await api('/search-sessions', {
      method: 'POST', body: {index_id: index, title: 'SceneSearch demo'}, signal: controller.signal
    });
    if (controller !== this.controller) return;
    this.session = session.session_id;
    this.index = index;
    this.onSession?.(session);
  }

  async query(text, index, filters = {}) {
    if (!index) return;
    text = text.trim();
    if (!text || text.length > 1000) {
      this.onError('Nhập mô tả từ 1 đến 1.000 ký tự.');
      return;
    }
    this.stop();
    this.controller = new AbortController();
    const controller = this.controller;
    this.busy = true;
    this.run = null;
    this.cursor = null;
    this.onReset();
    this.onBusy(true);
    try {
      if (!this.session || this.index !== index) {
        this.session = null;
        this.onSession?.(null);
        await this.ensureSession(index, controller);
      }
      if (controller !== this.controller) return;
      const request = {
        index_id: index,
        query_text: text,
        request_key: newKey(),
        filters,
        page_size: 20
      };
      const page = await api(`/search-sessions/${id(this.session)}/runs`, {
        method: 'POST',
        body: request,
        signal: controller.signal
      });
      if (controller !== this.controller) return;
      this.run = page.run.run_id;
      await this.accept(page, controller, false);
    } catch (error) {
      if (controller === this.controller && error.name !== 'AbortError') {
        this.busy = false;
        this.onBusy(false);
        this.onError(errorMessage(error));
      }
    }
  }

  async accept(page, controller, append) {
    if (controller !== this.controller) return;
    if (['failed', 'cancelled'].includes(page.run.status)) throw new Error('Lượt tìm kiếm thất bại. Hãy thử lại mô tả này.');
    if (page.run.status !== 'completed') {
      this.timer = setTimeout(async () => {
        try {
          const next = await api(`/search-runs/${id(this.run)}/results`, {
            signal: controller.signal
          });
          await this.accept(next, controller, append);
        } catch (error) {
          if (controller === this.controller && error.name !== 'AbortError') {
            this.busy = false;
            this.onBusy(false);
            this.onError(errorMessage(error));
          }
        }
      }, 2000);
      return;
    }
    this.cursor = page.next_cursor;
    this.busy = false;
    this.onPage(page, append);
    this.onBusy(false);
  }

  async more() {
    if (this.busy || !this.cursor) return;
    this.busy = true;
    this.onBusy(true, true);
    const controller = this.controller;
    try {
      const page = await api(`/search-runs/${id(this.run)}/results?cursor=${id(this.cursor)}`, {
        signal: controller.signal
      });
      await this.accept(page, controller, true);
    } catch (error) {
      if (controller === this.controller && error.name !== 'AbortError') {
        this.busy = false;
        this.onBusy(false);
        this.onError(errorMessage(error), true);
      }
    }
  }

  reset() {
    this.stop();
    this.session = null;
    this.index = null;
    this.run = null;
    this.cursor = null;
    this.onSession?.(null);
    this.onBusy(false);
  }
  stop() {
    clearTimeout(this.timer);
    this.controller?.abort();
    this.controller = null;
    this.busy = false;
  }
}
