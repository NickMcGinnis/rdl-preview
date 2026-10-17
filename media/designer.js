const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const saved = vscode.getState() || {};
const expanded = new Set(saved.expanded || []);
const errors = new Map();
let state, formKey = '', treeFocus = false;
const persist = () => vscode.setState({ expanded: [...expanded] });
const post = message => vscode.postMessage(message);
const element = (tag, props = {}, ...children) => { const e = Object.assign(document.createElement(tag), props); e.append(...children.filter(c => c !== undefined && c !== null)); return e; };

window.addEventListener('message', ({ data }) => {
  if (data?.type === 'state') render(data);
  else if (data?.type === 'fieldError') { errors.set(data.key, data.message); showErrors(); }
});
$('open-xml').addEventListener('click', () => post({ type: 'openXml' }));
$('preview').addEventListener('click', () => post({ type: 'preview' }));
$('problems').addEventListener('click', () => post({ type: 'openProblems' }));
$('form').addEventListener('submit', event => event.preventDefault());
let drawnWidth = 0;
new ResizeObserver(() => { if (state && $('wireframe').clientWidth !== drawnWidth) wireframe(); }).observe($('wireframe'));
post({ type: 'ready' });

function select(path) { if (state && path !== state.selected) { errors.clear(); post({ type: 'select', path }); } }
function render(next) {
  const changedSelection = state?.selected !== next.selected;
  state = next;
  $('file').textContent = state.file;
  $('summary').textContent = state.readOnly ? 'Read-only' : 'Changes are written to the RDL file. Use Undo to revert them.';
  $('problems').hidden = !state.problems;
  $('problems').textContent = `${state.problems} problem${state.problems === 1 ? '' : 's'}`;
  $('banner').hidden = !state.readOnly; $('banner').textContent = state.readOnly;
  // The report and its top-level lists start open.
  if (!saved.expanded && !state.readOnly) for (const node of state.tree) { expanded.add(node.path); saved.expanded = []; }
  for (const path of ancestors(state.tree, state.selected) || []) expanded.add(path);
  persist();
  if (changedSelection) errors.clear();
  tree(changedSelection);
  details();
  wireframe();
}
function ancestors(nodes, path, trail = []) {
  for (const node of nodes) {
    if (node.path === path) return trail;
    const found = ancestors(node.children, path, [...trail, node.path]);
    if (found) return found;
  }
  return undefined;
}

// Outline tree: a single-select ARIA tree with roving focus.
function tree(scroll) {
  const root = $('tree');
  const hadFocus = root.contains(document.activeElement) || treeFocus;
  root.replaceChildren();
  const add = (nodes, container, level) => nodes.forEach((node, index) => {
    const open = expanded.has(node.path), selected = node.path === state.selected;
    const item = element('li', { role: 'treeitem', tabIndex: selected ? 0 : -1, className: 'tree-item' });
    item.dataset.path = node.path;
    item.setAttribute('aria-level', level); item.setAttribute('aria-setsize', nodes.length); item.setAttribute('aria-posinset', index + 1);
    item.setAttribute('aria-selected', String(selected));
    const twisty = element('span', { className: 'twisty', textContent: node.children.length ? (open ? '▾' : '▸') : '' });
    twisty.setAttribute('aria-hidden', 'true');
    const row = element('div', { className: `row kind-${node.kind}${node.virtual ? ' virtual' : ''}` }, twisty, element('span', { className: 'badge', ariaHidden: 'true' }), element('span', { className: 'name', textContent: node.name }), node.detail ? element('span', { className: 'detail', textContent: node.detail }) : null);
    row.style.paddingLeft = `${6 + (level - 1) * 14}px`;
    item.append(row);
    if (node.children.length) {
      item.setAttribute('aria-expanded', String(open));
      if (open) { const group = element('ul', { role: 'group' }); add(node.children, group, level + 1); item.append(group); }
    }
    row.addEventListener('click', event => {
      event.stopPropagation();
      if (event.target === twisty && node.children.length) { toggle(node.path); return; }
      treeFocus = true; select(node.path);
    });
    container.append(item);
  });
  add(state.tree, root, 1);
  const current = root.querySelector('[aria-selected="true"]');
  if (current && hadFocus) current.focus();
  if (current && scroll) current.scrollIntoView({ block: 'nearest' });
  treeFocus = false;
}
function toggle(path) { if (expanded.has(path)) expanded.delete(path); else expanded.add(path); persist(); treeFocus = true; tree(false); }
$('tree').addEventListener('keydown', event => {
  const items = [...$('tree').querySelectorAll('[role=treeitem]')];
  const current = document.activeElement?.closest('[role=treeitem]');
  const index = items.indexOf(current);
  if (index < 0) return;
  const path = current.dataset.path, isOpen = current.getAttribute('aria-expanded') === 'true', hasChildren = current.hasAttribute('aria-expanded');
  const go = target => { if (target) { treeFocus = true; select(target.dataset.path); target.focus(); } };
  switch (event.key) {
    case 'ArrowDown': go(items[index + 1]); break;
    case 'ArrowUp': go(items[index - 1]); break;
    case 'Home': go(items[0]); break;
    case 'End': go(items.at(-1)); break;
    case 'ArrowRight': if (hasChildren && !isOpen) toggle(path); else if (isOpen) go(current.querySelector('[role=treeitem]')); break;
    case 'ArrowLeft': if (isOpen) toggle(path); else go(current.parentElement?.closest('[role=treeitem]')); break;
    case 'Enter': case ' ': if (hasChildren) toggle(path); break;
    default: return;
  }
  event.preventDefault();
});

