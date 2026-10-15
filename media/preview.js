import * as pdfjs from './pdfjs/pdf.mjs';

const vscode = acquireVsCodeApi();
// VS Code webview workers must be loaded from a blob/data URL. Fetch the
// bundled, self-contained worker in the page, then start it without imports
// that would bypass the webview's local-resource service worker.
const workerReady = (async () => {
  const response = await fetch(new URL('./pdfjs/pdf.worker.mjs', import.meta.url));
  if (!response.ok) throw new Error('The bundled PDF worker could not be loaded.');
  const source = await response.text();
  const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  const worker = new Worker(blobUrl, { type: 'module' });
  pdfjs.GlobalWorkerOptions.workerPort = worker;
  window.addEventListener('unload', () => { worker.terminate(); URL.revokeObjectURL(blobUrl); });
})();
// The preview handler displays any startup failure when a PDF is requested.
workerReady.catch(() => {});
const $ = id => document.getElementById(id);
let state, pdfDocument, pdfLoading, currentPage = 1, rendering, drawSequence = 0;
const bindings = new Map();
let refreshTimer;

function collectValues() {
  const result = Object.create(null);
  for (const [name, binding] of bindings) {
    const { parameter: p, input, nullInput } = binding;
    if (nullInput?.checked) { result[name] = [null]; continue; }
    if (p.validValues !== undefined) {
      const selected = [...input.selectedOptions].filter(option => option.value !== 'unset');
      if (selected.length) result[name] = selected.map(option => p.validValues[Number(option.value)].value);
    } else if (p.type === 'Boolean') {
      if (input.value !== 'unset') result[name] = [input.value];
    } else if (p.multiValue) {
      if (input.value.length) result[name] = input.value.replace(/\r/g, '').split('\n');
    } else if (input.value.length || p.allowBlank) result[name] = [input.value];
  }
  // Hidden/internal defaults remain available to SSRS but aren't editable controls.
  for (const p of state.parameters.filter(p => !p.promptUser)) if (state.values[p.name]) result[p.name] = state.values[p.name];
  return result;
}
function send(type) { if (!state || state.busy || state.invalidated) return; vscode.postMessage({ type, values: collectValues() }); }
$('parameters-form').addEventListener('submit', event => { event.preventDefault(); send('render'); });
$('refresh').addEventListener('click', () => send('refresh'));
$('save').addEventListener('click', () => vscode.postMessage({ type: 'savePdf' }));
$('previous').addEventListener('click', () => { if (currentPage > 1) { currentPage--; void draw(); } });
$('next').addEventListener('click', () => { if (pdfDocument && currentPage < pdfDocument.numPages) { currentPage++; void draw(); } });
$('zoom').addEventListener('change', () => void draw());
new ResizeObserver(() => { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { if (pdfDocument && $('zoom').value === 'fit') void draw(); }, 120); }).observe($('pdf-scroll'));

