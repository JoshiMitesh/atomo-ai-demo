const HASH_NAV = {
  '#/person': 'person',
  '#/fire-smoke': 'fire-smoke',
  '#/face': 'face',
  '#/safety': 'safety',
  '#/ai-models': 'ai-models',
  '#/settings': 'settings',
};

function sessionUrl(path) {
  const sid = sessionStorage.getItem('atomoSessionId');
  return sid ? `${path}?sessionId=${encodeURIComponent(sid)}` : path;
}

function setActiveNav() {
  const { pathname, hash } = window.location;
  let activeId = null;

  if (pathname === '/overview') {
    activeId = 'overview';
  } else if (pathname === '/alert-configuration') {
    activeId = 'alert-configuration';
  } else if (pathname === '/settings') {
    activeId = 'settings';
  } else if (pathname.startsWith('/cameras/')) {
    activeId = 'overview';
  } else if (pathname.startsWith('/detection/')) {
    activeId = pathname.split('/')[2] || null;
  } else if (pathname === '/dashboard' && hash) {
    activeId = HASH_NAV[hash] || HASH_NAV[hash.replace(/\/$/, '')] || null;
  }

  document.querySelectorAll('.ov-nav a[data-nav-id]').forEach((link) => {
    link.classList.toggle('active', link.dataset.navId === activeId);
  });
}

async function loadSidebarUser() {
  try {
    const res = await fetch(sessionUrl('/api/session'));
    const data = await res.json();
    if (!data.authenticated) return;

    if (data.sessionId) {
      sessionStorage.setItem('atomoSessionId', data.sessionId);
    }

    const name = data.username || 'User';
    const userName = document.getElementById('userName');
    const userAvatar = document.getElementById('userAvatar');
    const roleLabel = document.getElementById('userRoleLabel');
    if (userName) userName.textContent = name;
    if (userAvatar) userAvatar.textContent = name.charAt(0).toUpperCase();

    const role = data.userRole || null;
    if (roleLabel) {
      if (role?.name) {
        roleLabel.textContent = role.name;
        roleLabel.hidden = false;
      } else {
        roleLabel.hidden = true;
      }
    }

    applyNavAccess(role?.navAccess || null);
    enforceDashboardHashAccess(role);
    window.__atomoUserRole = role;
  } catch {
    /* ignore */
  }
}

function applyNavAccess(navAccess) {
  if (!navAccess || typeof navAccess !== 'object') return;
  document.querySelectorAll('.ov-nav a[data-nav-id]').forEach((link) => {
    const id = link.dataset.navId;
    const allowed = navAccess[id] !== false;
    link.style.display = allowed ? '' : 'none';
    link.toggleAttribute('aria-hidden', !allowed);
    if (!allowed) link.setAttribute('tabindex', '-1');
    else link.removeAttribute('tabindex');
  });
}

function enforceDashboardHashAccess(role) {
  if (!role?.navAccess) return;
  const { pathname, hash } = window.location;
  if (pathname !== '/dashboard') return;
  const map = {
    '#/ai-models': 'ai-models',
    '#/settings': 'settings',
    '#/health-check': 'health-check',
  };
  const key = map[hash] || map[hash.replace(/\/$/, '')];
  if (key && role.navAccess[key] === false) {
    window.location.replace(role.landingPath || '/overview');
  }
}

const THEME_STORAGE_KEY = 'atomo-overview-theme';

function applyTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem(THEME_STORAGE_KEY, next);
  updateThemeToggleButton(next);
}

function updateThemeToggleButton(theme) {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;
  const isDark = theme === 'dark';
  btn.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
  btn.setAttribute('aria-label', btn.title);
  btn.innerHTML = isDark
    ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>'
    : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';
}

function initTheme() {
  const saved = localStorage.getItem(THEME_STORAGE_KEY) || 'light';
  applyTheme(saved);

  const btn = document.getElementById('themeToggle');
  if (!btn || btn.dataset.themeBound === 'true') return;
  btn.dataset.themeBound = 'true';

  btn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    applyTheme(current === 'dark' ? 'light' : 'dark');
  });
}

async function initLogout() {
  const btn = document.getElementById('logoutBtn');
  if (!btn || btn.dataset.logoutBound === 'true') return;
  btn.dataset.logoutBound = 'true';

  btn.addEventListener('click', async () => {
    const sid = sessionStorage.getItem('atomoSessionId');
    if (sid) {
      await fetch('/api/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid }),
      });
    }
    sessionStorage.removeItem('atomoSessionId');
    window.location.href = '/login';
  });
}

function initMobileNav() {
  const toggle = document.getElementById('navToggle');
  if (!toggle) return;

  const setOpen = (open) => {
    document.body.classList.toggle('ov-nav-open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    const label = open ? 'Close menu' : 'Open menu';
    toggle.title = label;
    toggle.setAttribute('aria-label', label);
  };

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(!document.body.classList.contains('ov-nav-open'));
  });

  document.querySelectorAll('.ov-nav a').forEach((link) => {
    link.addEventListener('click', () => setOpen(false));
  });

  document.addEventListener('click', (e) => {
    if (!document.body.classList.contains('ov-nav-open')) return;
    if (e.target.closest('.ov-sidebar') || e.target.closest('#navToggle')) return;
    setOpen(false);
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth >= 1200) setOpen(false);
  });
}

function initAppShell() {
  setActiveNav();
  loadSidebarUser();
  initTheme();
  initLogout();
  initMobileNav();
  if (window.LiveMetrics && document.getElementById('liveMetricsStrip')) {
    window.LiveMetrics.init();
  }
  window.addEventListener('hashchange', () => {
    setActiveNav();
    enforceDashboardHashAccess(window.__atomoUserRole || null);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAppShell);
} else {
  initAppShell();
}
