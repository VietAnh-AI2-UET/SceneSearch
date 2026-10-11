const messages = {
  DEMO_CONFIG_REQUIRED: 'Máy chủ chưa dùng cấu hình demo. Hãy chạy với cặp cấu hình demo.local.yaml.',
  UPLOAD_ROOT_NOT_ALLOWED: 'Thư mục lưu video chưa nằm trong vùng dữ liệu được máy chủ cho phép.',
  UPLOAD_TOO_LARGE: 'Video vượt quá dung lượng tối đa cho mỗi file.',
  UPLOAD_SIZE_MISMATCH: 'Video chưa được nhận đủ dữ liệu. Hãy thử tải lại.',
  INVALID_VIDEO: 'Không đọc được video. Kiểm tra file và chọn lại folder nếu cần.',
  UPLOAD_INCOMPLETE: 'Chưa tải đủ video. Hãy tải tiếp các file còn thiếu.',
  INVALID_RELATIVE_PATH: 'Đường dẫn file trong folder không hợp lệ.',
  UNSUPPORTED_VIDEO_FORMAT: 'Định dạng video chưa được hỗ trợ.',
  DUPLICATE_RELATIVE_PATH: 'Có file trùng đường dẫn trong folder đã chọn.',
  SOURCE_FORBIDDEN: 'Bạn không có quyền truy cập dữ liệu này.',
  INDEX_ADMIN_REQUIRED: 'Tài khoản hiện tại không có quyền tải và xử lý video.',
  UPLOAD_NOT_FOUND: 'Không tìm thấy lượt tải đã lưu. Hãy chọn folder để tải lại.',
  INDEX_NOT_READY: 'Dữ liệu chưa sẵn sàng để tìm kiếm.',
  INDEX_NOT_FOUND: 'Không tìm thấy dữ liệu tìm kiếm của folder này.',
  PREVIEW_UNAVAILABLE: 'Video xem trước hiện không khả dụng.',
  SearchBusyError: 'Máy chủ đang xử lý một lượt tìm khác. Hãy thử lại sau.',
  BROWSER_PREVIEW_FAILED: 'Không tạo được video để xem. Hãy kiểm tra FFmpeg trên máy chủ rồi thử lại.',
  REGISTER_SOURCE_BEFORE_INDEXING: 'Tải folder chỉ được hỗ trợ trong môi trường demo local.',
};

export function errorMessage(error) {
  if (error?.name === 'AbortError') return '';
  const detail = error?.detail ?? error?.message ?? 'Lỗi chưa xác định';
  const code = typeof detail === 'object' ? detail.code : String(detail).split(':')[0];
  const message = messages[code] || (typeof detail === 'string' ? detail : 'Máy chủ không chấp nhận dữ liệu đã gửi.');
  return detail?.relative_path ? `${detail.relative_path}: ${message}` : message;
}

export async function api(path, {
  method = 'GET',
  body,
  headers = {},
  signal
} = {}) {
  const role = sessionStorage.getItem('scenesearch_user_role') || localStorage.getItem('scenesearch_user_role') || 'User';
  const actorId = sessionStorage.getItem('scenesearch_user_id') || localStorage.getItem('scenesearch_user_id') || 'guest';
  const options = {
    method,
    headers: {
      'X-Roles': role,
      'X-Actor-Id': actorId,
      ...headers
    },
    signal,
    credentials: 'same-origin'
  };
  if (body !== undefined) {
    if (body instanceof Blob) {
      options.body = body;
      options.headers['Content-Type'] = 'application/octet-stream';
    } else {
      options.body = JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
    }
  }
  let response;
  try {
    response = await fetch(`/api/v1${path}`, options);
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    const connectionError = new Error('Mất kết nối với máy chủ. Kiểm tra kết nối rồi thử lại.');
    connectionError.network = true;
    throw connectionError;
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.message || `Máy chủ trả lỗi ${response.status}. Hãy thử lại.`);
    error.detail = data?.detail || data?.message || data?.error_code || error.message;
    error.status = response.status;
    throw error;
  }
  return data;
}

export const newKey = () => crypto.randomUUID();
export const id = (value) => encodeURIComponent(value);

export function bytes(value) {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(value % 1024 ** 3 ? 1 : 0)} GiB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${value} B`;
}

export function saveState(value) {
  try {
    sessionStorage.setItem('scenesearch.demo.v1', JSON.stringify(value));
    localStorage.setItem('scenesearch.demo.v1', JSON.stringify(value));
  } catch {
    /* Storage can be disabled. */ }
}

export function readState() {
  try {
    const fromLocal = localStorage.getItem('scenesearch.demo.v1');
    if (fromLocal) return JSON.parse(fromLocal);
    const fromSession = sessionStorage.getItem('scenesearch.demo.v1');
    if (fromSession) return JSON.parse(fromSession);
    return {};
  } catch {
    return {};
  }
}
