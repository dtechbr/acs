// Offline-first application logic for USF gestão de território

const API_URL = 'https://script.google.com/macros/s/AKfycbyQNb63lB4XWzc6vTLGMX5WLXJUQGoBpZsdtl2UyZxUS-T5iEano3mA5pMAyqtgLjDTyQ/exec';

// IndexedDB database handle
let db;
// Global patient arrays used for UI rendering
let dadosGlobais = [];
let dadosExibicao = [];
// Debounce helper to prevent rapid filter re-evaluation during typing.
let _debounceTimer;
function debounce(func, delay) {
  return function(...args) {
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(() => func.apply(this, args), delay);
  };
}
// Debounced version of aplicarFiltros for use in oninput handlers.
const aplicarFiltrosDebounced = debounce(aplicarFiltros, 200);
// View state for cards versus table
let isCardView = true;
// Bootstrap modal instances
let modalEdicao;
let modalObs;
let modalCadastro;

/**
 * Open (or create) the local IndexedDB database. Two object stores are used:
 *  - patients: stores the latest known copy of patient records keyed by the planilha line
 *  - changes: queues offline edits and additions to be synced back to the server
 */
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('acsDB', 1);
    request.onupgradeneeded = event => {
      db = event.target.result;
      if (!db.objectStoreNames.contains('patients')) {
        db.createObjectStore('patients', { keyPath: 'linha' });
      }
      if (!db.objectStoreNames.contains('changes')) {
        db.createObjectStore('changes', { autoIncrement: true });
      }
    };
    request.onsuccess = event => {
      db = event.target.result;
      resolve();
    };
    request.onerror = event => reject(event.target.error);
  });
}

/**
 * Authenticate the user using the remote Apps Script. On success the app interface
 * is initialised. Credentials are not stored beyond the login session.
 */
async function autenticar() {
  const user = document.getElementById('login-user').value;
  const pass = document.getElementById('login-pass').value;
  const msgErro = document.getElementById('login-erro');
  msgErro.style.display = 'none';
  try {
    const res = await fetch(`${API_URL}?action=login&user=${encodeURIComponent(user)}&pass=${encodeURIComponent(pass)}`);
    const data = await res.json();
    if (data.autorizado) {
      localStorage.setItem('logado_usf', 'true');
      localStorage.setItem('nome_usuario', user);
      document.getElementById('tela-login').style.display = 'none';
      configurarInterfaceLogado(user);
      await iniciarApp();
    } else {
      msgErro.style.display = 'block';
    }
  } catch (err) {
    msgErro.style.display = 'block';
  }
}

/**
 * Initialise the application after login. This opens the database, syncs pending
 * changes, loads data (either online or offline) and registers the service worker.
 */
async function iniciarApp() {
  await openDB();
  await syncChanges();
  await carregarDados();
  // Register the service worker for offline support
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js');
  }
  window.addEventListener('online', syncChanges);
}

/**
 * Load data into memory. If online the latest records are downloaded and saved
 * into IndexedDB. Otherwise the existing local copy is used.
 */
async function carregarDados() {
  if (navigator.onLine) {
    await baixarDados();
  } else {
    await carregarDoDB();
  }
  aplicarFiltros();
}

/**
 * Download the latest patient list from the remote spreadsheet and persist it locally.
 */
async function baixarDados() {
  try {
    const res = await fetch(`${API_URL}?action=ler`);
    const data = await res.json();
    const patients = data.dados || [];
    dadosGlobais = patients.map(p => {
      return {
        linha: p.linha || p.row || p.id || '',
        familia: p.familia || '',
        nome: p.nome || '',
        endereco: p.endereco || '',
        numero: p.numero || '',
        telefone: p.telefone || '',
        acompanhado: p.acompanhado === true || p.acompanhado === 'TRUE' || p.acompanhado === 'true',
        has: p.has === true || p.has === 'TRUE' || p.has === 'true',
        dia1: p.dia1 === true || p.dia1 === 'TRUE' || p.dia1 === 'true',
        dia2: p.dia2 === true || p.dia2 === 'TRUE' || p.dia2 === 'true',
        insulino: p.insulino === true || p.insulino === 'TRUE' || p.insulino === 'true',
        gestante: p.gestante === true || p.gestante === 'TRUE' || p.gestante === 'true',
        acamado: p.acamado === true || p.acamado === 'TRUE' || p.acamado === 'true',
        domiciliado: p.domiciliado === true || p.domiciliado === 'TRUE' || p.domiciliado === 'true',
        bf: p.bf === true || p.bf === 'TRUE' || p.bf === 'true',
        obs: p.obs || '',
        risco: p.risco || '',
        tipo: p.tipo || '',
        mv: p.mv || '',
        cns: p.cns || '',
        dn: p.dn || '',
        sexo: p.sexo || ''
      };
    });
    const tx = db.transaction('patients', 'readwrite');
    const store = tx.objectStore('patients');
    await store.clear();
    for (const pat of dadosGlobais) {
      store.put(pat);
    }
  } catch (err) {
    console.error(err);
  }
}

