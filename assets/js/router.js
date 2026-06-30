let routeHandler = null;

export function onRoute(fn) {
  routeHandler = fn;
}

export function navigate(path) {
  window.location.hash = `#${path}`;
}

function handleRoute() {
  const hash = window.location.hash || '#/';
  const path = hash.startsWith('#') ? hash.slice(1) : '/';
  const cleanPath = path.replace(/^\/+/, '').replace(/\/+$/, '') || '/';

  if (typeof routeHandler === 'function') {
    routeHandler(cleanPath);
  }
}

export function initRouter() {
  window.addEventListener('hashchange', handleRoute);
  handleRoute();
}
