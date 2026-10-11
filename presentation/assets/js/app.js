import {
  api,
  bytes,
  errorMessage,
  id,
  newKey,
  readState,
  saveState
} from './api.js';
import {
  Embedding
} from './embedding.js';
import {
  ResultPlayers
} from './players.js';
import {
  SceneSearch
} from './search.js';
import {
  FolderUpload
} from './upload.js';

const $ = value => document.getElementById(value);
const saved = readState();
let record = null,
  readyIndex = null,
  startKey = saved.start_key,
  config = null;
let currentUploadId = saved.upload_id,
  startRequested = !!saved.start_requested;
const players = new ResultPlayers($('results-list'));

function persist() {
  saveState({
    upload_id: record?.upload_id || currentUploadId,
    start_key: startKey,
    start_requested: startRequested,
    query: $('query').value
  });
}

function dataMessage(message, kind = '') {
  $('data-status').textContent = message;
  $('data-status').className = `status-message ${kind}`;
}

function badge(text, kind = '') {
  $('dataset-badge').textContent = text;
  $('dataset-badge').className = `status-badge ${kind}`;
}

function steps(stage) {
  ['upload', 'embed', 'search'].forEach((name, i) => {
    $(`step-${name}`).className = i < stage ? 'done' : i === stage ? 'current' : '';
  });
}

function progress(title, done, total) {
  $('progress-region').hidden = false;
  $('progress-title').textContent = title;
  if (total > 0) {
    $('dataset-progress').max = total;
    $('dataset-progress').value = done;
    $('progress-count').textContent = `${done}/${total}`;
  } else {
    $('dataset-progress').removeAttribute('value');
    $('progress-count').textContent = '';
  }
}

function recovery({
  resume = false,
  uploadRetry = false,
  jobRetry = false
} = {}) {
  $('recovery-actions').hidden = !(resume || uploadRetry || jobRetry);
  $('resume-upload').hidden = !resume;
  $('retry-upload').hidden = !uploadRetry;
  $('retry-job').hidden = !jobRetry;
}

function searchMessage(message = '', error = false) {
  $('search-status').hidden = !message;
  $('search-status').textContent = message;
  $('search-status').className = `status-message${error ? ' error' : ''}`;
}

function resetResults() {
  players.clear();
  $('results-count').textContent = '0';
  $('nav-count').textContent = '0';
  $('load-more').hidden = true;
  $('empty-state').hidden = false;
  $('empty-title').textContent = 'Cảnh bạn cần tìm sẽ xuất hiện ở đây';
  $('empty-description').textContent = 'Tải folder video, chuẩn bị dữ liệu và nhập mô tả. SceneSearch sẽ đưa bạn đến đúng đoạn video.';
  $('results-note').textContent = 'Xem video ngay tại mỗi kết quả';
  searchMessage();
}

const search = new SceneSearch({
  onReset: resetResults,
  onSession: renderMetadataFilters,
  onBusy(busy, more = false) {
    $('search-button').disabled = busy || !readyIndex;
    $('search-label').textContent = busy && !more ? 'Đang tìm kiếm…' : 'Tìm kiếm';
    $('load-more').disabled = busy;
    $('load-more').textContent = busy && more ? 'Đang tải…' : 'Xem thêm';
    $('results-panel').setAttribute('aria-busy', String(busy));
    if (busy && !more) {
      $('empty-title').textContent = 'Đang tìm cảnh phù hợp…';
      $('empty-description').textContent = 'Kết quả sẽ xuất hiện sau khi máy chủ xử lý mô tả của bạn.';
    }
  },
  onPage(page, append) {
    if (!append) players.clear();
    players.append(page.results);
    const count = page.run.result_count ?? players.players.size;
    $('results-count').textContent = count;
    $('nav-count').textContent = count;
    $('results-note').textContent = `Hiển thị ${players.players.size}/${count} cảnh · Theo thứ tự tương đồng`;
    $('empty-state').hidden = players.players.size > 0;
    if (!players.players.size) {
      $('empty-title').textContent = 'Không tìm thấy cảnh phù hợp';
      $('empty-description').textContent = 'Không tìm thấy cảnh phù hợp. Hãy thử mô tả khác.';
    }
    $('load-more').hidden = !page.next_cursor;
    searchMessage(players.players.size ? `Đã tìm thấy ${count} cảnh phù hợp.` : 'Không tìm thấy cảnh phù hợp. Hãy thử mô tả khác.');
  },
  onError(message, append = false) {
    searchMessage(message, true);
    if (!append) {
      $('empty-title').textContent = 'Chưa lấy được kết quả';
      $('empty-description').textContent = 'Mô tả của bạn được giữ lại. Hãy thử tìm kiếm lần nữa.';
    }
  },
});

