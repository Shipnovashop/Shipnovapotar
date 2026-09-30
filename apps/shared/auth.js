(function () {
  const DEFAULT_API = 'http://localhost:4000';
  const API_BASE = (localStorage.getItem('shipnovaportal_api') || DEFAULT_API).replace(/\/$/, '');
  window.SNP = {
    API_BASE,
    async request(path, options = {}) {
      const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
      const token = localStorage.getItem('snp_token');
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
      let data = {};
      try { data = await response.json(); } catch (_) {}
      if (!response.ok) throw new Error(data.message || `Request failed (${response.status})`);
      return data;
    },
    saveSession(data) {
      localStorage.setItem('snp_token', data.token);
      localStorage.setItem('snp_user', JSON.stringify(data.user));
    },
    user() {
      try { return JSON.parse(localStorage.getItem('snp_user') || 'null'); } catch (_) { return null; }
    },
    logout() {
      localStorage.removeItem('snp_token');
      localStorage.removeItem('snp_user');
      location.href = 'index.html';
    },
    esc(value) {
      return String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
    }
  };
})();
