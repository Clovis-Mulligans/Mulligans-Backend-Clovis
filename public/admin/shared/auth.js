// ==================== MULLIGANS ADMIN - AUTH ====================
// Shared authentication functions

const API_BASE = '/admin';
let adminPassword = '';

// Check if already logged in
function checkAuth() {
  const savedPassword = sessionStorage.getItem('adminPassword');
  if (savedPassword) {
    adminPassword = savedPassword;
    return true;
  }
  return false;
}

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

// Handle login form submission
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

    if (response.ok) {
      adminPassword = password;
      sessionStorage.setItem('adminPassword', password);
      showApp();
      
      // Call page-specific init if it exists
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

// Logout
function logout() {
  adminPassword = '';
  sessionStorage.removeItem('adminPassword');
  showLogin();
  document.getElementById('password').value = '';
}

// Make authenticated API request
async function apiRequest(endpoint, options = {}) {
  const headers = {
    'Authorization': `Admin ${adminPassword}`,
    ...options.headers,
  };

  if (options.body && typeof options.body === 'object') {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }

  const response = await fetch(endpoint, { ...options, headers });

  if (response.status === 401) {
    logout();
    throw new Error('Unauthorized');
  }

  return response;
}

// Initialize auth on page load
document.addEventListener('DOMContentLoaded', () => {
  // Setup login form handler
  const loginForm = document.getElementById('loginForm');
  if (loginForm) {
    loginForm.addEventListener('submit', handleLogin);
  }

  // Check existing session
  if (checkAuth()) {
    showApp();
    if (typeof initPage === 'function') {
      initPage();
    }
  }
});