function renderMetadataFilters(session) {
  let available = false;
  for (const group of ['weather', 'lighting']) {
    const generated = session?.capabilities?.[group] === 'generated';
    const values = session?.metadata_filter_values?.[group] || [];
    const fieldset = $(`${group}-filters`);
    fieldset.disabled = !generated || !values.length;
    available ||= !fieldset.disabled;
    for (const input of fieldset.querySelectorAll('input')) {
      const valid = generated && values.includes(input.value);
      input.disabled = !valid;
      input.parentElement.hidden = generated && !valid;
      if (!valid) input.checked = false;
    }
  }
  $('clear-filters').disabled = !available;
  $('filter-note').textContent = available
    ? 'Chọn nhiều giá trị trong mỗi nhóm. Các nhãn thuộc đoạn video đại diện và cần kiểm tra khi xem.'
    : 'Bộ dữ liệu này chưa có metadata thời tiết và ngày/đêm. Bạn vẫn có thể tìm bằng mô tả.';
}

function selectedMetadataFilters() {
  return Object.fromEntries(['weather', 'lighting'].map(group => [group,
    Array.from($(`${group}-filters`).querySelectorAll('input:checked')).filter(input => !input.disabled).map(input => input.value)
  ]));
}

function applyMetadataFilters() {
  if (readyIndex && $('query').value.trim()) {
    void search.query($('query').value, readyIndex, selectedMetadataFilters());
  }
}

for (const group of ['weather', 'lighting']) $(`${group}-filters`).addEventListener('change', applyMetadataFilters);
$('clear-filters').addEventListener('click', () => {
  document.querySelectorAll('.filter-panel input').forEach(input => { input.checked = false; });
  applyMetadataFilters();
});

function renderFiles() {
  $('file-details').hidden = !record?.files.length;
  $('file-count').textContent = `(${record?.files.length || 0})`;
  $('file-list').replaceChildren();
  for (const file of record?.files || []) {
    const row = document.createElement('li'),
      name = document.createElement('span'),
      state = document.createElement('span');
    name.className = 'file-name';
    name.textContent = file.relative_path;
    state.className = `file-state${file.status === 'received' ? ' success' : file.status === 'failed' ? ' error' : ''}`;
    state.textContent = ({
      pending: 'Chờ tải',
      uploading: 'Đang tải…',
      received: 'Đã tải',
      failed: 'Tải lỗi'
    })[file.status] || file.status;
    state.title = file.error || bytes(file.size_bytes);
    row.append(name, state);
    if (file.status === 'failed') {
      const reason = document.createElement('span');
      reason.className = 'file-state error';
      reason.textContent = file.error || 'Chưa tải được';
      row.append(reason);
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'file-retry';
      retry.textContent = 'Thử lại';
      retry.disabled = upload.busy || !upload.files.has(file.relative_path);
      retry.addEventListener('click', () => void upload.retry(file.file_id));
      row.append(retry);
    }
    $('file-list').append(row);
  }
}

