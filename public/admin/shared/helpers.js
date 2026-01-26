// ==================== MULLIGANS ADMIN - HELPERS ====================
// Shared utility functions

// Format date
function formatDate(dateStr) {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Get relative age (e.g., "2h ago", "3d ago")
function getAge(dateStr) {
  const created = new Date(dateStr);
  const now = new Date();
  const diffMs = now - created;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return formatDate(dateStr).split(',')[0];
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Format dispute status
function formatStatus(status) {
  const map = {
    'open': 'Open',
    'counter_offered': 'Counter Offered',
    'escalated': 'Escalated',
    'admin_resolved': 'Resolved',
    'resolved': 'Resolved',
    'accepted': 'Accepted',
  };
  return map[status] || status;
}

// Format reason type
function formatReasonType(type) {
  const map = {
    'not_as_described': 'Item not as described',
    'damaged': 'Item arrived damaged',
    'wrong_item': 'Wrong item sent',
    'counterfeit': 'Item appears counterfeit',
    'missing_parts': 'Missing parts/accessories',
    'other': 'Other issue',
  };
  return map[type] || type;
}

// Format resolution type
function formatResolutionType(type) {
  const map = {
    'full_refund': 'Full Refund to Buyer',
    'partial_refund': 'Partial Refund',
    'no_refund': 'No Refund (Claim Denied)',
  };
  return map[type] || type;
}

// Format report reason
function formatReportReason(reason) {
  const map = {
    'scam': '🚨 Scam/Fraud',
    'inappropriate_messages': '💬 Inappropriate Messages',
    'other': '📋 Other',
  };
  return map[reason] || reason;
}

// Format return status
function formatReturnStatus(status) {
  const map = {
    'pending': 'Pending',
    'approved': 'Approved',
    'awaiting_address': 'Awaiting Address',
    'label_created': 'Label Created',
    'shipped': 'Shipped',
    'in_transit': 'In Transit',
    'delivered': 'Delivered',
    'completed': 'Completed',
    'cancelled': 'Cancelled',
    'expired': 'Expired',
  };
  return map[status] || status;
}

// Format currency
function formatCurrency(amount) {
  return `£${parseFloat(amount || 0).toFixed(2)}`;
}

// Format number with commas
function formatNumber(num) {
  return num?.toLocaleString() || '0';
}

// Format percentage
function formatPercent(num) {
  return `${parseFloat(num || 0).toFixed(1)}%`;
}

// Get dispute priority
function getPriority(dispute) {
  if (dispute.status === 'escalated') return 'high';
  if (dispute.requested_refund_amount > 100) return 'medium';
  return 'low';
}

// Get urgency tags for dispute
function getUrgencyTags(dispute) {
  const tags = [];
  if (dispute.auto_escalated) {
    tags.push('<span class="urgency-tag auto">⏰ Auto-escalated</span>');
  }
  if (dispute.requested_refund_amount >= 100) {
    tags.push('<span class="urgency-tag high-value">💎 High Value</span>');
  }
  return tags.join('');
}

// Get return priority
function getReturnPriority(ret) {
  if (ret.status === 'delivered') return 'delivered';
  if (ret.status === 'shipped') return 'shipped';
  if (['pending', 'approved', 'awaiting_address', 'label_created'].includes(ret.status)) return 'pending';
  return 'completed';
}

// Show toast notification
function showToast(message, type = 'success') {
  // Create toast element
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'}</span>
    <span class="toast-message">${message}</span>
  `;
  
  // Add to page
  document.body.appendChild(toast);
  
  // Animate in
  setTimeout(() => toast.classList.add('show'), 10);
  
  // Remove after delay
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// Debounce function for search
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// Copy to clipboard
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('Copied to clipboard!');
  } catch (err) {
    console.error('Failed to copy:', err);
    showToast('Failed to copy', 'error');
  }
}

// Open image in modal
function openImage(url) {
  event?.stopPropagation();
  const modal = document.getElementById('imageModal');
  const img = document.getElementById('imageModalImg');
  if (modal && img) {
    img.src = url;
    modal.classList.add('active');
  }
}

// Close image modal
function closeImageModal() {
  const modal = document.getElementById('imageModal');
  if (modal) {
    modal.classList.remove('active');
  }
}

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // Close any open modals
    document.querySelectorAll('.modal-overlay.active, .image-modal.active').forEach(modal => {
      modal.classList.remove('active');
    });
  }
});