/**
 * Read the local patient list from IndexedDB into memory.
 */
async function carregarDoDB() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('patients', 'readonly');
    const store = tx.objectStore('patients');
    const req = store.getAll();
    req.onsuccess = () => {
      dadosGlobais = req.result || [];
      resolve();
    };
    req.onerror = event => reject(event.target.error);
  });
}

/**
 * Apply basic search and filter operations to the full dataset. Results are stored
 * in `dadosExibicao` and then rendered as both cards and table rows.
 */
function aplicarFiltros() {
  const termo = document.getElementById('input-busca').value.toLowerCase();
  const ordem = document.getElementById('select-ordem').value;
  const filtro = document.getElementById('select-filtro').value;
  let res = dadosGlobais.filter(p => {
    const text = `${p.nome} ${p.endereco}`.toLowerCase();
    let grupMatch = true;
    if (filtro === 'has') grupMatch = p.has;
    if (filtro === 'dia') grupMatch = p.dia1 || p.dia2;
    if (filtro === 'gestante') grupMatch = p.gestante;
    if (filtro === 'risco3') grupMatch = String(p.risco).includes('3');
    if (filtro === 'crianca') {
      // Without precise age we cannot calculate; assume false
      grupMatch = false;
    }
    return text.includes(termo) && grupMatch;
  });
  // Sort the results
  if (ordem === 'familia') res.sort((a, b) => (parseInt(a.familia) || 0) - (parseInt(b.familia) || 0));
  if (ordem === 'endereco') res.sort((a, b) => a.endereco.localeCompare(b.endereco));
  if (ordem === 'nome') res.sort((a, b) => a.nome.localeCompare(b.nome));
  dadosExibicao = res;
  renderizarCartoes();
  renderizarTabela();
}

/**
 * Render the table view using `dadosExibicao`.
 */
function renderizarTabela() {
  const tbody = document.getElementById('table-body');
  tbody.innerHTML = '';
  if (dadosExibicao.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="text-center">Nenhum paciente encontrado.</td></tr>';
    return;
  }
  dadosExibicao.forEach(p => {
    const isChecked = p.acompanhado ? 'checked' : '';
    tbody.innerHTML += `
      <tr>
        <td class="align-middle fw-bold text-center">${p.familia}</td>
        <td class="align-middle">
          <strong>${p.nome}</strong><br>
          <small class="text-muted">${p.endereco}, ${p.numero}</small>
        </td>
        <td class="align-middle text-center">
          <div class="form-check form-switch d-inline-block">
            <input class="form-check-input cursor-pointer" type="checkbox" ${isChecked} onchange="alterarAcompanhamento('${p.linha}', this.checked)">
          </div>
        </td>
      </tr>
    `;
  });
}

/**
 * Render the card view using `dadosExibicao`.
 */