function renderUpload(value, busy) {
  record = value;
  currentUploadId = record.upload_id;
  persist();
  $('upload-button').disabled = busy || !config?.enabled;
  if ($('upload-files-button')) $('upload-files-button').disabled = busy || !config?.enabled;
  $('resume-upload').disabled = busy;
  $('retry-upload').disabled = busy;
  $('folder-name').textContent = record.folder_name;
  const total = record.files.reduce((sum, f) => sum + f.size_bytes, 0),
    done = record.files.filter(f => f.status === 'received').length;
  $('folder-summary').textContent = `${record.files.length} video · ${bytes(total)} · Đã tải ${done}/${record.files.length}${upload.skipped ? ` · Bỏ qua ${upload.skipped} file khác` : ''}`;
  renderFiles();
  if (record.job_id) return;
  const complete = record.status === 'uploaded';
  $('embed-button').disabled = !complete || busy;
  $('embed-label').textContent = 'Bắt đầu embedding';
  if (complete) {
    badge('Đã tải xong', 'ready');
    steps(1);
    recovery();
    progress('Đã tải đủ video', done, record.files.length);
    dataMessage('Đã tải xong — sẵn sàng embedding', 'success');
  } else {
    badge(busy ? 'Đang tải video' : 'Chưa tải đủ video', busy ? 'working' : '');
    steps(0);
    progress(busy ? (upload.currentPath ? `Đang tải: ${upload.currentPath}` : 'Đang kiểm tra video đã tải…') : 'Tiến độ tải video', done, record.files.length);
    const missing = record.files.some(f => f.status !== 'received');
    recovery({
      resume: !busy && missing && !upload.files.size,
      uploadRetry: !busy && upload.files.size > 0
    });
    $('retry-upload').textContent = missing ? 'Thử lại các file lỗi' : 'Thử lại kiểm tra video';
    if (busy) dataMessage('Đang tải từng video lên máy chủ. Embedding chưa bắt đầu.');
    else dataMessage(missing ? (upload.files.size ? 'Một số video chưa tải được. Hãy thử lại các file lỗi.' : 'Chọn lại folder để tải tiếp các video còn thiếu.') : 'Video đã tải đủ. Hãy thử lại bước kiểm tra để hoàn tất.', missing && upload.files.size ? 'error' : '');
  }
}

const upload = new FolderUpload({
  onChange: renderUpload,
  onNew(value) {
    embedding.stop();
    search.reset();
    readyIndex = null;
    record = value;
    currentUploadId = value.upload_id;
    startKey = newKey();
    startRequested = false;
    $('search-button').disabled = true;
    $('results-panel').setAttribute('aria-busy', 'false');
    $('search-label').textContent = 'Tìm kiếm';
    $('search-hint').textContent = 'Bạn có thể nhập mô tả trước khi dữ liệu sẵn sàng.';
    resetResults();
    recovery();
    persist();
  },
  onError(message) {
    dataMessage(message, 'error');
  },
});

