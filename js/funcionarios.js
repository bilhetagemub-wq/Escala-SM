// ======================================================
// Escala São Miguel
// funcionarios.js — funcionários organizados por turma (fim de semana A / B)
// ======================================================
//
// Arrastar um cartão entre "Fim de semana A", "Fim de semana B" e
// "Sem fim de semana" muda a turma da pessoa. A equipe (função) é
// definida no cadastro e aparece como rótulo e filtro.

import { db } from "./firebase.js";
import { montarLayout, aviso } from "./layout.js";
import {
    ouvirEquipes, ouvirFuncionarios, lerConfig, CORES_EQUIPE, TIPOS, TURMAS, esc, iniciais,
    tipoDoFuncionario, turmaDe, ehEncarregado, modoEncarregado, ordenarPorEquipe, proximaCor, normalizar
} from "./dados.js";
import { equipeDoFimDeSemana, sabadoDoFimDeSemana, somarDias, hojeISO, dataCurta } from "./escala-engine.js";
import { iniciarImportacao, exportarPlanilha } from "./importacao.js";

import {
    collection, doc, addDoc, updateDoc, deleteDoc, writeBatch
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

montarLayout("funcionarios");

// ------------------------------------------------------
// Estado
// ------------------------------------------------------

const SEM_TURMA = "__sem__";

let equipes = [];
let funcionarios = [];
let configs = {};
let arrastando = false;
let tipoAtual = new URLSearchParams(location.search).get("tipo") === "noturna" ? "noturna" : "diurna";
const filtro = { texto: "", equipe: "", inativos: false };

const quadro = document.getElementById("quadro");
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------
// Dados em tempo real
// ------------------------------------------------------

const pronto = { equipes: false, funcionarios: false };

ouvirEquipes((l) => { equipes = l; pronto.equipes = true; pedirRender(); });
ouvirFuncionarios((l) => { funcionarios = l; pronto.funcionarios = true; pedirRender(); });

async function carregarConfig(tipo) {
    try {
        configs[tipo] = await lerConfig(tipo);
    } catch (erro) {
        console.error(erro);
        configs[tipo] = {};
    }
    pedirRender();
}
carregarConfig("diurna");
carregarConfig("noturna");

function pedirRender() {
    if (!pronto.equipes || !pronto.funcionarios || arrastando) return;
    render();
}

// ------------------------------------------------------
// Auxiliares
// ------------------------------------------------------

const equipePorId = (id) => equipes.find((e) => e.id === id);
const lider = (f) => ehEncarregado(f, equipes);
const daEscala = (tipo = tipoAtual) => funcionarios.filter((f) => tipoDoFuncionario(f) === tipo);
const modo = () => modoEncarregado(configs[tipoAtual], tipoAtual);

function passaNoFiltro(f) {
    if (!filtro.inativos && f.status === "Inativo") return false;
    if (filtro.equipe === "__sem__" && equipePorId(f.equipeId)) return false;
    if (filtro.equipe && filtro.equipe !== "__sem__" && f.equipeId !== filtro.equipe) return false;
    if (filtro.texto) {
        const alvo = normalizar(`${f.nome} ${f.matricula} ${f.funcao} ${equipePorId(f.equipeId)?.nome || ""}`);
        if (!alvo.includes(filtro.texto)) return false;
    }
    return true;
}

// próxima data em que a turma trabalha (para mostrar no topo da coluna)
function proximoPlantao(turma) {
    const cfg = configs[tipoAtual];
    if (!cfg) return null;
    let sab = sabadoDoFimDeSemana(hojeISO());
    for (let i = 0; i < 8; i++, sab = somarDias(sab, 7)) {
        const noSab = equipeDoFimDeSemana(sab, cfg, TURMAS) === turma;
        const noDom = equipeDoFimDeSemana(somarDias(sab, 1), cfg, TURMAS) === turma;
        if (noSab) return sab;
        if (noDom) return somarDias(sab, 1);
    }
    return null;
}

// ------------------------------------------------------
// Renderização
// ------------------------------------------------------

function htmlCard(f) {
    const e = equipePorId(f.equipeId);
    const ehLider = lider(f);
    return `
        <article class="card-func ${f.status === "Inativo" ? "inativo" : ""} ${ehLider ? "card-func--lider" : ""}"
                 data-id="${esc(f.id)}" tabindex="0" style="--cor:${esc(e?.cor || "#8b93a1")}"
                 aria-label="${esc(f.nome)}${ehLider ? ", encarregado" : ""}, abrir para editar">
            <div class="avatar">
                ${esc(iniciais(f.nome))}
                ${ehLider ? `<span class="avatar-lider" aria-hidden="true"><i class="fa-solid fa-star"></i></span>` : ""}
            </div>
            <div class="card-nome">${esc(f.nome)}</div>
            <div class="card-funcao">
                <span class="ponto" aria-hidden="true"></span>${esc(e?.nome || "Sem equipe")}${f.funcao ? `<span class="cargo">${esc(f.funcao)}</span>` : ""}
            </div>
            <div class="card-meta">
                ${ehLider ? `<span class="etiqueta etiqueta--lider"><i class="fa-solid fa-star" aria-hidden="true"></i> Encarregado</span>` : ""}
                ${f.matricula ? `<span class="etiqueta">Mat. ${esc(f.matricula)}</span>` : ""}
                ${f.status === "Inativo" ? `<span class="etiqueta etiqueta--inativo">Inativo</span>` : ""}
            </div>
        </article>`;
}

// cartões agrupados por equipe, com um título por equipe
function htmlListaAgrupada(pessoas) {
    const ordenadas = ordenarPorEquipe(pessoas, equipes);
    let atual = null;
    return ordenadas.map((f) => {
        const id = equipePorId(f.equipeId) ? f.equipeId : "";
        let titulo = "";
        if (id !== atual) {
            atual = id;
            const e = equipePorId(id);
            const n = ordenadas.filter((x) => (equipePorId(x.equipeId) ? x.equipeId : "") === id).length;
            titulo = `<h4 class="grupo-titulo" style="--cor:${esc(e?.cor || "#8b93a1")}"><span class="ponto"></span>${esc(e?.nome || "Sem equipe")} <small>${n}</small></h4>`;
        }
        return titulo + htmlCard(f);
    }).join("");
}

function htmlTurma(turma) {
    const todosDaTurma = daEscala().filter((f) => turmaDe(f) === turma.id && !(modo() === "todos" && lider(f)));
    const visiveis = todosDaTurma.filter(passaNoFiltro);
    const ativos = todosDaTurma.filter((f) => f.status !== "Inativo").length;
    const lideres = daEscala().filter((f) => f.status !== "Inativo" && lider(f) &&
        (modo() === "todos" || turmaDe(f) === turma.id)).map((f) => f.nome);
    const prox = proximoPlantao(turma.id);

    return `
        <section class="turma" style="--cor:${turma.cor}">
            <header class="turma-topo">
                <span class="turma-letra" aria-hidden="true">${turma.id}</span>
                <div class="turma-titulo">
                    <h2>${turma.nome}</h2>
                    <p>${ativos} ${ativos === 1 ? "pessoa" : "pessoas"}${prox ? `, próximo plantão ${dataCurta(prox)}` : ""}</p>
                </div>
            </header>
            <p class="turma-lider ${lideres.length ? "" : "vazio"}">
                <i class="fa-solid fa-star" aria-hidden="true"></i>
                ${lideres.length ? `Encarregado: <strong>${esc(lideres.join(", "))}</strong>` : "Sem encarregado nesta turma"}
            </p>
            <div class="lista-cards" data-turma="${turma.id}">
                ${htmlListaAgrupada(visiveis) || `<p class="lista-vazia">${todosDaTurma.length ? "Ninguém nesta turma com o filtro atual" : "Arraste funcionários para cá"}</p>`}
            </div>
        </section>`;
}

function htmlSemTurma() {
    const todos = daEscala().filter((f) => !turmaDe(f) && !(modo() === "todos" && lider(f)));
    const visiveis = todos.filter(passaNoFiltro);

    return `
        <section class="faixa faixa--sem">
            <header class="faixa-topo">
                <h2><i class="fa-regular fa-circle-question" aria-hidden="true"></i> Sem fim de semana definido <span class="contagem">${todos.length}</span></h2>
                <p>Ficam fora da escala até irem para A ou B.</p>
            </header>
            <div class="lista-cards lista-cards--faixa" data-turma="${SEM_TURMA}">
                ${ordenarPorEquipe(visiveis, equipes).map(htmlCard).join("") || `<p class="lista-vazia">Todos já estão em uma turma</p>`}
            </div>
        </section>`;
}

function htmlLideresTodos() {
    const lideres = daEscala().filter((f) => lider(f));
    const visiveis = lideres.filter(passaNoFiltro);
    return `
        <section class="faixa faixa--lider">
            <header class="faixa-topo">
                <h2><i class="fa-solid fa-star" aria-hidden="true"></i> Encarregados <span class="contagem">${lideres.filter((f) => f.status !== "Inativo").length}</span></h2>
                <p>Trabalham nos dois fins de semana, A e B. Para mudar, use a aba Rotação da escala.</p>
            </header>
            <div class="lista-cards lista-cards--faixa lista-fixa">
                ${visiveis.map(htmlCard).join("") || `<p class="lista-vazia">Nenhum encarregado. Marque no cadastro do funcionário.</p>`}
            </div>
        </section>`;
}

function renderFuncoes() {
    const doTipo = daEscala().filter((f) => f.status !== "Inativo");
    const conta = (id) => doTipo.filter((f) => f.equipeId === id).length;
    const semEquipe = doTipo.filter((f) => !equipePorId(f.equipeId)).length;

    $("listaFuncoes").innerHTML = [
        `<button class="chip-funcao ${filtro.equipe === "" ? "ativo" : ""}" data-filtro="">Todas <small>${doTipo.length}</small></button>`,
        ...equipes.map((e) => `
            <span class="chip-funcao-grupo ${filtro.equipe === e.id ? "ativo" : ""}" style="--cor:${esc(e.cor)}">
                <button class="chip-funcao" data-filtro="${esc(e.id)}"><span class="ponto"></span>${esc(e.nome)} <small>${conta(e.id)}</small></button>
                <button class="chip-editar" data-editar-equipe="${esc(e.id)}" aria-label="Editar ${esc(e.nome)}"><i class="fa-solid fa-pen"></i></button>
            </span>`),
        semEquipe ? `<button class="chip-funcao ${filtro.equipe === "__sem__" ? "ativo" : ""}" data-filtro="__sem__">Sem equipe <small>${semEquipe}</small></button>` : "",
        `<button class="chip-funcao chip-nova" id="btnNovaEquipe"><i class="fa-solid fa-plus" aria-hidden="true"></i> Nova equipe</button>`
    ].join("");
}

function render() {
    renderFuncoes();
    atualizarSeletor();

    quadro.innerHTML = `
        ${modo() === "todos" ? htmlLideresTodos() : ""}
        <div class="turmas">
            ${TURMAS.map(htmlTurma).join("")}
        </div>
        ${htmlSemTurma()}
    `;

    quadro.classList.toggle("compacto", $("modoCompacto").checked);
    ativarArraste();
    atualizarCargos();
}

function atualizarSeletor() {
    const ativos = (tipo) => daEscala(tipo).filter((f) => f.status !== "Inativo").length;
    $("numDiurna").textContent = ativos("diurna");
    $("numNoturna").textContent = ativos("noturna");
    document.querySelectorAll(".seletor-bt").forEach((b) => {
        b.classList.toggle("ativo", b.dataset.tipo === tipoAtual);
        b.setAttribute("aria-selected", b.dataset.tipo === tipoAtual);
    });
}

document.querySelectorAll(".seletor-bt").forEach((bt) => {
    bt.addEventListener("click", () => {
        tipoAtual = bt.dataset.tipo;
        history.replaceState(null, "", `?tipo=${tipoAtual}`);
        render();
    });
});

// ------------------------------------------------------
// Arrastar e soltar entre turmas
// ------------------------------------------------------

let sortables = [];

function ativarArraste() {
    sortables.forEach((s) => s.destroy());
    sortables = [];
    if (!window.Sortable) {
        console.warn("SortableJS não carregou; use o campo 'Trabalha no' do cadastro.");
        return;
    }

    quadro.querySelectorAll(".lista-cards[data-turma]").forEach((lista) => {
        sortables.push(new Sortable(lista, {
            group: "turmas",
            sort: false,
            animation: 160,
            draggable: ".card-func",
            filter: ".lista-vazia, .grupo-titulo",
            ghostClass: "card-fantasma",
            dragClass: "card-arrastando",
            forceFallback: true,
            fallbackOnBody: true,
            delayOnTouchOnly: true,
            delay: 150,
            onStart: () => { arrastando = true; },
            onEnd: aoSoltar
        }));
    });
}

async function aoSoltar(evt) {
    const destino = evt.to.dataset.turma;
    const f = funcionarios.find((x) => x.id === evt.item.dataset.id);
    const novaTurma = destino === SEM_TURMA ? null : destino;

    try {
        if (f && evt.from !== evt.to && turmaDe(f) !== novaTurma) {
            await updateDoc(doc(db, "funcionarios", f.id), { turma: novaTurma });
            aviso(novaTurma
                ? `${f.nome} agora trabalha no fim de semana ${novaTurma}.`
                : `${f.nome} ficou sem fim de semana definido.`);
        }
    } catch (erro) {
        console.error(erro);
        aviso("Não foi possível mover. Verifique a conexão e tente de novo.", "erro");
    } finally {
        arrastando = false;
        render();
    }
}

// ------------------------------------------------------
// Cliques
// ------------------------------------------------------

quadro.addEventListener("click", (e) => {
    const card = e.target.closest(".card-func");
    if (card) abrirFuncionario(card.dataset.id);
});

quadro.addEventListener("keydown", (e) => {
    const card = e.target.closest(".card-func");
    if (card && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        abrirFuncionario(card.dataset.id);
    }
});

$("listaFuncoes").addEventListener("click", (e) => {
    const editar = e.target.closest("[data-editar-equipe]");
    if (editar) return abrirEquipe(editar.dataset.editarEquipe);
    if (e.target.closest("#btnNovaEquipe")) return abrirEquipe(null);
    const chip = e.target.closest("[data-filtro]");
    if (chip) {
        filtro.equipe = chip.dataset.filtro;
        render();
    }
});

$("btnNovo").addEventListener("click", () => abrirFuncionario(null));

$("busca").addEventListener("input", (e) => {
    filtro.texto = normalizar(e.target.value);
    render();
});

$("mostrarInativos").addEventListener("change", (e) => {
    filtro.inativos = e.target.checked;
    render();
});

$("modoCompacto").addEventListener("change", (e) => {
    quadro.classList.toggle("compacto", e.target.checked);
});

// ------------------------------------------------------
// Modais
// ------------------------------------------------------

function abrirModal(el, focar) {
    el.classList.remove("hidden");
    setTimeout(() => focar?.focus(), 30);
}

function fecharModal(el) {
    el.classList.add("hidden");
}

document.querySelectorAll(".modal-fundo").forEach((m) => {
    m.addEventListener("click", (e) => {
        if (e.target === m || e.target.closest("[data-fechar]")) fecharModal(m);
    });
});

document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") document.querySelectorAll(".modal-fundo:not(.hidden)").forEach(fecharModal);
});

