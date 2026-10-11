import {
  api,
  errorMessage,
  id
} from './api.js';

export class Embedding {
  constructor({
    onStatus,
    onReady,
    onError
  }) {
    Object.assign(this, {
      onStatus,
      onReady,
      onError
    });
  }

  async start(record, key, retry = false) {
    if (this.busy) return;
    this.stop();
    this.record = record;
    this.busy = true;
    this.controller = new AbortController();
    const controller = this.controller;
    this.onStatus(null, 'starting');
    try {
      const job = retry && record.job_id ?
        await api(`/indexing/jobs/${id(record.job_id)}/retry`, {
          method: 'POST',
          signal: controller.signal
        }) :
        await api(`/indexing/uploads/${id(record.upload_id)}/start`, {
          method: 'POST',
          headers: {
            'Idempotency-Key': key
          },
          signal: controller.signal
        });
      if (controller !== this.controller) return;
      record.job_id = job.job_id;
      record.index_version = job.index_version;
      record.status = 'indexing';
      this.job = job;
      this.onStatus(job);
      await this.poll();
    } catch (error) {
      if (controller === this.controller && error.name !== 'AbortError') {
        this.busy = false;
        this.onError(errorMessage(error), 'start');
      }
    }
  }

  resume(record) {
    this.stop();
    this.record = record;
    this.job = record.job;
    this.busy = true;
    this.controller = new AbortController();
    void this.poll();
  }

  async poll() {
    const controller = this.controller;
    try {
      const job = await api(`/indexing/jobs/${id(this.record.job_id)}`, {
        signal: controller.signal
      });
      if (controller !== this.controller) return;
      this.job = job;
      this.onStatus(job);
      if (['failed', 'cancelled', 'paused'].includes(job.status)) {
        this.busy = false;
        const record = await api(`/indexing/uploads/${id(this.record.upload_id)}`, {
          signal: controller.signal
        });
        this.onError(record.job_error?.message || ({
          failed: 'Xử lý video thất bại. Hãy thử lại.',
          cancelled: 'Tác vụ đã bị hủy.',
          paused: 'Tác vụ đang tạm dừng.'
        })[job.status], job.status);
        return;
      }
      if (['ready', 'published'].includes(job.status)) {
        this.onStatus(job, 'publishing');
        const record = await api(`/indexing/uploads/${id(this.record.upload_id)}`, {
          signal: controller.signal
        });
        if (record.preview_status !== 'ready') throw new Error('Video để xem chưa sẵn sàng. Hãy thử lại bước xử lý.');
        const validation = await api('/indexing/validate', {
          method: 'POST',
          body: {
            index_version: job.index_version
          },
          signal: controller.signal
        });
        if (!validation.passed) throw new Error('Kiểm tra dữ liệu chưa đạt. Hãy thử lại bước xử lý.');
        const published = await api('/indexing/publish', {
          method: 'POST',
          body: {
            index_version: job.index_version,
            alias: `demo_${record.upload_id}`
          },
          signal: controller.signal
        });
        if (published.published !== job.index_version) throw new Error('Máy chủ chưa kích hoạt đúng dữ liệu của folder.');
        if (controller !== this.controller) return;
        this.busy = false;
        this.job = {
          ...job,
          status: 'published'
        };
        this.onReady(this.job);
        return;
      }
      this.timer = setTimeout(() => void this.poll(), 2000);
    } catch (error) {
      if (error.name === 'AbortError' || controller !== this.controller) return;
      if (error.network || error.status >= 500) {
        this.onError(`Chưa lấy được tiến độ: ${errorMessage(error)} Tác vụ vẫn được giữ trên máy chủ.`, 'connection');
        this.timer = setTimeout(() => void this.poll(), 2000);
      } else {
        this.busy = false;
        this.onError(errorMessage(error), 'publish');
      }
    }
  }

  async retry() {
    if (this.busy) return;
    if (this.job?.status === 'failed') await this.start(this.record, null, true);
    else {
      this.busy = true;
      this.controller = new AbortController();
      if (this.job?.status === 'paused') {
        try {
          await api(`/indexing/jobs/${id(this.record.job_id)}/resume`, {
            method: 'POST',
            signal: this.controller.signal
          });
        } catch (error) {
          this.busy = false;
          this.onError(errorMessage(error), 'paused');
          return;
        }
      }
      await this.poll();
    }
  }

  stop() {
    clearTimeout(this.timer);
    this.controller?.abort();
    this.controller = null;
    this.busy = false;
  }
}