function renderizarCartoes() {
  const container = document.getElementById('view-cards');
  if (!container) return;
  container.innerHTML = '';
  if (dadosExibicao.length === 0) {
    container.innerHTML = '<div class="alert alert-info mt-3 text-center">Nenhum paciente encontrado.</div>';
    return;
  }
  let html = '';
  dadosExibicao.forEach(p => {
    let corBorda = '#0056b3';
    const r = String(p.risco).trim();
    if (r === '1' || r.includes('1')) corBorda = '#28a745';
    else if (r === '2' || r.includes('2')) corBorda = '#ffc107';
    else if (r === '3' || r.includes('3')) corBorda = '#dc3545';
    let badges = '';
    if (p.has) badges += `<span class="badge bg-danger badge-condicao">HAS</span>`;
    if (p.dia1 || p.dia2) badges += `<span class="badge bg-warning text-dark badge-condicao">DM</span>`;
    if (p.gestante) badges += `<span class="badge badge-condicao" style="background-color:#e83e8c;">GESTANTE</span>`;
    let obsBloco = '';
    if (p.obs && String(p.obs).trim() !== '') {
      obsBloco = `<div class="mt-2 p-2" style="background-color:#fff9c4;border-left:3px solid #fbc02d;font-size:0.85rem;border-radius:4px;color:#333;"><i class="fas fa-sticky-note text-warning"></i> <strong>Obs:</strong> ${p.obs}</div>`;
    }
    let btnWhats = '';
    if (p.telefone && String(p.telefone).length > 5) {
      const numLimpo = String(p.telefone).replace(/\D/g, '');
      btnWhats = `<a href="https://wa.me/55${numLimpo}" target="_blank" class="btn btn-success btn-sm"><i class="fab fa-whatsapp"></i></a>`;
    }
    html += `
      <div class="card patient-card" id="card-paciente-${p.linha}" style="border-left-color:${corBorda};">
        <div class="card-body py-2">
          <div class="d-flex justify-content-between">
            <div>
              <h6 class="fw-bold mb-1">${p.nome}</h6>
              <p class="mb-1 small text-muted">${p.endereco}, ${p.numero}</p>
              <div>${badges}</div>
              ${obsBloco}
            </div>
            <div class="d-flex flex-column align-items-end">
              <button class="btn btn-link text-secondary p-0 mb-2" onclick="abrirEdicao('${p.linha}')"><i class="fas fa-edit"></i></button>
              ${btnWhats}
              <div class="form-check form-switch mt-2">
                <input class="form-check-input" type="checkbox" ${p.acompanhado ? 'checked' : ''} onchange="alterarAcompanhamento('${p.linha}', this.checked)">
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  });
  container.innerHTML = html;
}

/**
 * Toggle between the card and table views.
 */
function toggleView() {
  isCardView = !isCardView;
  document.getElementById('view-cards').style.display = isCardView ? 'block' : 'none';
  document.getElementById('view-table').style.display = isCardView ? 'none' : 'block';
}

/**
 * Update the acompanhamento checkbox for a single patient. Updates the local memory and
 * queues a change to be sent to the server when connectivity allows.
 *
 * @param {string} linha Line identifier for the patient
 * @param {boolean} novoValor New accompaniment status
 */
function alterarAcompanhamento(linha, novoValor) {
  const paciente = dadosGlobais.find(p => p.linha === linha);
  if (paciente) {
    paciente.acompanhado = novoValor;
    aplicarFiltros();
  }
  queueChange({ action: 'atualizar_acompanhamento', linha: linha, valor: novoValor });
}

/**
 * Add a change record to the local queue. The queue is persisted in the 'changes'
 * store and will be synced automatically when the app is online.
 *
 * @param {Object} change Arbitrary change object mapping to Apps Script parameters
 */
function queueChange(change) {
  const tx = db.transaction('changes', 'readwrite');
  tx.objectStore('changes').add(change);
}

/**
 * Attempt to synchronise all queued changes with the remote Apps Script. If
 * offline the operation is silently skipped. After each successful sync the
 * queue is cleared.
 */
async function syncChanges() {
  if (!navigator.onLine) return;
  const tx = db.transaction('changes', 'readwrite');
  const store = tx.objectStore('changes');
  const getAll = store.getAll();
  getAll.onsuccess = async () => {
    const changes = getAll.result || [];
    for (const ch of changes) {
      const params = new URLSearchParams(ch).toString();
      try {
        await fetch(`${API_URL}?${params}`);
      } catch (err) {
        console.error('Erro ao sincronizar', ch);
      }
    }
    store.clear();
  };
}

/**
 * Open the edit modal and populate it with patient data.
 * @param {string} linha Patient key
 */
function abrirEdicao(linha) {
  const p = dadosGlobais.find(x => x.linha === linha);
  if (!p) return;
  document.getElementById('edit-linha').value = p.linha;
  document.getElementById('edit-nome').value = p.nome || '';
  document.getElementById('edit-mv').value = p.mv || '';
  document.getElementById('edit-risco').value = p.risco || '';
  document.getElementById('edit-familia').value = p.familia || '';
  document.getElementById('edit-tipo').value = p.tipo || 'CASA';
  document.getElementById('edit-endereco').value = p.endereco || '';
  document.getElementById('edit-numero').value = p.numero || '';
  document.getElementById('edit-telefone').value = p.telefone || '';
  document.getElementById('edit-cns').value = p.cns || '';
  document.getElementById('edit-dn').value = p.dn || '';
  document.getElementById('edit-sexo').value = p.sexo || 'FEMININO';
  document.getElementById('edit-has').checked = !!p.has;
  document.getElementById('edit-dia1').checked = !!p.dia1;
  document.getElementById('edit-dia2').checked = !!p.dia2;
  document.getElementById('edit-insulino').checked = !!p.insulino;
  document.getElementById('edit-gestante').checked = !!p.gestante;
  document.getElementById('edit-acamado').checked = !!p.acamado;
  document.getElementById('edit-domiciliado').checked = !!p.domiciliado;
  document.getElementById('edit-bf').checked = !!p.bf;
  if (!modalEdicao) {
    modalEdicao = new bootstrap.Modal(document.getElementById('modalEditar'));
  }
  modalEdicao.show();
}

/**
 * Save edits to an existing patient. Updates the local model, queues the change and
 * closes the modal.
 */
function salvarEdicao() {
  const linha = document.getElementById('edit-linha').value;
  const dados = {
    action: 'editar_paciente',
    linha: linha,
    nome: document.getElementById('edit-nome').value,
    mv: document.getElementById('edit-mv').value,
    risco: document.getElementById('edit-risco').value,
    familia: document.getElementById('edit-familia').value,
    tipo: document.getElementById('edit-tipo').value,
    endereco: document.getElementById('edit-endereco').value,
    numero: document.getElementById('edit-numero').value,
    telefone: document.getElementById('edit-telefone').value,
    cns: document.getElementById('edit-cns').value,
    dn: document.getElementById('edit-dn').value,
    sexo: document.getElementById('edit-sexo').value,
    has: document.getElementById('edit-has').checked,
    dia1: document.getElementById('edit-dia1').checked,
    dia2: document.getElementById('edit-dia2').checked,
    insulino: document.getElementById('edit-insulino').checked,
    gestante: document.getElementById('edit-gestante').checked,
    acamado: document.getElementById('edit-acamado').checked,
    domiciliado: document.getElementById('edit-domiciliado').checked,
    bf: document.getElementById('edit-bf').checked
  };
  const p = dadosGlobais.find(x => x.linha === linha);
  if (p) {
    Object.assign(p, dados);
    aplicarFiltros();
  }
  queueChange(dados);
  if (modalEdicao) modalEdicao.hide();
}

/**
 * Open the observation modal for a patient.
 */
function abrirObs(linha) {
  const p = dadosGlobais.find(x => x.linha === linha);
  document.getElementById('obs-linha').value = linha;
  document.getElementById('obs-texto').value = (p && p.obs) ? p.obs : '';
  if (!modalObs) {
    modalObs = new bootstrap.Modal(document.getElementById('modalObs'));
  }
  modalObs.show();
}

/**
 * Save an observation. Updates the local model and queues the change.
 */
function salvarObs() {
  const linha = document.getElementById('obs-linha').value;
  const texto = document.getElementById('obs-texto').value;
  queueChange({ action: 'salvar_observacao', linha: linha, texto: texto });
  if (modalObs) modalObs.hide();
  const p = dadosGlobais.find(x => x.linha === linha);
  if (p) {
    p.obs = texto;
    aplicarFiltros();
  }
}

/**
 * Open the new-patient modal and reset its form.
 */
function abrirModalCadastro() {
  if (!modalCadastro) {
    modalCadastro = new bootstrap.Modal(document.getElementById('modalCadastro'));
  }
  document.getElementById('formCadastro').reset();
  modalCadastro.show();
}

/**
 * Save a new patient. The entry is added to the local dataset, queued as a
 * create request and the modal is closed.
 */
function salvarNovoPaciente() {
  const form = document.getElementById('formCadastro');
  const formData = new FormData(form);
  const dados = { action: 'cadastrar_paciente' };
  formData.forEach((value, key) => { dados[key] = value; });
  const checks = ['has','dia1','dia2','insulino','gestante','acamado','domiciliado','bf'];
  checks.forEach(c => { dados[c] = form.elements[c].checked; });
  // Generate a temporary line id for the local record
  const tempLinha = `new-${Date.now()}`;
  dados.linha = tempLinha;
  // Add to local state
  dadosGlobais.push({ ...dados });
  aplicarFiltros();
  queueChange(dados);
  if (modalCadastro) modalCadastro.hide();
}

/**
 * Show the logged-in user's name in the header.
 */
function configurarInterfaceLogado(nome) {
  const area = document.getElementById('user-info-area');
  const spanNome = document.getElementById('user-logged-name');
  if (nome) {
    spanNome.innerText = nome.split(' ')[0];
    area.style.display = 'flex';
  }
}

/**
 * Log out the current user, clearing localStorage and reloading the page.
 */
function logout() {
  if (confirm('Deseja realmente sair do sistema?')) {
    localStorage.removeItem('logado_usf');
    localStorage.removeItem('nome_usuario');
    location.reload();
  }
}

/**
 * When the page loads check if the user was already logged in. If so, initialise
 * the app immediately.
 */
window.addEventListener('DOMContentLoaded', async () => {
  const estaLogado = localStorage.getItem('logado_usf');
  const nomeSalvo = localStorage.getItem('nome_usuario');
  if (estaLogado === 'true') {
    document.getElementById('tela-login').style.display = 'none';
    configurarInterfaceLogado(nomeSalvo);
    await iniciarApp();
  }
});

// Colour editing support for cards
let linhaSendoEditadaCor = null;
function abrirSeletorCor(linha) {
  linhaSendoEditadaCor = linha;
  document.getElementById('seletor-cor-card').click();
}
function aplicarNovaCor(cor) {
  if (linhaSendoEditadaCor) {
    const card = document.getElementById(`card-paciente-${linhaSendoEditadaCor}`);
    if (card) {
      card.style.borderLeftColor = cor;
    }
  }
}