// importar / exportar planilha
const importacao = iniciarImportacao({
    obterDados: () => ({ equipes, funcionarios }),
    aviso,
    abrirModal,
    fecharModal
});

$("btnImportar").addEventListener("click", () => importacao.abrir());

$("btnExportar").addEventListener("click", () => {
    try {
        const n = exportarPlanilha(equipes, funcionarios);
        aviso(`Planilha com ${n} funcionários baixada.`);
    } catch (erro) {
        console.error(erro);
        aviso(erro.message || "Não foi possível gerar a planilha.", "erro");
    }
});

// ------------------------------------------------------
// Funcionário
// ------------------------------------------------------

const modalFunc = $("modalFuncionario");
let liderMarcadoAMao = false;

function atualizarCargos() {
    const cargos = [...new Set(funcionarios.map((f) => f.funcao).filter(Boolean))].sort();
    $("listaCargos").innerHTML = cargos.map((c) => `<option value="${esc(c)}">`).join("");
}

function atualizarTextoLider() {
    const tipo = $("funcTurno").value === "Noturno" ? "noturna" : "diurna";
    $("textoLider").textContent = modoEncarregado(configs[tipo], tipo) === "todos"
        ? "Aparece em destaque e trabalha nos dois fins de semana, A e B."
        : "Aparece em destaque e trabalha no fim de semana da turma dele.";
}

