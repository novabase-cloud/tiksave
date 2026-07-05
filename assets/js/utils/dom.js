const SVG_TAGS = new Set(['svg', 'path', 'g', 'circle', 'rect', 'line', 'polyline', 'polygon', 'text', 'defs', 'clipPath', 'filter', 'feDropShadow', 'feGaussianBlur', 'feOffset', 'feBlend', 'feColorMatrix', 'feFlood', 'use', 'stop', 'linearGradient', 'radialGradient', 'mask', 'pattern', 'marker']);
const SVG_NS = 'http://www.w3.org/2000/svg';

export function el(tag, attrs = {}, children = []) {
  const node = SVG_TAGS.has(tag) ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  const safeAttrs = attrs || {};
  for (const [key, value] of Object.entries(safeAttrs)) {
    if (value == null || value === false) continue;
    if (key === 'class' || key === 'className') {
      if (node instanceof SVGElement) {
        node.setAttribute('class', value);
      } else {
        node.className = value;
      }
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(node.style, value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      node.setAttribute(key, value);
    }
  }
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child == null || child === false) continue;
    if (typeof child === 'string' || typeof child === 'number') {
      node.appendChild(document.createTextNode(String(child)));
    } else if (child instanceof Node) {
      node.appendChild(child);
    }
  }
  return node;
}

export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

export function clear(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function mount(parent, child) {
  if (!parent) return;
  clear(parent);
  if (child) parent.appendChild(child);
}

export function icon(path, size = 18) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = path;
  return svg;
}