// Properties form, built from the field descriptions the extension sends.
function details() {
  const d = state.details, readOnly = !!state.readOnly;
  $('details-title').textContent = d?.title || '';
  $('details-subtitle').textContent = d?.subtitle || '';
  $('actions').replaceChildren(...(d?.actions || []).map(action => {
    const button = element('button', { type: 'button', className: action.danger ? 'secondary danger' : 'secondary', textContent: action.label, disabled: readOnly || !!action.disabled });
    button.addEventListener('click', () => post({ type: 'action', path: state.selected, id: action.id, version: state.version }));
    return button;
  }));
  const key = JSON.stringify([state.selected, readOnly, (d?.fields || []).map(f => [f.key, f.type, f.readOnly, f.options?.map(o => o.value), f.columns?.length])]);
  if (key === formKey) { updateValues(d); showErrors(); return; }
  // Keep focus on the same property when the form is rebuilt for the same node, not when the selection moved.
  const sameNode = formKey.startsWith(JSON.stringify([state.selected]).slice(0, -1));
  const form = $('form'), focused = sameNode ? document.activeElement?.dataset?.key : undefined;
  formKey = key;
  form.replaceChildren();
  const sections = new Map();
  for (const field of d?.fields || []) {
    if (!sections.has(field.section)) {
      const fieldset = element('fieldset', {}, element('legend', { textContent: field.section }));
      sections.set(field.section, fieldset); form.append(fieldset);
    }
    sections.get(field.section).append(control(field, readOnly || field.readOnly));
  }
  if (focused) form.querySelector(`[data-key="${CSS.escape(focused)}"]`)?.focus();
  showErrors();
}
function send(field, value) { errors.delete(field.key); showErrors(); post({ type: 'set', path: state.selected, key: field.key, value, version: state.version }); }
function control(field, disabled) {
  const id = `field-${field.key}`;
  const wrapper = element('div', { className: `field type-${field.type}` });
  wrapper.dataset.field = field.key;
  const label = element('label', { htmlFor: id, textContent: field.label });
  let input;
  switch (field.type) {
    case 'info': return element('div', { className: 'field type-info' }, element('span', { className: 'info-label', textContent: field.label }), element('p', { className: 'info', textContent: field.value }));
    case 'image': return element('div', { className: 'field type-image' }, element('span', { className: 'info-label', textContent: field.label }), field.value ? element('img', { src: field.value, alt: 'Preview of the embedded image' }) : element('p', { className: 'info', textContent: 'No preview for this image type.' }));
    case 'checkbox': {
      input = element('input', { type: 'checkbox', id, checked: String(field.value).toLowerCase() === 'true', disabled });
      input.addEventListener('change', () => send(field, input.checked ? 'true' : 'false'));
      wrapper.classList.add('check');
      wrapper.append(input, label);
      input.dataset.key = field.key;
      return withHint(wrapper, field, input);
    }
    case 'select': {
      input = element('select', { id, disabled });
      for (const option of field.options || []) input.add(new Option(option.label, option.value, false, option.value === field.value));
      if (!field.options?.some(o => o.value === field.value)) { const blank = new Option('Choose…', '', true, true); blank.disabled = true; input.add(blank, 0); }
      input.addEventListener('change', () => send(field, input.value));
      break;
    }
    case 'table': input = table(field, id, disabled); break;
    case 'code': case 'multiline': {
      input = element('textarea', { id, value: field.value, disabled, rows: Math.min(12, Math.max(field.type === 'code' ? 2 : 3, String(field.value).split('\n').length + 1)), placeholder: field.placeholder || '', spellcheck: field.type !== 'code' });
      if (field.type === 'code') input.classList.add('code');
      input.addEventListener('change', () => send(field, input.value));
      input.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); send(field, input.value); } });
      break;
    }
    default: {
      input = element('input', { type: 'text', id, value: field.value, disabled, placeholder: field.placeholder || '', spellcheck: false });
      if (field.type === 'number') input.inputMode = 'numeric';
      input.addEventListener('change', () => send(field, input.value));
    }
  }
  input.dataset.key = field.key;
  wrapper.append(label, input);
  return withHint(wrapper, field, input);
}
function withHint(wrapper, field, input) {
  const hint = element('div', { className: 'hint', id: `hint-${field.key}`, textContent: field.hint || '' });
  hint.hidden = !field.hint;
  const error = element('div', { className: 'field-error', id: `error-${field.key}`, role: 'alert' });
  error.hidden = true;
  input.setAttribute('aria-describedby', `hint-${field.key} error-${field.key}`);
  wrapper.append(hint, error);
  return wrapper;
}
function table(field, id, disabled) {
  const container = element('div', { className: 'table', id, tabIndex: -1 });
  container.setAttribute('role', 'group');
  container.setAttribute('aria-label', field.label);
  const rows = () => [...container.querySelectorAll('tbody tr')].map(tr => [...tr.querySelectorAll('input')].map(i => i.value));
  const head = element('tr', {}, ...field.columns.map(c => element('th', { scope: 'col', textContent: c.label })), element('th', {}, element('span', { className: 'visually-hidden', textContent: 'Remove' })));
  const body = element('tbody');
  const fill = values => {
    body.replaceChildren(...values.map((row, r) => element('tr', {}, ...row.map((cell, c) => {
      const input = element('input', { type: 'text', value: cell, disabled, placeholder: field.columns[c].placeholder || '', className: field.columns[c].code ? 'code' : '', spellcheck: false });
      input.setAttribute('aria-label', `${field.columns[c].label}, row ${r + 1}`);
      input.addEventListener('change', () => send(field, rows()));
      return element('td', {}, input);
    }), element('td', {}, (() => {
      const remove = element('button', { type: 'button', className: 'icon secondary', textContent: '✕', disabled, title: 'Remove row' });
      remove.setAttribute('aria-label', `Remove row ${r + 1}`);
      remove.addEventListener('click', () => send(field, rows().filter((_, i) => i !== r)));
      return remove;
    })()))));
  };
  fill(field.value);
  container.update = values => { if (!container.contains(document.activeElement)) fill(values); };
  const add = element('button', { type: 'button', className: 'secondary', textContent: 'Add row', disabled });
  add.addEventListener('click', () => send(field, [...rows(), field.columns.map(() => '')]));
  container.append(element('table', {}, element('thead', {}, head), body), add);
  return container;
}
// Same fields as before: refresh values without rebuilding, leaving the focused control alone.
function updateValues(d) {
  for (const field of d?.fields || []) {
    const wrapper = $('form').querySelector(`[data-field="${CSS.escape(field.key)}"]`);
    if (!wrapper) continue;
    const input = wrapper.querySelector(`[data-key="${CSS.escape(field.key)}"]`);
    const hint = wrapper.querySelector('.hint');
    if (hint) { hint.textContent = field.hint || ''; hint.hidden = !field.hint; }
    if (!input || input === document.activeElement) continue;
    if (field.type === 'table') input.update(field.value);
    else if (field.type === 'checkbox') input.checked = String(field.value).toLowerCase() === 'true';
    else input.value = field.value;
  }
}
function showErrors() {
  for (const node of $('form').querySelectorAll('.field-error')) {
    const key = node.id.slice('error-'.length), message = errors.get(key);
    node.hidden = !message; node.textContent = message || '';
    node.parentElement.querySelector(`[data-key="${CSS.escape(key)}"]`)?.setAttribute('aria-invalid', String(!!message));
  }
}