function fields() {
  const root = $('fields'); root.replaceChildren(); bindings.clear();
  const visible = state.parameters.filter(p => p.promptUser);
  $('count').textContent = visible.length ? String(visible.length) : '';
  if (!visible.length) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = state.loaded ? 'This report has no visible parameters.' : 'Loading parameters from the report server…'; root.append(p); }
  visible.forEach((p, index) => {
    const wrapper = document.createElement('div'); wrapper.className = 'field';
    const id = `parameter-${index}`, label = document.createElement('label'); label.htmlFor = id; label.textContent = p.prompt;
    const description = document.createElement('div'); description.className = 'field-description'; description.id = `${id}-description`;
    description.textContent = [p.name, p.type, p.multiValue ? 'multiple values' : '', p.dependencies.length ? `depends on ${p.dependencies.join(', ')}` : ''].filter(Boolean).join(' · ');
    let input;
    const values = state.values[p.name] || [];
    if (p.validValues !== undefined || p.type === 'Boolean') {
      input = document.createElement('select'); input.multiple = p.multiValue;
      if (p.validValues !== undefined) {
        if (!p.multiValue) input.add(new Option('Select a value…', 'unset', false, !values.length));
        p.validValues.forEach((v, i) => input.add(new Option(v.label, String(i), false, values.includes(v.value))));
      } else {
        input.add(new Option('Select a value…', 'unset', false, !values.length));
        input.add(new Option('True', 'true', false, values.some(v => v?.toLowerCase() === 'true')));
        input.add(new Option('False', 'false', false, values.some(v => v?.toLowerCase() === 'false')));
      }
    } else if (p.multiValue) {
      input = document.createElement('textarea'); input.value = values.filter(v => v !== null).join('\n'); input.placeholder = 'One value per line';
    } else {
      input = document.createElement('input'); input.type = 'text'; input.value = values[0] ?? '';
      if (p.type === 'Integer') input.inputMode = 'numeric';
      if (p.type === 'Float') input.inputMode = 'decimal';
      if (p.type === 'DateTime') input.placeholder = 'YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss';
    }
    input.id = id; input.name = p.name; input.disabled = state.busy || state.invalidated || p.state === 'HasOutstandingDependencies'; input.setAttribute('aria-describedby', description.id);
    wrapper.append(label, description, input);
    let nullInput;
    if (p.nullable && !p.multiValue) {
      const nullLabel = document.createElement('label'); nullLabel.className = 'null-choice';
      nullInput = document.createElement('input'); nullInput.type = 'checkbox'; nullInput.checked = values.length === 1 && values[0] === null; nullInput.disabled = state.busy || state.invalidated;
      nullLabel.append(nullInput, document.createTextNode('Use null')); wrapper.append(nullLabel);
      const update = () => { input.disabled = nullInput.checked || state.busy || state.invalidated || p.state === 'HasOutstandingDependencies'; };
      nullInput.addEventListener('change', () => { update(); parentChanged(p); }); update();
    }
    const error = state.errors[p.name] || p.error;
    if (error) {
      const message = document.createElement('div'); message.id = `${id}-error`; message.className = 'field-error'; message.textContent = error;
      input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', `${description.id} ${message.id}`); wrapper.append(message);
    }
    input.addEventListener('change', () => parentChanged(p));
    bindings.set(p.name, { parameter: p, input, nullInput }); root.append(wrapper);
  });
}
function parentChanged(p) { if (state.parameters.some(child => child.dependencies.includes(p.name))) send('refresh'); }
function update(next) {
  // Retain pending edits across busy-state updates; server replies supply new fields.
  const focused = document.activeElement?.id;
  const pending = state && !state.busy ? collectValues() : null;
  if (next.busy && pending) next.values = pending;
  state = next;
  $('report').textContent = state.report;
  $('environment').textContent = `${state.environment}${state.serverUrl ? ` · ${state.serverUrl}` : ''}`;
  $('demo-notice').hidden = !state.demo;
  $('error').hidden = !state.error; $('error').textContent = state.error || '';
  $('warnings').textContent = state.warnings.join('\n');
  fields();
  const disabled = state.busy || !state.loaded || state.invalidated;
  $('render').disabled = disabled; $('refresh').disabled = disabled;
  $('render').textContent = state.busy ? 'Working…' : 'Render preview';
  $('save').disabled = !state.hasPdf;
  $('render-status').textContent = state.busy ? 'Waiting for report execution…' : state.hasPdf ? 'Last successful preview. Render after changing parameters; run Preview Report again after editing the RDL.' : '';
  if (!state.busy && focused) $(focused)?.focus();
}
async function draw() {
  if (!pdfDocument) return;
  const sequence = ++drawSequence;
  rendering?.cancel();
  try {
    const page = await pdfDocument.getPage(currentPage);
    if (sequence !== drawSequence) return;
    const original = page.getViewport({ scale: 1 });
    const scale = $('zoom').value === 'fit' ? Math.max(.2, ($('pdf-scroll').clientWidth - 48) / original.width) : Number($('zoom').value);
    const viewport = page.getViewport({ scale });
    const ratio = Math.min(window.devicePixelRatio || 1, 2), canvas = $('pdf-canvas');
    canvas.width = Math.ceil(viewport.width * ratio); canvas.height = Math.ceil(viewport.height * ratio);
    canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
    canvas.setAttribute('aria-label', `Report page ${currentPage} of ${pdfDocument.numPages}. Save the PDF to open it in an accessible PDF reader.`);
    rendering = page.render({ canvasContext: canvas.getContext('2d'), canvas, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
    await rendering.promise;
    if (sequence !== drawSequence) return;
    $('page-status').textContent = `Page ${currentPage} of ${pdfDocument.numPages}`;
    $('previous').disabled = currentPage === 1; $('next').disabled = currentPage === pdfDocument.numPages;
    vscode.postMessage({ type: 'pdfDisplayed', pages: pdfDocument.numPages });
    $('empty').hidden = true; canvas.hidden = false; $('pdf-toolbar').hidden = false;
  } catch (error) {
    if (error.name === 'RenderingCancelledException') return;
    $('render-status').textContent = `PDF display failed: ${error.message}. Use Save PDF to view it externally.`;
    vscode.postMessage({ type: 'pdfError', error: error.message });
  }
}
window.addEventListener('message', async event => {
  const message = event.data;
  if (message.type === 'state') update(message);
  else if (message.type === 'pdf') {
    try {
      if (pdfLoading) await pdfLoading.destroy();
      const binary = atob(message.base64), data = Uint8Array.from(binary, c => c.charCodeAt(0));
      const base = new URL('./pdfjs/', import.meta.url).href;
      await workerReady;
      pdfLoading = pdfjs.getDocument({ data, useWorkerFetch: false, standardFontDataUrl: base + 'standard_fonts/', cMapUrl: base + 'cmaps/', cMapPacked: true, wasmUrl: base + 'wasm/', isEvalSupported: false });
      pdfDocument = await pdfLoading.promise;
      currentPage = 1; await draw();
    } catch (error) {
      $('render-status').textContent = `PDF display failed: ${error.message}. Use Save PDF to view it externally.`;
      vscode.postMessage({ type: 'pdfError', error: error.message });
    }
  }
});
vscode.postMessage({ type: 'ready' });