const jobLabels = {
  queued: 'Đang chờ xử lý',
  pending: 'Đang chờ xử lý',
  running: 'Đang tạo embedding',
  validating: 'Đang kiểm tra dữ liệu và chuẩn bị video',
  ready: 'Đang chuẩn bị tìm kiếm',
  published: 'Sẵn sàng tìm kiếm',
  failed: 'Xử lý thất bại',
  paused: 'Đang tạm dừng',
  cancelled: 'Đã hủy tác vụ'
};
const embedding = new Embedding({
  onStatus(job, stage) {
    startRequested = true;
    persist();
    readyIndex = null;
    $('search-button').disabled = true;
    search.reset();
    $('embed-button').disabled = true;
    recovery();
    steps(1);
    if (job) {
      record.job_id = job.job_id;
      record.index_version = job.index_version;
      record.status = 'indexing';
      persist();
    }
    const label = stage === 'starting' ? 'Đang bắt đầu xử lý…' : stage === 'publishing' ? 'Đang kích hoạt dữ liệu tìm kiếm' : jobLabels[job.status] || 'Đang xử lý';
    badge(label, 'working');
    $('embed-label').textContent = 'Đang xử lý…';
    const total = job?.total_items || 0,
      done = job?.processed_items || 0;
    progress(stage === 'publishing' ? label : total ? `Đã xử lý ${done}/${total} đoạn` : label, done, total);
    dataMessage(label + (job?.status === 'queued' ? '. Đảm bảo tiến trình xử lý nền đang chạy.' : '.'));
  },
  onReady(job) {
    startRequested = false;
    readyIndex = job.index_version;
    void search.prepare(readyIndex);
    record.job_id = job.job_id;
    record.index_version = job.index_version;
    persist();
    badge('Sẵn sàng tìm kiếm', 'ready');
    steps(2);
    recovery();
    progress(`Đã xử lý ${job.processed_items}/${job.total_items} đoạn`, job.processed_items, job.total_items);
    dataMessage('Sẵn sàng tìm kiếm. Nhập mô tả để tìm cảnh trong folder này.', 'success');
    $('embed-label').textContent = 'Đã tạo embedding';
    $('embed-button').disabled = true;
    $('search-button').disabled = false;
    $('search-hint').textContent = `Tìm kiếm trong folder “${record.folder_name}”.`;
    void refreshDatasets(record.upload_id);
  },
  onError(message, phase) {
    dataMessage(errorMessage({
      message
    }), 'error');
    if (phase !== 'connection') {
      badge('Cần thử lại', 'error');
      $('embed-label').textContent = 'Bắt đầu embedding';
      $('embed-button').disabled = !!record?.job_id;
      recovery({
        jobRetry: !!record?.job_id && phase !== 'cancelled'
      });
    }
  },
});

function choose(resume = false, forceFiles = false) {
  upload.resume = resume;
  const input = (!forceFiles && 'webkitdirectory' in $('folder-input')) ? $('folder-input') : $('files-input');
  input.value = '';
  input.click();
}
$('upload-button').addEventListener('click', () => choose(false, false));
if ($('upload-files-button')) {
  $('upload-files-button').addEventListener('click', () => choose(false, true));
}
$('resume-upload').addEventListener('click', () => choose(true));
for (const name of ['folder-input', 'files-input']) $(name).addEventListener('change', event => void upload.select(event.target.files, upload.resume));
$('retry-upload').addEventListener('click', () => void upload.retry());
$('embed-button').addEventListener('click', () => {
  if (record?.status === 'uploaded') void embedding.start(record, startKey);
});
$('retry-job').addEventListener('click', () => void embedding.retry());
$('search-form').addEventListener('submit', event => {
  event.preventDefault();
  persist();
  void search.query($('query').value, readyIndex, selectedMetadataFilters());
});
$('load-more').addEventListener('click', () => void search.more());
$('query').value = typeof saved.query === 'string' ? saved.query.slice(0, 1000) : '';
$('query').addEventListener('input', persist);
for (const link of document.querySelectorAll('.nav-link')) link.addEventListener('click', () => {
  document.querySelectorAll('.nav-link').forEach(item => item.classList.toggle('active', item === link));
});
window.addEventListener('pagehide', () => {
  persist();
  upload.stop();
  embedding.stop();
  search.stop();
  players.clear();
});
window.addEventListener('pageshow', event => {
  if (event.persisted) location.reload();
});

let availableDatasets = [];

async function applySelectedDataset(ds) {
  if (!ds) return;
  readyIndex = ds.index_version;
  void search.prepare(readyIndex);
  currentUploadId = ds.upload_id;
  saved.upload_id = ds.upload_id;
  $('folder-name').textContent = ds.folder_name;
  $('folder-summary').textContent = `Video lưu trữ (${ds.file_count} video) · Đã sẵn sàng tìm kiếm`;
  badge('Sẵn sàng tìm kiếm', 'ready');
  steps(2);
  $('progress-region').hidden = true;
  recovery();
  $('search-button').disabled = false;
  $('search-hint').textContent = `Tìm kiếm trong "${ds.folder_name}".`;
  dataMessage(`Đã chọn kho video "${ds.folder_name}" (${ds.file_count} video). Sẵn sàng tìm kiếm!`, 'success');
  persist();
  try {
    const fullRecord = await api(`/indexing/uploads/${ds.upload_id}`);
    if (currentUploadId !== ds.upload_id) return;
    if (fullRecord && fullRecord.files) {
      record = fullRecord;
      renderFiles();
    }
  } catch (e) {
    console.warn('Cannot fetch upload files', e);
  }
}

