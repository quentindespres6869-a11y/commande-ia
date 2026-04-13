/*  burger-menu.js — Menu de navigation partagé pour toutes les pages Commande-IA
    Inclure sur chaque page : <script src="/burger-menu.js"></script>
    Nécessite un élément avec class "logo" ou id "burger-anchor" dans la topbar
*/

(function () {
  // ─── Auth check ───
  const user = sessionStorage.getItem('user');
  const currentUser = user ? JSON.parse(user) : {};
  const isAdmin = currentUser.email === 'quentin@commande-ia.fr' || currentUser.role === 'Admin';

  // ─── Detect current page ───
  const path = window.location.pathname;

  // ─── Styles ───
  const style = document.createElement('style');
  style.textContent = `
    .burger-nav-btn {
      width: 36px; height: 36px; border-radius: 9px; background: rgba(255,255,255,0.12);
      display: flex; align-items: center; justify-content: center; cursor: pointer;
      flex-shrink: 0; transition: all 0.15s; border: none; position: relative;
    }
    .burger-nav-btn:hover { background: rgba(255,255,255,0.2); transform: scale(1.05); }
    .burger-nav-btn svg { width: 18px; height: 18px; }

    .burger-nav-menu {
      display: none; position: absolute; top: 48px; left: 0;
      width: 272px; background: #fff;
      border: 1.5px solid #e0ecd8; border-radius: 14px;
      box-shadow: 0 12px 36px rgba(0,0,0,0.14); z-index: 999; overflow: hidden;
      animation: burgerMenuIn 0.18s ease;
    }
    .burger-nav-menu.open { display: block; }
    @keyframes burgerMenuIn { from { opacity:0; transform: translateY(-6px); } to { opacity:1; transform: translateY(0); } }

    .burger-nav-inner { padding: 8px 0; }
    .burger-nav-section { padding: 8px 16px 4px; font-size: 10px; font-weight: 700; color: #9ab89a; text-transform: uppercase; letter-spacing: 1px; }
    .burger-nav-divider { height: 1px; background: #f0f5ee; margin: 6px 0; }
    .burger-nav-item {
      display: flex; align-items: center; gap: 10px; padding: 10px 16px;
      font-size: 13px; font-weight: 500; color: #1a2a1a; cursor: pointer;
      transition: background 0.1s; text-decoration: none; border: none;
      background: none; width: 100%; font-family: 'DM Sans', 'Inter', system-ui, sans-serif;
    }
    .burger-nav-item:hover { background: #f4f8f0; }
    .burger-nav-item.active { background: #f0f7e8; color: #2d6a0a; font-weight: 600; }
    .burger-nav-item.danger { color: #b03030; }
    .burger-nav-item.danger:hover { background: #fef0f0; }
    .burger-nav-item svg { flex-shrink: 0; }
    .burger-nav-item .nav-badge {
      margin-left: auto; font-size: 9px; font-weight: 700; padding: 2px 7px;
      border-radius: 4px; background: #e8f5dc; color: #2d6a0a;
    }

    /* Wrapper pour positionnement relatif */
    .burger-nav-wrapper { position: relative; display: inline-flex; }
  `;
  document.head.appendChild(style);

  // ─── Build menu HTML ───
  function isActive(href) {
    if (href === '/' || href === '/index.html') return path === '/' || path === '/index.html';
    return path === href;
  }

  function navItem(href, icon, label, options = {}) {
    const active = isActive(href) ? ' active' : '';
    const cls = options.danger ? ' danger' : '';
    const badge = options.badge ? `<span class="nav-badge">${options.badge}</span>` : '';
    const onclick = options.onclick || `window.location.href='${href}'`;
    return `<a class="burger-nav-item${active}${cls}" onclick="${onclick};closeBurgerNav()" href="javascript:void(0)">
      ${icon} ${label}${badge}
    </a>`;
  }

  const menuHTML = `
    <div class="burger-nav-inner">
      <div class="burger-nav-section">Navigation</div>
      ${navItem('/', '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="2" stroke="#3B6D11" stroke-width="1.5"/><path d="M5 8h6M5 5h6M5 11h4" stroke="#3B6D11" stroke-width="1.2" stroke-linecap="round"/></svg>', 'Tableau de bord')}
      ${navItem('/analytics.html', '<svg width="16" height="16" viewBox="0 0 15 15" fill="none"><path d="M1.5 11.5l3.5-4 3 2.5 3-5.5 2.5 2" stroke="#3B6D11" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>', 'Analytics')}
      ${navItem('/stocks.html', '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="4" rx="1" stroke="#3B6D11" stroke-width="1.3"/><rect x="2" y="8" width="12" height="4" rx="1" stroke="#3B6D11" stroke-width="1.3"/></svg>', 'Gestion des stocks')}

      <div class="burger-nav-divider"></div>
      <div class="burger-nav-section">Restaurant</div>
      ${navItem('/restaurant.html', '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5" stroke="#3B6D11" stroke-width="1.5"/><path d="M8 5v3l2 2" stroke="#3B6D11" stroke-width="1.5" stroke-linecap="round"/></svg>', 'Paramètres restaurant')}

      <div class="burger-nav-divider"></div>
      <div class="burger-nav-section">Système</div>
      ${navItem('#', '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" stroke="#3B6D11" stroke-width="1.5" stroke-linecap="round"/></svg>', 'Mode plein écran', { onclick: "document.documentElement.requestFullscreen().catch(()=>{})" })}
      ${isAdmin ? navItem('/admin.html', '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="2" stroke="#3B6D11" stroke-width="1.5"/><path d="M5 6h6M5 9h4" stroke="#3B6D11" stroke-width="1.2" stroke-linecap="round"/></svg>', 'Interface Admin', { badge: 'Admin' }) : ''}
      ${navItem('#', '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 3H3a1 1 0 00-1 1v8a1 1 0 001 1h3M10 11l3-3-3-3M13 8H6" stroke="#b03030" stroke-width="1.5" stroke-linecap="round"/></svg>', 'Déconnexion', { danger: true, onclick: "sessionStorage.removeItem('user');window.location.href='/login.html'" })}
    </div>
  `;

  // ─── Inject into page ───
  function inject() {
    // Find the logo element or a dedicated anchor
    let anchor = document.getElementById('burger-anchor');
    if (!anchor) {
      anchor = document.querySelector('.logo');
    }
    if (!anchor) {
      // If no logo found, try topbar-left
      anchor = document.querySelector('.topbar-left');
    }
    if (!anchor) return; // No suitable anchor found

    // Don't inject if already exists
    if (document.getElementById('burger-nav-menu')) return;

    // Create wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'burger-nav-wrapper';

    // Create button
    const btn = document.createElement('button');
    btn.className = 'burger-nav-btn';
    btn.id = 'burger-nav-btn';
    btn.innerHTML = '<svg viewBox="0 0 20 20" fill="none"><path d="M3 6h14M3 10h9M3 14h11" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>';
    btn.onclick = function (e) {
      e.stopPropagation();
      const menu = document.getElementById('burger-nav-menu');
      menu.classList.toggle('open');
    };

    // Create menu
    const menu = document.createElement('div');
    menu.className = 'burger-nav-menu';
    menu.id = 'burger-nav-menu';
    menu.innerHTML = menuHTML;

    wrapper.appendChild(btn);
    wrapper.appendChild(menu);

    // Insert as first child of the anchor, or replace existing logo-icon
    const existingIcon = anchor.querySelector('.logo-icon');
    if (existingIcon) {
      existingIcon.replaceWith(wrapper);
    } else {
      anchor.insertBefore(wrapper, anchor.firstChild);
    }
  }

  // ─── Global close function ───
  window.closeBurgerNav = function () {
    const menu = document.getElementById('burger-nav-menu');
    if (menu) menu.classList.remove('open');
  };

  // Close on outside click
  document.addEventListener('click', function (e) {
    if (!e.target.closest('.burger-nav-wrapper')) {
      closeBurgerNav();
    }
  });

  // ─── Init ───
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
/*  burger-menu.js — Menu de navigation partagé pour toutes les pages Commande-IA
    Inclure sur chaque page : <script src="/burger-menu.js"></script>
    Nécessite un élément avec class "logo" ou id "burger-anchor" dans la topbar
*/

(function () {
  // ─── Auth check ───
  const user = sessionStorage.getItem('user');
  const currentUser = user ? JSON.parse(user) : {};
  const isAdmin = currentUser.email === 'quentin@commande-ia.fr' || currentUser.role === 'Admin';

  // ─── Detect current page ───
  const path = window.location.pathname;

  // ─── Styles ───
  const style = document.createElement('style');
  style.textContent = `
    .burger-nav-btn {
      width: 36px; height: 36px; border-radius: 9px; background: rgba(255,255,255,0.12);
      display: flex; align-items: center; justify-content: center; cursor: pointer;
      flex-shrink: 0; transition: all 0.15s; border: none; position: relative;
    }
    .burger-nav-btn:hover { background: rgba(255,255,255,0.2); transform: scale(1.05); }
    .burger-nav-btn svg { width: 18px; height: 18px; }

    .burger-nav-menu {
      display: none; position: absolute; top: 48px; left: 0;
      width: 272px; background: #fff;
      border: 1.5px solid #e0ecd8; border-radius: 14px;
      box-shadow: 0 12px 36px rgba(0,0,0,0.14); z-index: 999; overflow: hidden;
      animation: burgerMenuIn 0.18s ease;
    }
    .burger-nav-menu.open { display: block; }
    @keyframes burgerMenuIn { from { opacity:0; transform: translateY(-6px); } to { opacity:1; transform: translateY(0); } }

    .burger-nav-inner { padding: 8px 0; }
    .burger-nav-section { padding: 8px 16px 4px; font-size: 10px; font-weight: 700; color: #9ab89a; text-transform: uppercase; letter-spacing: 1px; }
    .burger-nav-divider { height: 1px; background: #f0f5ee; margin: 6px 0; }
    .burger-nav-item {
      display: flex; align-items: center; gap: 10px; padding: 10px 16px;
      font-size: 13px; font-weight: 500; color: #1a2a1a; cursor: pointer;
      transition: background 0.1s; text-decoration: none; border: none;
      background: none; width: 100%; font-family: 'DM Sans', 'Inter', system-ui, sans-serif;
    }
    .burger-nav-item:hover { background: #f4f8f0; }
    .burger-nav-item.active { background: #f0f7e8; color: #2d6a0a; font-weight: 600; }
    .burger-nav-item.danger { color: #b03030; }
    .burger-nav-item.danger:hover { background: #fef0f0; }
    .burger-nav-item svg { flex-shrink: 0; }
    .burger-nav-item .nav-badge {
      margin-left: auto; font-size: 9px; font-weight: 700; padding: 2px 7px;
      border-radius: 4px; background: #e8f5dc; color: #2d6a0a;
    }

    /* Wrapper pour positionnement relatif */
    .burger-nav-wrapper { position: relative; display: inline-flex; }
  `;
  document.head.appendChild(style);

  // ─── Build menu HTML ───
  function isActive(href) {
    if (href === '/' || href === '/index.html') return path === '/' || path === '/index.html';
    return path === href;
  }

  function navItem(href, icon, label, options = {}) {
    const active = isActive(href) ? ' active' : '';
    const cls = options.danger ? ' danger' : '';
    const badge = options.badge ? `<span class="nav-badge">${options.badge}</span>` : '';
    const onclick = options.onclick || `window.location.href='${href}'`;
    return `<a class="burger-nav-item${active}${cls}" onclick="${onclick};closeBurgerNav()" href="javascript:void(0)">
      ${icon} ${label}${badge}
    </a>`;
  }

  const menuHTML = `
    <div class="burger-nav-inner">
      <div class="burger-nav-section">Navigation</div>
      ${navItem('/', '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="2" stroke="#3B6D11" stroke-width="1.5"/><path d="M5 8h6M5 5h6M5 11h4" stroke="#3B6D11" stroke-width="1.2" stroke-linecap="round"/></svg>', 'Tableau de bord')}
      ${navItem('/analytics.html', '<svg width="16" height="16" viewBox="0 0 15 15" fill="none"><path d="M1.5 11.5l3.5-4 3 2.5 3-5.5 2.5 2" stroke="#3B6D11" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>', 'Analytics')}
      ${navItem('/stocks.html', '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="4" rx="1" stroke="#3B6D11" stroke-width="1.3"/><rect x="2" y="8" width="12" height="4" rx="1" stroke="#3B6D11" stroke-width="1.3"/></svg>', 'Gestion des stocks')}

      <div class="burger-nav-divider"></div>
      <div class="burger-nav-section">Restaurant</div>
      ${navItem('/restaurant.html', '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5" stroke="#3B6D11" stroke-width="1.5"/><path d="M8 5v3l2 2" stroke="#3B6D11" stroke-width="1.5" stroke-linecap="round"/></svg>', 'Paramètres restaurant')}

      <div class="burger-nav-divider"></div>
      <div class="burger-nav-section">Système</div>
      ${navItem('#', '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" stroke="#3B6D11" stroke-width="1.5" stroke-linecap="round"/></svg>', 'Mode plein écran', { onclick: "document.documentElement.requestFullscreen().catch(()=>{})" })}
      ${isAdmin ? navItem('/admin.html', '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="2" stroke="#3B6D11" stroke-width="1.5"/><path d="M5 6h6M5 9h4" stroke="#3B6D11" stroke-width="1.2" stroke-linecap="round"/></svg>', 'Interface Admin', { badge: 'Admin' }) : ''}
      ${navItem('#', '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 3H3a1 1 0 00-1 1v8a1 1 0 001 1h3M10 11l3-3-3-3M13 8H6" stroke="#b03030" stroke-width="1.5" stroke-linecap="round"/></svg>', 'Déconnexion', { danger: true, onclick: "sessionStorage.removeItem('user');window.location.href='/login.html'" })}
    </div>
  `;

  // ─── Inject into page ───
  function inject() {
    // Find the logo element or a dedicated anchor
    let anchor = document.getElementById('burger-anchor');
    if (!anchor) {
      anchor = document.querySelector('.logo');
    }
    if (!anchor) {
      // If no logo found, try topbar-left
      anchor = document.querySelector('.topbar-left');
    }
    if (!anchor) return; // No suitable anchor found

    // Don't inject if already exists
    if (document.getElementById('burger-nav-menu')) return;

    // Create wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'burger-nav-wrapper';

    // Create button
    const btn = document.createElement('button');
    btn.className = 'burger-nav-btn';
    btn.id = 'burger-nav-btn';
    btn.innerHTML = '<svg viewBox="0 0 20 20" fill="none"><path d="M3 6h14M3 10h9M3 14h11" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>';
    btn.onclick = function (e) {
      e.stopPropagation();
      const menu = document.getElementById('burger-nav-menu');
      menu.classList.toggle('open');
    };

    // Create menu
    const menu = document.createElement('div');
    menu.className = 'burger-nav-menu';
    menu.id = 'burger-nav-menu';
    menu.innerHTML = menuHTML;

    wrapper.appendChild(btn);
    wrapper.appendChild(menu);

    // Insert as first child of the anchor, or replace existing logo-icon
    const existingIcon = anchor.querySelector('.logo-icon');
    if (existingIcon) {
      existingIcon.replaceWith(wrapper);
    } else {
      anchor.insertBefore(wrapper, anchor.firstChild);
    }
  }

  // ─── Global close function ───
  window.closeBurgerNav = function () {
    const menu = document.getElementById('burger-nav-menu');
    if (menu) menu.classList.remove('open');
  };

  // Close on outside click
  document.addEventListener('click', function (e) {
    if (!e.target.closest('.burger-nav-wrapper')) {
      closeBurgerNav();
    }
  });

  // ─── Init ───
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