function abrirFuncionario(id) {
    const f = id ? funcionarios.find((x) => x.id === id) : null;

    $("tituloFuncionario").textContent = f ? "Editar funcionário" : "Novo funcionário";
    $("funcId").value = f?.id || "";
    $("funcNome").value = f?.nome || "";
    $("funcMatricula").value = f?.matricula || "";
    $("funcFuncao").value = f?.funcao || "";
    $("funcTurno").value = TIPOS[f ? tipoDoFuncionario(f) : tipoAtual].turno;
    $("funcTurma").value = f ? (turmaDe(f) || "") : "A";
    $("funcStatus").value = f?.status || "Ativo";

    const selecionada = f ? f.equipeId : (filtro.equipe && filtro.equipe !== "__sem__" ? filtro.equipe : "");
    $("funcEquipe").innerHTML = `<option value="">Sem equipe</option>` +
        equipes.map((e) => `<option value="${esc(e.id)}" ${e.id === selecionada ? "selected" : ""}>${esc(e.nome)}</option>`).join("");

    $("funcLider").checked = f ? lider(f) : false;
    liderMarcadoAMao = f ? typeof f.lider === "boolean" : false;
    atualizarTextoLider();
    $("btnExcluirFunc").classList.toggle("hidden", !f);

    abrirModal(modalFunc, $("funcNome"));
}

