function handleLogin(event) {
  if (event) {
    if (typeof event.preventDefault === 'function') event.preventDefault();
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
  }
  const usernameInput = document.getElementById('username');
  const roleSelect = document.getElementById('role-select');
  const username = (usernameInput && usernameInput.value ? usernameInput.value.trim() : 'admin') || 'admin';
  const role = roleSelect ? roleSelect.value : (username === 'admin' ? 'Engineer' : 'User');
  
  sessionStorage.setItem('scenesearch_user_id', username);
  sessionStorage.setItem('scenesearch_user_role', role);
  localStorage.setItem('scenesearch_user_id', username);
  localStorage.setItem('scenesearch_user_role', role);
  
  const btn = document.getElementById('login-btn');
  if (btn) btn.textContent = 'Đang chuyển hướng…';
  
  window.location.href = '/ui/scenesearch_prototype.html?v=' + Date.now();
  return false;
}

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('login-form');
  if (form) {
    form.addEventListener('submit', handleLogin);
  }
  const btn = document.getElementById('login-btn');
  if (btn) {
    btn.addEventListener('click', handleLogin);
  }
});