async function refreshDatasets(preferredUploadId = null) {
  try {
    availableDatasets = await api('/indexing/uploads/datasets');
  } catch (e) {
    console.warn('Cannot fetch datasets', e);
    availableDatasets = [];
  }
  const wrap = $('dataset-picker-wrap');
  const select = $('dataset-select');
  if (!wrap || !select) return;

  if (availableDatasets && availableDatasets.length > 0) {
    wrap.hidden = false;
    select.innerHTML = availableDatasets.map(ds => 
      `<option value="${ds.upload_id}">${ds.folder_name} (${ds.file_count} video)</option>`
    ).join('');
    const targetId = preferredUploadId || saved.upload_id || availableDatasets[0].upload_id;
    const current = availableDatasets.find(d => d.upload_id === targetId) || availableDatasets[0];
    select.value = current.upload_id;
    await applySelectedDataset(current);
  } else {
    wrap.hidden = true;
    readyIndex = null;
    search.reset();
    currentUploadId = null;
    record = null;
    saved.upload_id = null;
    badge('Chưa chọn folder', '');
    steps(0);
    $('search-button').disabled = true;
    $('folder-name').textContent = 'Chưa có video nào được tải lên';
    $('folder-summary').textContent = 'Chọn folder hoặc một/nhiều video lẻ để bắt đầu.';
    $('file-list').replaceChildren();
    $('file-details').hidden = true;
    $('progress-region').hidden = true;
    recovery();
    resetResults();
    dataMessage('Chưa có dữ liệu. Tải folder video hoặc video lẻ để bắt đầu.');
    persist();
  }
}

