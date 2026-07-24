const fs = require('fs');
const path = require('path');
const detectionConfig = require('./detection-config');

const viewsDir = path.join(__dirname, '..', 'views');
const partialsDir = path.join(viewsDir, 'partials');
const dashboardDist = path.join(__dirname, '..', 'dashboard', 'dist');

function getSidebarHtml() {
  return fs.readFileSync(path.join(partialsDir, 'sidebar.html'), 'utf8');
}

function getNavbarHtml() {
  return fs.readFileSync(path.join(partialsDir, 'navbar.html'), 'utf8');
}

function injectSidebar(html) {
  const sidebar = getSidebarHtml();
  if (html.includes('<!-- APP_SIDEBAR -->')) {
    return html.replace('<!-- APP_SIDEBAR -->', sidebar);
  }
  return html;
}

function injectNavbar(html) {
  const navbar = getNavbarHtml();
  if (html.includes('<!-- APP_NAVBAR -->')) {
    return html.replace('<!-- APP_NAVBAR -->', navbar);
  }
  return html;
}

function getDashboardAssets() {
  const indexHtml = fs.readFileSync(path.join(dashboardDist, 'index.html'), 'utf8');
  const scriptMatch = indexHtml.match(/src="(\/assets\/[^"]+\.js)"/);
  const cssMatch = indexHtml.match(/href="(\/assets\/[^"]+\.css)"/);
  return {
    script: scriptMatch ? scriptMatch[1] : '/assets/index.js',
    css: cssMatch ? cssMatch[1] : '/assets/index.css',
  };
}

function renderPage(pageName) {
  const pagePath = path.join(viewsDir, pageName);
  let html = fs.readFileSync(pagePath, 'utf8');

  if (pageName === 'dashboard-shell.html') {
    const assets = getDashboardAssets();
    html = html
      .replace('{{DASHBOARD_SCRIPT}}', assets.script)
      .replace('{{DASHBOARD_CSS}}', assets.css);
  }

  html = injectSidebar(html);
  html = injectNavbar(html);
  return html;
}

function renderDetectionPage(slug) {
  const tab = detectionConfig.getTab(slug);
  if (!tab) return null;

  let html = fs.readFileSync(path.join(viewsDir, 'detection-tab.html'), 'utf8');
  html = html
    .replace(/\{\{DETECTION_SLUG\}\}/g, tab.slug)
    .replace(/\{\{DETECTION_TITLE\}\}/g, tab.pageTitle)
    .replace(/\{\{DETECTION_MODEL_ID\}\}/g, tab.aiModelId)
    .replace(/\{\{BOARD_IP\}\}/g, process.env.BOARD_IP || '');

  html = injectSidebar(html);
  html = injectNavbar(html);
  return html;
}

module.exports = {
  renderPage,
  renderDetectionPage,
  getSidebarHtml,
  getNavbarHtml,
};