// Scaled drawing of the area containing the selection.
function wireframe() {
  const frame = state.wireframe, box = $('wireframe');
  $('layout').hidden = !frame || !frame.width;
  if ($('layout').hidden) return;
  $('layout-title').textContent = `Layout — ${frame.title}`;
  const available = Math.max(160, box.clientWidth - 2);
  const scale = Math.min(96, available / frame.width);
  const page = element('div', { className: 'page' });
  page.style.width = `${frame.width * scale}px`; page.style.height = `${Math.max(frame.height, 0.25) * scale}px`;
  if (frame.path === state.selected) page.classList.add('selected');
  page.addEventListener('click', () => select(frame.path));
  for (const item of frame.items) {
    const selected = item.path === state.selected, contains = state.selected.startsWith(`${item.path}/`);
    const rect = element('div', { className: `item kind-${item.kind}${selected ? ' selected' : contains ? ' contains' : ''}`, title: `${item.name} (${item.kind})` });
    Object.assign(rect.style, { left: `${item.x * scale}px`, top: `${item.y * scale}px`, width: `${Math.max(item.width * scale, item.kind === 'Line' ? 1 : 6)}px`, height: `${Math.max(item.height * scale, item.kind === 'Line' ? 1 : 6)}px`, zIndex: String(item.depth + 1) });
    if (item.kind !== 'Line' && item.width * scale > 40 && item.height * scale > 14) rect.append(element('span', { textContent: item.name }));
    rect.addEventListener('click', event => { event.stopPropagation(); select(item.path); });
    page.append(rect);
  }
  box.replaceChildren(page);
  drawnWidth = box.clientWidth;
}
