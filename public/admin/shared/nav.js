// ==================== MULLIGANS ADMIN - NAVIGATION ====================
// Shared navigation component

// Navigation badge counts (updated from each page)
const navBadges = {
  disputes: 0,
  reports: 0,
  returns: 0,
  claims: 0,
  support: 0,
  feedback: 0,
};

// Get current page from URL
function getCurrentPage() {
  const path = window.location.pathname;
  const filename = path.split('/').pop().replace('.html', '') || 'index';
  return filename;
}

// Generate sidebar HTML
function generateSidebar() {
  const currentPage = getCurrentPage();
  
  return `
    <div class="sidebar" id="sidebar">
      <div class="sidebar-header">
        <div class="sidebar-logo">
          <div class="sidebar-logo-icon">🏌️</div>
          <div>
            <h1>MULLIGANS</h1>
            <span>Admin Dashboard</span>
          </div>
        </div>
      </div>
      
      <nav class="sidebar-nav">
        <div class="nav-section">
          <div class="nav-section-title">Overview</div>
          <a href="index.html" class="nav-item ${currentPage === 'index' ? 'active' : ''}">
            <span class="nav-item-icon">📊</span>
            Dashboard
          </a>
          <a href="analytics.html" class="nav-item ${currentPage === 'analytics' ? 'active' : ''}">
            <span class="nav-item-icon">📈</span>
            Analytics
          </a>
        </div>
        
        <div class="nav-section">
          <div class="nav-section-title">Operations</div>
          <a href="disputes.html" class="nav-item ${currentPage === 'disputes' ? 'active' : ''}">
            <span class="nav-item-icon">⚖️</span>
            Disputes
            <span class="nav-item-badge" id="navBadgeDisputes" style="display: none;">0</span>
          </a>
          <a href="reports.html" class="nav-item ${currentPage === 'reports' ? 'active' : ''}">
            <span class="nav-item-icon">🚩</span>
            User Reports
            <span class="nav-item-badge" id="navBadgeReports" style="display: none;">0</span>
          </a>
          <a href="returns.html" class="nav-item ${currentPage === 'returns' ? 'active' : ''}">
            <span class="nav-item-icon">📦</span>
            Returns
            <span class="nav-item-badge" id="navBadgeReturns" style="display: none;">0</span>
          </a>
          <a href="claims.html" class="nav-item ${currentPage === 'claims' ? 'active' : ''}">
            <span class="nav-item-icon">🛡️</span>
            Insurance Claims
            <span class="nav-item-badge" id="navBadgeClaims" style="display: none;">0</span>
          </a>
        </div>
        
        <div class="nav-section">
          <div class="nav-section-title">Management</div>
          <a href="users.html" class="nav-item ${currentPage === 'users' ? 'active' : ''}">
            <span class="nav-item-icon">👥</span>
            Users
          </a>
        </div>
        
        <div class="nav-section">
          <div class="nav-section-title">Planned</div>
          <div class="nav-item" style="opacity: 0.35; cursor: not-allowed;">
            <span class="nav-item-icon">🎫</span>
            Support Tickets
          </div>
          <div class="nav-item" style="opacity: 0.35; cursor: not-allowed;">
            <span class="nav-item-icon">💬</span>
            Feedback
          </div>
        </div>
      </nav>
      
      <div class="sidebar-footer">
        <div class="user-info">
          <div class="user-avatar">A</div>
          <div class="user-details">
            <h4>Admin</h4>
            <p>Mulligans Golf Ltd</p>
          </div>
        </div>
      </div>
    </div>
  `;
}

// Update nav badge
function updateNavBadge(section, count) {
  navBadges[section] = count;
  const badge = document.getElementById(`navBadge${section.charAt(0).toUpperCase() + section.slice(1)}`);
  if (badge) {
    if (count > 0) {
      badge.textContent = count;
      badge.style.display = 'block';
    } else {
      badge.style.display = 'none';
    }
  }
}

// Load all badge counts from API
async function loadNavBadges() {
  try {
    // Load disputes count
    const disputesRes = await apiRequest(`${API_BASE}/disputes`);
    if (disputesRes.ok) {
      const data = await disputesRes.json();
      const escalated = (data.disputes || []).filter(d => d.status === 'escalated').length;
      updateNavBadge('disputes', escalated);
    }

    // Load reports count
    const reportsRes = await apiRequest(`${API_BASE}/reports`);
    if (reportsRes.ok) {
      const data = await reportsRes.json();
      updateNavBadge('reports', data.stats?.pending || 0);
    }

    // Load returns count
    const returnsRes = await apiRequest(`${API_BASE}/returns?tab=pending`);
    if (returnsRes.ok) {
      const data = await returnsRes.json();
      const pending = (data.stats?.pending || 0) + (data.stats?.delivered || 0);
      updateNavBadge('returns', pending);
    }

    // Load claims count
    const claimsRes = await apiRequest(`${API_BASE}/claims`);
    if (claimsRes.ok) {
      const data = await claimsRes.json();
      updateNavBadge('claims', data.stats?.reported || 0);
    }
  } catch (error) {
    console.error('Failed to load nav badges:', error);
  }
}

// Mobile sidebar toggle
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebarBackdrop');
  sidebar?.classList.toggle('open');
  backdrop?.classList.toggle('active');
}

// Initialize navigation
function initNav() {
  // Insert sidebar into page
  const sidebarContainer = document.getElementById('sidebarContainer');
  if (sidebarContainer) {
    sidebarContainer.innerHTML = generateSidebar();
  }

  // Add hamburger button to header (mobile only)
  const header = document.querySelector('.main-header');
  if (header && !document.querySelector('.hamburger-btn')) {
    const hamburger = document.createElement('button');
    hamburger.className = 'hamburger-btn';
    hamburger.innerHTML = '☰';
    hamburger.onclick = toggleSidebar;
    header.insertBefore(hamburger, header.firstChild);
  }

  // Add backdrop overlay for mobile sidebar
  if (!document.getElementById('sidebarBackdrop')) {
    const backdrop = document.createElement('div');
    backdrop.id = 'sidebarBackdrop';
    backdrop.className = 'sidebar-backdrop';
    backdrop.onclick = toggleSidebar;
    document.body.appendChild(backdrop);
  }

  // Load badge counts
  if (typeof apiRequest === 'function' && adminToken) {
    loadNavBadges();
  }
}

// Re-export for use in pages
window.updateNavBadge = updateNavBadge;
window.loadNavBadges = loadNavBadges;
window.toggleSidebar = toggleSidebar;