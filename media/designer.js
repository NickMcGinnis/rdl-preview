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
  else if (data?.type === 'fieldError') { $('form').querySelector(`[data-key="${CSS.escape(data.key)}"]`)?.revert?.(); errors.set(data.key, data.message); showErrors(); }
});
$('open-xml').addEventListener('click', () => post({ type: 'openXml' }));
$('preview').addEventListener('click', () => post({ type: 'preview' }));
$('problems').addEventListener('click', () => post({ type: 'openProblems' }));
$('form').addEventListener('submit', event => event.preventDefault());
let drawnWidth = 0;
new ResizeObserver(() => { if (state && $('wireframe').clientWidth !== drawnWidth) wireframe(); }).observe($('wireframe'));
post({ type: 'ready' });
// Extension-host tests drive the real controls through this. Only test builds mark the page.
if (document.body.dataset.test !== undefined) window.addEventListener('message', ({ data }) => {
  if (data?.type !== 'probe') return;
  const find = selector => { const e = document.querySelector(selector); if (!e) throw new Error(`No element matches ${selector}`); return e; };
  let error = '';
  try {
    for (const step of data.steps) {
      const target = find(step.selector);
      if (step.click) { target.focus(); target.click(); }
      if (step.focus) target.focus();
      if (step.type !== undefined) { target.focus(); target.value = step.type; target.dispatchEvent(new Event('input', { bubbles: true })); }
      if (step.caret !== undefined) target.setSelectionRange(step.caret, step.caret);
      if (step.mark) target.dataset.mark = step.mark;
      if (step.change) target.dispatchEvent(new Event('change', { bubbles: true }));
    }
  } catch (e) { error = e.message; }
  const active = document.activeElement, table = active?.closest('.table'), tr = active?.closest('tbody tr');
  const tables = Object.fromEntries([...document.querySelectorAll('#form .table')].map(t => [t.dataset.key, [...t.querySelectorAll('tbody tr')].map(r => [...r.querySelectorAll('input')].map(i => i.value))]));
  const focus = table ? { table: table.dataset.key, row: tr ? [...tr.parentElement.rows].indexOf(tr) : -1, control: tr ? [...tr.querySelectorAll('input, button')].indexOf(active) : -1, add: active === table.querySelector(':scope > button'), value: active.value, caret: active.selectionStart, mark: active.dataset.mark } : { tag: active?.tagName };
  post({ type: 'probe', id: data.id, result: { error, version: state?.version, tables, focus } });
});

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
function send(field, value, base) { errors.delete(field.key); showErrors(); post({ type: 'set', path: state.selected, key: field.key, value, base, version: state.version }); }
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
// Rows show the extension's last values plus edits sent since, so add and remove show at once and
// each edit builds on the one before it. Rows are reconciled in place to keep focus and the caret.
function table(field, id, disabled) {
  const container = element('div', { className: 'table', id, tabIndex: -1 });
  container.setAttribute('role', 'group');
  container.setAttribute('aria-label', field.label);
  const copy = values => values.map(row => [...row]);
  let confirmed = copy(field.value), shown = confirmed;
  const edited = new WeakSet();
  const head = element('tr', {}, ...field.columns.map(c => element('th', { scope: 'col', textContent: c.label })), element('th', {}, element('span', { className: 'visually-hidden', textContent: 'Remove' })));
  const body = element('tbody');
  const add = element('button', { type: 'button', className: 'secondary', textContent: 'Add row', disabled });
  const indexOf = node => [...body.rows].indexOf(node.closest('tr'));
  // The extension accepts the change if the table still holds what this one was based on.
  const commit = next => { const base = shown; shown = next; reconcile(); send(field, next, base); };
  const row = () => element('tr', {}, ...field.columns.map((column, c) => {
    const input = element('input', { type: 'text', disabled, placeholder: column.placeholder || '', className: column.code ? 'code' : '', spellcheck: false });
    input.addEventListener('input', () => edited.add(input));
    input.addEventListener('change', () => {
      edited.delete(input);
      const r = indexOf(input);
      commit(shown.map((cells, i) => i === r ? cells.map((cell, j) => j === c ? input.value : cell) : cells));
    });
    return element('td', {}, input);
  }), element('td', {}, (() => {
    const remove = element('button', { type: 'button', className: 'icon secondary', textContent: '✕', disabled, title: 'Remove row' });
    remove.addEventListener('click', () => { const r = indexOf(remove); commit(shown.filter((_, i) => i !== r)); });
    return remove;
  })()));
  function reconcile() {
    const active = document.activeElement, focusRow = container.contains(active) ? indexOf(active) : -1;
    const focusControl = focusRow >= 0 ? [...body.rows[focusRow].querySelectorAll('input, button')].indexOf(active) : -1;
    while (body.rows.length > shown.length) body.lastElementChild.remove();
    while (body.rows.length < shown.length) body.append(row());
    [...body.rows].forEach((tr, r) => {
      tr.querySelectorAll('input').forEach((input, c) => {
        // Leave text the user is typing alone.
        if ((input !== active || !edited.has(input)) && input.value !== shown[r][c]) input.value = shown[r][c];
        input.setAttribute('aria-label', `${field.columns[c].label}, row ${r + 1}`);
      });
      tr.querySelector('button').setAttribute('aria-label', `Remove row ${r + 1}`);
    });
    // The focused row was removed: move to the same control in the row before it, else to Add row.
    if (focusRow >= 0 && !active.isConnected) (body.rows[Math.min(focusRow, shown.length - 1)]?.querySelectorAll('input, button')[focusControl] || add).focus();
  }
  reconcile();
  add.addEventListener('click', () => { commit([...shown, field.columns.map(() => '')]); body.lastElementChild.querySelector('input').focus(); });
  container.update = values => { confirmed = shown = copy(values); reconcile(); };
  // The extension rejected an edit: show what the report holds.
  container.revert = () => { shown = confirmed; reconcile(); };
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
    if (field.type === 'table') input?.update(field.value);
    else if (!input || input === document.activeElement) continue;
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
