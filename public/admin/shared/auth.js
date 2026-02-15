// ==================== MULLIGANS ADMIN - AUTH ====================
// Token-based authentication with session management

const API_BASE = '/admin';
let adminToken = '';
let inactivityTimer = null;
const INACTIVITY_TIMEOUT = 30 * 60 * 1000; // 30 minutes (matches server)

// ==================== SESSION MANAGEMENT ====================

// Check if already logged in
function checkAuth() {
  const savedToken = sessionStorage.getItem('adminToken');
  if (savedToken) {
    adminToken = savedToken;
    resetInactivityTimer();
    return true;
  }
  return false;
}

// Reset inactivity timer on user activity
function resetInactivityTimer() {
  if (inactivityTimer) clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(() => {
    console.log('Session timed out due to inactivity');
    logout('Your session has expired due to inactivity.');
  }, INACTIVITY_TIMEOUT);
}

// Track user activity for inactivity timeout
function setupActivityTracking() {
  const events = ['mousedown', 'keydown', 'scroll', 'touchstart'];
  events.forEach(event => {
    document.addEventListener(event, () => {
      if (adminToken) resetInactivityTimer();
    }, { passive: true });
  });
}

// ==================== UI ====================

// Show login screen
function showLogin() {
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('appContainer').classList.remove('active');
}

// Show main app
function showApp() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('appContainer').classList.add('active');
}

// ==================== LOGIN ====================

async function handleLogin(e) {
  e.preventDefault();
  const password = document.getElementById('password').value;
  const loginBtn = document.getElementById('loginBtn');
  const errorDiv = document.getElementById('loginError');

  loginBtn.disabled = true;
  loginBtn.innerHTML = '<span class="spinner" style="width:20px;height:20px;margin-right:8px;"></span> Signing in...';
  errorDiv.style.display = 'none';

  try {
    const response = await fetch(`${API_BASE}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });

    const data = await response.json();

    if (response.ok && data.token) {
      // Store token, NOT password
      adminToken = data.token;
      sessionStorage.setItem('adminToken', data.token);
      // Clear password from memory
      document.getElementById('password').value = '';

      showApp();
      resetInactivityTimer();

      if (typeof initPage === 'function') {
        initPage();
      }
    } else {
      errorDiv.textContent = data.error || 'Invalid password';
      errorDiv.style.display = 'block';
    }
  } catch (error) {
    errorDiv.textContent = 'Connection error. Please try again.';
    errorDiv.style.display = 'block';
  } finally {
    loginBtn.disabled = false;
    loginBtn.innerHTML = 'Sign In';
  }
}

// ==================== LOGOUT ====================

async function logout(message) {
  // Destroy server-side session
  if (adminToken) {
    try {
      await fetch(`${API_BASE}/logout`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${adminToken}` },
      });
    } catch (e) {
      // Ignore errors during logout
    }
  }

  adminToken = '';
  sessionStorage.removeItem('adminToken');
  // Also clean up any legacy storage
  sessionStorage.removeItem('adminPassword');

  if (inactivityTimer) {
    clearTimeout(inactivityTimer);
    inactivityTimer = null;
  }

  showLogin();
  document.getElementById('password').value = '';

  // Show message if provided (e.g., session expired)
  if (message) {
    const errorDiv = document.getElementById('loginError');
    if (errorDiv) {
      errorDiv.textContent = message;
      errorDiv.style.display = 'block';
    }
  }
}

// ==================== API REQUESTS ====================

async function apiRequest(endpoint, options = {}) {
  const headers = {
    'Authorization': `Bearer ${adminToken}`,
    'X-Requested-With': 'XMLHttpRequest',
    ...options.headers,
  };

  if (options.body && typeof options.body === 'object') {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }

  const response = await fetch(endpoint, { ...options, headers });

  if (response.status === 401) {
    logout('Your session has expired. Please log in again.');
    throw new Error('Unauthorized');
  }

  return response;
}

// ==================== INITIALIZATION ====================

document.addEventListener('DOMContentLoaded', () => {
  // Setup login form handler
  const loginForm = document.getElementById('loginForm');
  if (loginForm) {
    loginForm.addEventListener('submit', handleLogin);
  }

  // Setup activity tracking for inactivity timeout
  setupActivityTracking();

  // Check existing session
  if (checkAuth()) {
    showApp();
    if (typeof initPage === 'function') {
      initPage();
    }
  }
});
