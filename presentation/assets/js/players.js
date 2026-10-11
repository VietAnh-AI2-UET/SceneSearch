import {
  api,
  errorMessage,
  id
} from './api.js';

export function timestamp(ms) {
  const value = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(value / 3600), Math.floor(value / 60) % 60, value % 60].map(n => String(n).padStart(2, '0')).join(':');
}

class ScenePlayer {
  constructor(row, result, manager) {
    Object.assign(this, {
      row,
      result,
      manager
    });
    this.video = row.querySelector('video');
    this.status = row.querySelector('.player-status');
    this.start = result.start_ms / 1000;
    this.end = result.end_ms / 1000;
    this.listeners = new AbortController();
    const options = {
      signal: this.listeners.signal
    };
    this.video.addEventListener('loadedmetadata', () => {
      this.video.currentTime = Math.min(Math.max(this.position ?? this.start, this.start), this.end);
      this.status.hidden = true;
      if (this.continuePlaying) {
        this.continuePlaying = false;
        void this.video.play().catch(() => {});
      }
    }, options);
    this.video.addEventListener('play', () => {
      this.manager.pauseOthers(this);
      if (!this.expires || Date.now() >= this.expires - 5000) {
        this.video.pause();
        void this.load(true, true);
        return;
      }
      if (this.video.currentTime >= this.end - .02 || this.video.currentTime < this.start) this.video.currentTime = this.start;
    }, options);
    this.video.addEventListener('timeupdate', () => {
      if (this.video.currentTime >= this.end) {
        this.video.pause();
        if (this.video.currentTime > this.end + .01) this.video.currentTime = this.end;
      }
    }, options);
    this.video.addEventListener('seeking', () => {
      if (this.video.currentTime < this.start - .01) this.video.currentTime = this.start;
      if (this.video.currentTime > this.end + .01) this.video.currentTime = this.end;
    }, options);
    this.video.addEventListener('error', () => {
      if (this.disposed || this.loading) return;
      if (this.expires && Date.now() >= this.expires - 5000) void this.load(true, false);
      else this.fail('Không phát được video. Hãy thử nạp lại video.');
    }, options);
  }

  async load(refresh = false, play = false) {
    if (this.loading || this.disposed || (this.video.src && !refresh)) return;
    this.loading = true;
    this.position = refresh ? this.video.currentTime : this.start;
    this.continuePlaying = play || !this.video.paused;
    this.video.pause();
    this.status.className = 'player-status';
    this.status.textContent = 'Đang nạp video…';
    this.status.hidden = false;
    this.request?.abort();
    this.request = new AbortController();
    try {
      const response = await api(`/search-results/${id(this.result.result_id)}/preview-url`, {
        method: 'POST',
        signal: this.request.signal
      });
      if (this.disposed) return;
      const url = new URL(response.url, location.origin);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('URL xem video không hợp lệ.');
      this.expires = response.expires_at ? Date.parse(response.expires_at) : Date.now() + response.expires_in_seconds * 1000;
      this.video.src = url.href;
      this.video.load();
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        if (!this.video.paused) void this.load(true, true);
      }, Math.max(1000, this.expires - Date.now() - 5000));
    } catch (error) {
      if (error.name !== 'AbortError') this.fail(errorMessage(error));
    } finally {
      this.loading = false;
    }
  }

  fail(message) {
    this.status.textContent = message;
    this.status.hidden = false;
    this.status.className = 'player-status error';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'button button-secondary';
    retry.textContent = 'Thử lại video';
    retry.addEventListener('click', () => void this.load(true), {
      signal: this.listeners.signal
    });
    this.status.append(retry);
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.request?.abort();
    this.listeners.abort();
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
  }
}

export class ResultPlayers {
  constructor(container) {
    this.container = container;
    this.players = new Map();
    this.observer = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
      for (const entry of entries)
        if (entry.isIntersecting) {
          this.observer.unobserve(entry.target);
          void this.players.get(entry.target.dataset.resultId)?.load();
        }
    }, {
      rootMargin: '300px'
    }) : null;
  }

  append(results) {
    for (const result of results) {
      if (this.players.has(result.result_id)) continue;
      const row = document.createElement('article');
      row.className = 'panel result-row';
      row.dataset.resultId = result.result_id;
      row.innerHTML = '<div class="player-shell"><video class="result-video" controls playsinline preload="metadata"></video><div class="player-status" role="status" aria-live="polite">Đang chờ nạp video…</div></div><div class="result-info"><div class="result-kicker"><span class="rank-label"></span><span>CẢNH PHÙ HỢP</span></div><h3></h3><div class="scene-time"><svg class="icon"><use href="#icon-clock"/></svg><span class="time-range"></span><span class="scene-duration"></span></div><div class="similarity"><span>Độ tương đồng</span><strong></strong></div><p class="result-caption">Bấm Play để xem đúng khoảng cảnh này.</p></div>';
      row.querySelector('h3').textContent = result.video_id;
      row.querySelector('.rank-label').textContent = `#${String(result.rank).padStart(2, '0')}`;
      row.querySelector('.time-range').textContent = `${timestamp(result.start_ms)} — ${timestamp(result.end_ms)}`;
      row.querySelector('.scene-duration').textContent = `(${((result.end_ms - result.start_ms) / 1000).toFixed(1)} giây)`;
      row.querySelector('.similarity strong').textContent = Number(result.vector_score).toFixed(3);
      row.querySelector('video').setAttribute('aria-label', `Cảnh ${result.rank}: ${result.video_id}`);
      if (result.camera) {
        const camera = document.createElement('p');
        camera.className = 'result-meta';
        camera.textContent = `Camera: ${result.camera}`;
        row.querySelector('.result-info').append(camera);
      }
      const metadata = document.createElement('p');
      metadata.className = 'result-meta';
      const weather = {clear: 'Trời quang', cloudy: 'Nhiều mây', rain: 'Mưa', fog: 'Sương mù', unknown: 'Không xác định'};
      const lighting = {day: 'Ban ngày', night: 'Ban đêm', unknown: 'Không xác định'};
      metadata.textContent = result.metadata
        ? `Đoạn đại diện: ${weather[result.metadata.weather?.value] || 'Không xác định'} · ${lighting[result.metadata.lighting?.value] || 'Không xác định'}`
        : 'Chưa có metadata';
      row.querySelector('.result-info').append(metadata);
      const player = new ScenePlayer(row, result, this);
      this.players.set(result.result_id, player);
      this.container.append(row);
      if (this.observer) this.observer.observe(row);
      else void player.load();
    }
  }

  pauseOthers(active) {
    for (const player of this.players.values())
      if (player !== active) {
        player.continuePlaying = false;
        player.video.pause();
      }
  }
  clear() {
    this.observer?.disconnect();
    for (const player of this.players.values()) player.dispose();
    this.players.clear();
    this.container.replaceChildren();
  }
}