$("funcTurno").addEventListener("change", atualizarTextoLider);
$("funcLider").addEventListener("change", () => { liderMarcadoAMao = true; });

// cargo ou equipe "Encarregado" marcam a caixa sozinhos, até a pessoa mexer nela
function sugerirLider() {
    if (liderMarcadoAMao) return;
    const equipe = equipePorId($("funcEquipe").value);
    $("funcLider").checked =
        normalizar($("funcFuncao").value).includes("encarregad") || normalizar(equipe?.nome).includes("encarregad");
}
$("funcFuncao").addEventListener("input", sugerirLider);
$("funcEquipe").addEventListener("change", sugerirLider);

$("formFuncionario").addEventListener("submit", async (e) => {
    e.preventDefault();

    const nome = $("funcNome").value.trim();
    if (!nome) {
        aviso("Informe o nome do funcionário.", "erro");
        $("funcNome").focus();
        return;
    }

    const id = $("funcId").value;
    const dados = {
        nome,
        matricula: $("funcMatricula").value.trim(),
        equipeId: $("funcEquipe").value || null,
        funcao: $("funcFuncao").value.trim(),
        turno: $("funcTurno").value,
        turma: $("funcTurma").value || null,
        status: $("funcStatus").value,
        lider: $("funcLider").checked
    };

    const bt = $("btnSalvarFunc");
    bt.disabled = true;
    try {
        if (id) await updateDoc(doc(db, "funcionarios", id), dados);
        else await addDoc(collection(db, "funcionarios"), dados);
        fecharModal(modalFunc);
        aviso(id ? "Funcionário atualizado." : `${nome} foi adicionado.`);

        const tipoNovo = dados.turno === "Noturno" ? "noturna" : "diurna";
        if (tipoNovo !== tipoAtual) aviso(`${nome} está na ${TIPOS[tipoNovo].rotulo.toLowerCase()}.`);
    } catch (erro) {
        console.error(erro);
        aviso("Não foi possível salvar o funcionário.", "erro");
    } finally {
        bt.disabled = false;
    }
});