async function initialize() {
  const userId = sessionStorage.getItem('scenesearch_user_id') || localStorage.getItem('scenesearch_user_id');
  const userRole = sessionStorage.getItem('scenesearch_user_role') || localStorage.getItem('scenesearch_user_role') || 'User';
  
  const loginLink = document.querySelector('.login-link');
  if (userId && loginLink) {
    loginLink.innerHTML = `Đăng xuất (${userId} · ${userRole})`;
    loginLink.href = '#';
    loginLink.addEventListener('click', (e) => {
      e.preventDefault();
      sessionStorage.removeItem('scenesearch_user_id');
      sessionStorage.removeItem('scenesearch_user_role');
      localStorage.removeItem('scenesearch_user_id');
      localStorage.removeItem('scenesearch_user_role');
      location.reload();
    });
  }

  const isEngineer = (userRole === 'Engineer' || userRole === 'Admin');
  
  if (!isEngineer) {
    const dataActions = document.querySelector('.data-actions');
    if (dataActions) dataActions.style.display = 'none';
    const dsActions = $('dataset-actions');
    if (dsActions) dsActions.style.display = 'none';
    
    const note = document.createElement('p');
    note.id = 'role-user-note';
    note.className = 'subtle-text';
    note.style.color = '#e2b340';
    note.style.marginTop = '16px';
    note.innerHTML = '<svg class="icon"><use href="#icon-info"/></svg> <strong>Chế độ User:</strong> Bạn chỉ có quyền tìm kiếm cảnh video. Quyền tải và xử lý video chỉ dành cho Admin.';
    const dataTitle = document.querySelector('#data-title');
    if (dataTitle && !document.querySelector('#role-user-note')) {
      dataTitle.parentElement.appendChild(note);
    }
    
    const stepUpload = document.querySelector('#step-upload');
    const stepEmbed = document.querySelector('#step-embed');
    if (stepUpload) stepUpload.style.opacity = '0.3';
    if (stepEmbed) stepEmbed.style.opacity = '0.3';
  }

  const datasetSelect = $('dataset-select');
  if (datasetSelect) {
    datasetSelect.addEventListener('change', async (e) => {
      const chosen = availableDatasets.find(d => d.upload_id === e.target.value);
      if (chosen) {
        await applySelectedDataset(chosen);
        dataMessage(`Đã chuyển sang video: "${chosen.folder_name}". Sẵn sàng tìm kiếm!`, 'success');
      }
    });
  }

  const deleteBtn = $('delete-dataset-btn');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async () => {
      if (!currentUploadId) return;
      const current = availableDatasets.find(d => d.upload_id === currentUploadId);
      const name = current ? current.folder_name : 'video này';
      if (!confirm(`Bạn có chắc chắn muốn xóa "${name}" khỏi kho lưu trữ?`)) return;
      try {
        dataMessage('Đang xóa video…');
        await api(`/indexing/uploads/datasets/${currentUploadId}`, { method: 'DELETE' });
        saved.upload_id = null;
        persist();
        await refreshDatasets();
        dataMessage('Đã xóa video thành công!', 'success');
      } catch (err) {
        dataMessage(`Lỗi khi xóa: ${errorMessage(err)}`, 'error');
      }
    });
  }

  const deleteAllBtn = $('delete-all-datasets-btn');
  if (deleteAllBtn) {
    deleteAllBtn.addEventListener('click', async () => {
      if (!confirm('Bạn có chắc chắn muốn XÓA TOÀN BỘ video đã lưu trữ trong kho không?')) return;
      try {
        dataMessage('Đang xóa toàn bộ kho video…');
        await api('/indexing/uploads/datasets', { method: 'DELETE' });
        saved.upload_id = null;
        persist();
        await refreshDatasets();
        dataMessage('Đã xóa sạch toàn bộ video!', 'success');
      } catch (err) {
        dataMessage(`Lỗi khi xóa: ${errorMessage(err)}`, 'error');
      }
    });
  }

  await refreshDatasets();

  try {
    if (isEngineer) {
      config = await api('/indexing/uploads/config');
      upload.config = config;
      $('upload-limit').textContent = `Tối đa ${bytes(config.max_file_bytes)}/file · ${config.video_extensions.map(ext => ext.slice(1).toUpperCase()).join(', ')}`;
      $('files-input').accept = config.video_extensions.join(',');
      $('folder-fallback').hidden = 'webkitdirectory' in $('folder-input');
      if (!config.enabled) {
        dataMessage('Máy chủ chưa cấu hình demo. Xem hướng dẫn chạy trong docs/ui-demo-runbook.md.', 'error');
        return;
      }
      $('upload-button').disabled = false;
      if ($('upload-files-button')) $('upload-files-button').disabled = false;

      const isAlreadyReady = availableDatasets.some(d => d.upload_id === saved.upload_id);
      if (saved.upload_id && !isAlreadyReady) {
        try {
          const rec = await api(`/indexing/uploads/${id(saved.upload_id)}`);
          if (rec.status !== 'ready' && rec.job?.status !== 'published') {
            upload.setRecord(rec);
            if (rec.job_id) embedding.resume(rec);
            else if (rec.status === 'uploaded' && startRequested) void embedding.start(rec, startKey);
          }
        } catch (error) {}
      }
      if (!availableDatasets.length && !record) {
        dataMessage('Chưa có dữ liệu. Tải folder video hoặc video lẻ để bắt đầu.');
      }
    } else {
      if (availableDatasets.length > 0) {
        dataMessage('Chế độ User: Bạn có thể chọn video từ kho lưu trữ và tìm kiếm ngay.', 'success');
      } else {
        dataMessage('Chế độ User: Chưa có video nào được lưu trữ bởi Admin.', 'error');
      }
    }
  } catch (error) {
    dataMessage(errorMessage(error), 'error');
  }
}
void initialize();
