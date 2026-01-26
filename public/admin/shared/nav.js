// ==================== MULLIGANS ADMIN - NAVIGATION ====================
// Shared navigation component

// Navigation badge counts (updated from each page)
const navBadges = {
  disputes: 0,
  reports: 0,
  returns: 0,
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
        </div>
        
        <div class="nav-section">
          <div class="nav-section-title">Coming Soon</div>
          <div class="nav-item" style="opacity: 0.5; cursor: not-allowed;">
            <span class="nav-item-icon">🎫</span>
            Support Tickets
          </div>
          <div class="nav-item" style="opacity: 0.5; cursor: not-allowed;">
            <span class="nav-item-icon">💬</span>
            Feedback
          </div>
          <div class="nav-item" style="opacity: 0.5; cursor: not-allowed;">
            <span class="nav-item-icon">👥</span>
            User Management
          </div>
          <div class="nav-item" style="opacity: 0.5; cursor: not-allowed;">
            <span class="nav-item-icon">📈</span>
            Analytics
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
  } catch (error) {
    console.error('Failed to load nav badges:', error);
  }
}

// Mobile sidebar toggle
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  sidebar?.classList.toggle('open');
}

// Initialize navigation
function initNav() {
  // Insert sidebar into page
  const sidebarContainer = document.getElementById('sidebarContainer');
  if (sidebarContainer) {
    sidebarContainer.innerHTML = generateSidebar();
  }
  
  // Load badge counts
  if (typeof apiRequest === 'function' && adminPassword) {
    loadNavBadges();
  }
}

// Re-export for use in pages
window.updateNavBadge = updateNavBadge;
window.loadNavBadges = loadNavBadges;
window.toggleSidebar = toggleSidebar;