$("btnExcluirFunc").addEventListener("click", async () => {
    const f = funcionarios.find((x) => x.id === $("funcId").value);
    if (!f || !confirm(`Excluir ${f.nome}? Essa ação não pode ser desfeita.`)) return;
    try {
        await deleteDoc(doc(db, "funcionarios", f.id));
        fecharModal(modalFunc);
        aviso(`${f.nome} foi excluído.`);
    } catch (erro) {
        console.error(erro);
        aviso("Não foi possível excluir.", "erro");
    }
});

// ------------------------------------------------------
// Equipe (função)
// ------------------------------------------------------

const modalEquipe = $("modalEquipe");

function abrirEquipe(id) {
    const e = id ? equipePorId(id) : null;
    const corAtual = e?.cor || proximaCor(equipes);

    $("tituloEquipe").textContent = e ? "Editar equipe" : "Nova equipe";
    $("equipeId").value = e?.id || "";
    $("equipeNome").value = e?.nome || "";
    $("equipeCores").innerHTML = CORES_EQUIPE.map((c) => `
        <label title="${c}">
            <input type="radio" name="cor" value="${c}" ${c === corAtual ? "checked" : ""}>
            <span style="--c:${c}"></span>
        </label>`).join("");
    $("btnExcluirEquipe").classList.toggle("hidden", !e);
    abrirModal(modalEquipe, $("equipeNome"));
}

