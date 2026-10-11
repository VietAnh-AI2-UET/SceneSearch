import {
  api,
  bytes,
  errorMessage,
  id,
  newKey
} from './api.js';

export class FolderUpload {
  constructor({
    onChange,
    onNew,
    onError
  }) {
    Object.assign(this, {
      onChange,
      onNew,
      onError
    });
    this.files = new Map();
    this.record = null;
    this.busy = false;
    this.resume = false;
  }

  setRecord(record) {
    this.record = record;
    this.onChange(record, this.busy);
  }

  async select(fileList, resume = false) {
    if (this.busy || !fileList.length) return;
    const selected = [...fileList];
    const videos = selected.filter(file => this.config.video_extensions.includes(`.${file.name.split('.').pop().toLowerCase()}`));
    if (!videos.length) {
      this.onError('Không tìm thấy file video hợp lệ được hỗ trợ. Hãy chọn video khác.');
      return;
    }
    if (videos.length > this.config.max_files) {
      this.onError(`Chỉ có thể tải tối đa ${this.config.max_files} video mỗi lượt.`);
      return;
    }
    const invalid = videos.find(file => !file.size || file.size > this.config.max_file_bytes);
    if (invalid) {
      this.onError(`${invalid.name}: ${invalid.size ? `vượt giới hạn ${bytes(this.config.max_file_bytes)}/file.` : 'file rỗng.'}`);
      return;
    }
    const folderName = selected[0].webkitRelativePath ? selected[0].webkitRelativePath.split('/')[0] : (videos.length === 1 ? videos[0].name.replace(/\.[^/.]+$/, '') : 'Video đã chọn');
    const localFiles = new Map(videos.map(file => [file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(1).join('/') : file.name, file]));
    if (localFiles.size !== videos.length) {
      this.onError('Có file trùng đường dẫn. Hãy chọn lại folder.');
      return;
    }
    if (resume && this.record) {
      if (folderName !== this.record.folder_name || this.record.files.some(f => localFiles.get(f.relative_path)?.size !== f.size_bytes)) {
        this.onError('Hãy chọn lại đúng folder và các video của lượt tải đang theo dõi.');
        return;
      }
    }
    this.files = localFiles;
    this.busy = true;
    this.lastError = null;
    this.controller = new AbortController();
    try {
      if (!resume || !this.record) {
        const manifest = {
          folder_name: folderName,
          files: [...localFiles].map(([relative_path, file]) => ({
            relative_path,
            size_bytes: file.size
          }))
        };
        const fingerprint = JSON.stringify(manifest);
        if (this.pendingFingerprint !== fingerprint) {
          this.pendingKey = newKey();
          this.pendingFingerprint = fingerprint;
        }
        const record = await api('/indexing/uploads', {
          method: 'POST',
          body: manifest,
          headers: {
            'Idempotency-Key': this.pendingKey
          },
          signal: this.controller.signal
        });
        this.skipped = selected.length - videos.length;
        this.onNew(record);
        this.setRecord(record);
        this.pendingFingerprint = null;
      }
      await this.transfer();
    } catch (error) {
      if (error.name !== 'AbortError') this.lastError = errorMessage(error);
    } finally {
      this.busy = false;
      this.currentPath = null;
      if (this.record) this.onChange(this.record, false);
      if (this.lastError) this.onError(this.lastError);
    }
  }

  async transfer(fileId = null) {
    for (const item of this.record.files) {
      if (item.status === 'received' || (fileId && item.file_id !== fileId)) continue;
      const file = this.files.get(item.relative_path);
      if (!file) continue;
      this.currentPath = item.relative_path;
      item.status = 'uploading';
      item.error = null;
      this.onChange(this.record, true);
      try {
        const result = await api(`/indexing/uploads/${id(this.record.upload_id)}/files/${id(item.file_id)}`, {
          method: 'PUT',
          body: file,
          signal: this.controller.signal
        });
        Object.assign(item, result);
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        item.status = 'failed';
        item.error = errorMessage(error);
      }
      this.onChange(this.record, true);
    }
    if (this.record.files.every(file => file.status === 'received')) {
      this.currentPath = null;
      this.onChange(this.record, true);
      this.setRecord(await api(`/indexing/uploads/${id(this.record.upload_id)}/complete`, {
        method: 'POST',
        signal: this.controller.signal
      }));
    }
  }

  async retry(fileId = null) {
    if (this.busy || !this.record || !this.files.size) return;
    this.busy = true;
    this.lastError = null;
    this.controller = new AbortController();
    this.onChange(this.record, true);
    try {
      await this.transfer(fileId);
    } catch (error) {
      if (error.name !== 'AbortError') this.lastError = errorMessage(error);
    } finally {
      this.busy = false;
      this.currentPath = null;
      this.onChange(this.record, false);
      if (this.lastError) this.onError(this.lastError);
    }
  }

  stop() {
    this.controller?.abort();
  }
}