$("formEquipe").addEventListener("submit", async (e) => {
    e.preventDefault();
    const nome = $("equipeNome").value.trim();
    if (!nome) {
        aviso("Informe o nome da equipe.", "erro");
        return;
    }
    const id = $("equipeId").value;
    const cor = e.target.querySelector('input[name="cor"]:checked')?.value || CORES_EQUIPE[0];

    if (equipes.some((x) => x.id !== id && normalizar(x.nome) === normalizar(nome))) {
        aviso(`Já existe uma equipe chamada ${nome}.`, "erro");
        return;
    }

    try {
        if (id) {
            await updateDoc(doc(db, "equipes", id), { nome, cor });
        } else {
            const ordem = equipes.length ? Math.max(...equipes.map((x) => x.ordem ?? 0)) + 1 : 0;
            await addDoc(collection(db, "equipes"), { nome, cor, ordem });
        }
        fecharModal(modalEquipe);
        aviso(id ? "Equipe atualizada." : `Equipe ${nome} criada.`);
    } catch (erro) {
        console.error(erro);
        aviso("Não foi possível salvar a equipe.", "erro");
    }
});

$("btnExcluirEquipe").addEventListener("click", async () => {
    const id = $("equipeId").value;
    const equipe = equipePorId(id);
    const membros = funcionarios.filter((f) => f.equipeId === id);
    const msg = membros.length
        ? `Excluir a equipe ${equipe.nome}? Os ${membros.length} funcionários continuam no sistema, só ficam sem equipe.`
        : `Excluir a equipe ${equipe.nome}?`;
    if (!confirm(msg)) return;

    try {
        const lote = writeBatch(db);
        membros.forEach((f) => lote.update(doc(db, "funcionarios", f.id), { equipeId: null }));
        lote.delete(doc(db, "equipes", id));
        await lote.commit();
        if (filtro.equipe === id) filtro.equipe = "";
        fecharModal(modalEquipe);
        aviso(`Equipe ${equipe.nome} excluída.`);
    } catch (erro) {
        console.error(erro);
        aviso("Não foi possível excluir a equipe.", "erro");
    }
});
