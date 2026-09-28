// ======================================================
// Escala São Miguel
// funcionarios.js — quadro de equipes estilo Trello
// ======================================================

import { db } from "./firebase.js";
import { montarLayout, aviso } from "./layout.js";
import {
    ouvirEquipes, ouvirFuncionarios, CORES_EQUIPE, esc, iniciais
} from "./dados.js";

import {
    collection, doc, addDoc, updateDoc, deleteDoc, writeBatch
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

montarLayout("funcionarios");

// ------------------------------------------------------
// Estado
// ------------------------------------------------------

const SEM_EQUIPE = "__sem_equipe__";

let equipes = [];
let funcionarios = [];
let arrastando = false;
let renderPendente = false;
const filtro = { texto: "", turno: "", inativos: false };

const quadro = document.getElementById("quadro");

// ------------------------------------------------------
// Tempo real
// ------------------------------------------------------

let recebeuEquipes = false;
let recebeuFuncionarios = false;

ouvirEquipes((lista) => {
    equipes = lista;
    recebeuEquipes = true;
    pedirRender();
});

ouvirFuncionarios((lista) => {
    funcionarios = lista;
    recebeuFuncionarios = true;
    pedirRender();
});

function pedirRender() {
    if (!recebeuEquipes || !recebeuFuncionarios) return;
    if (arrastando) { renderPendente = true; return; }
    render();
}

// ------------------------------------------------------
// Renderização
// ------------------------------------------------------

function corDaEquipe(equipeId) {
    return equipes.find((e) => e.id === equipeId)?.cor || "#8b93a1";
}

function passaNoFiltro(f) {
    if (!filtro.inativos && f.status === "Inativo") return false;
    if (filtro.turno && f.turno !== filtro.turno) return false;
    if (filtro.texto) {
        const alvo = `${f.nome} ${f.matricula} ${f.funcao}`.toLowerCase();
        if (!alvo.includes(filtro.texto)) return false;
    }
    return true;
}

function htmlCard(f) {
    const turnoClasse = f.turno === "Noite" ? "etiqueta--noite" : "etiqueta--manha";
    return `
        <article class="card-func ${f.status === "Inativo" ? "inativo" : ""}"
                 data-id="${esc(f.id)}" tabindex="0"
                 aria-label="${esc(f.nome)}, abrir para editar">
            <div class="avatar" style="--cor:${esc(corDaEquipe(f.equipeId))}">${esc(iniciais(f.nome))}</div>
            <div class="card-nome">${esc(f.nome)}</div>
            <div class="card-funcao">${esc(f.funcao || "Sem função")}</div>
            <div class="card-meta">
                <span class="etiqueta ${turnoClasse}">${esc(f.turno || "Manhã")}</span>
                ${f.matricula ? `<span class="etiqueta">Mat. ${esc(f.matricula)}</span>` : ""}
                ${f.status === "Inativo" ? `<span class="etiqueta etiqueta--inativo">Inativo</span>` : ""}
            </div>
        </article>`;
}

function htmlColuna({ id, nome, cor, posicao, livre }) {
    const membros = funcionarios.filter((f) =>
        livre ? !f.equipeId || !equipes.some((e) => e.id === f.equipeId) : f.equipeId === id
    );
    const visiveis = membros.filter(passaNoFiltro);
    const ativos = membros.filter((f) => f.status !== "Inativo").length;

    return `
        <section class="coluna ${livre ? "coluna--livre" : "coluna--equipe"}"
                 data-equipe="${esc(id)}" style="--cor:${esc(cor || "#8b93a1")}">
            <header class="coluna-topo">
                ${livre ? "" : `<button class="coluna-alca" title="Arraste para mudar a ordem do rodízio" aria-label="Mover equipe"><i class="fa-solid fa-grip-vertical"></i></button>`}
                ${livre ? "" : `<span class="coluna-vela" aria-hidden="true"></span>`}
                <h2 title="${esc(nome)}">${esc(nome)}</h2>
                <span class="contagem" title="Funcionários ativos">${ativos}</span>
                ${livre ? "" : `<button class="coluna-editar" data-editar-equipe="${esc(id)}" aria-label="Editar ${esc(nome)}"><i class="fa-solid fa-pen"></i></button>`}
            </header>
            <p class="coluna-posicao">${livre ? "Fora do rodízio" : `${posicao}ª no rodízio`}</p>
            <div class="coluna-cards" data-equipe="${esc(id)}">
                ${visiveis.map(htmlCard).join("") || `<p class="coluna-vazia">${membros.length ? "Nenhum resultado no filtro" : "Solte funcionários aqui"}</p>`}
            </div>
            <button class="adicionar-card" data-nova-na-equipe="${esc(id)}">
                <i class="fa-solid fa-plus" aria-hidden="true"></i> Adicionar funcionário
            </button>
        </section>`;
}

function render() {
    const scroll = quadro.scrollLeft;

    quadro.innerHTML = [
        htmlColuna({ id: SEM_EQUIPE, nome: "Sem equipe", livre: true }),
        ...equipes.map((e, i) => htmlColuna({ ...e, posicao: i + 1 })),
        `<button class="coluna-nova" id="colunaNova"><i class="fa-solid fa-plus" aria-hidden="true"></i> Adicionar equipe</button>`
    ].join("");

    quadro.scrollLeft = scroll;
    ativarArraste();
    atualizarListaFuncoes();
}

// ------------------------------------------------------
// Arrastar e soltar (SortableJS)
// ------------------------------------------------------

let sortables = [];

function ativarArraste() {
    sortables.forEach((s) => s.destroy());
    sortables = [];

    if (!window.Sortable) {
        console.warn("SortableJS não carregou; use o campo Equipe no cadastro para mover.");
        return;
    }

    // cards entre colunas
    quadro.querySelectorAll(".coluna-cards").forEach((lista) => {
        sortables.push(new Sortable(lista, {
            group: "funcionarios",
            animation: 160,
            draggable: ".card-func",
            filter: ".coluna-vazia",
            ghostClass: "card-fantasma",
            dragClass: "card-arrastando",
            forceFallback: true,
            fallbackOnBody: true,
            delayOnTouchOnly: true,
            delay: 150,
            onStart: () => { arrastando = true; },
            onEnd: aoSoltarCard
        }));
    });

    // ordem das equipes (colunas)
    sortables.push(new Sortable(quadro, {
        animation: 180,
        draggable: ".coluna--equipe",
        handle: ".coluna-alca",
        ghostClass: "coluna-fantasma",
        onStart: () => { arrastando = true; },
        onEnd: aoSoltarColuna
    }));
}

function finalizarArraste() {
    arrastando = false;
    if (renderPendente) { renderPendente = false; }
    render();
}

async function aoSoltarCard(evt) {
    const origem = evt.from.dataset.equipe;
    const destino = evt.to.dataset.equipe;

    if (origem === destino && evt.oldIndex === evt.newIndex) {
        finalizarArraste();
        return;
    }

    const lote = writeBatch(db);
    let alteracoes = 0;

    // regrava equipe e ordem só de quem mudou
    const listas = origem === destino ? [evt.to] : [evt.from, evt.to];
    listas.forEach((lista) => {
        const equipeId = lista.dataset.equipe === SEM_EQUIPE ? null : lista.dataset.equipe;
        [...lista.querySelectorAll(".card-func")].forEach((card, i) => {
            const f = funcionarios.find((x) => x.id === card.dataset.id);
            if (!f) return;
            if ((f.equipeId || null) !== equipeId || f.ordem !== i) {
                lote.update(doc(db, "funcionarios", f.id), { equipeId, ordem: i });
                alteracoes++;
            }
        });
    });

    try {
        if (alteracoes) await lote.commit();
        if (origem !== destino) {
            const f = funcionarios.find((x) => x.id === evt.item.dataset.id);
            const nomeDestino = destino === SEM_EQUIPE ? "Sem equipe" : equipes.find((e) => e.id === destino)?.nome;
            aviso(`${f?.nome || "Funcionário"} agora está em ${nomeDestino}.`);
        }
    } catch (erro) {
        console.error(erro);
        aviso("Não foi possível mover. Verifique a conexão e tente de novo.", "erro");
    } finally {
        finalizarArraste();
    }
}

async function aoSoltarColuna() {
    const ids = [...quadro.querySelectorAll(".coluna--equipe")].map((c) => c.dataset.equipe);
    const lote = writeBatch(db);
    let alteracoes = 0;

    ids.forEach((id, i) => {
        const e = equipes.find((x) => x.id === id);
        if (e && e.ordem !== i) {
            lote.update(doc(db, "equipes", id), { ordem: i });
            alteracoes++;
        }
    });

    try {
        if (alteracoes) {
            await lote.commit();
            aviso("Ordem do rodízio atualizada.");
        }
    } catch (erro) {
        console.error(erro);
        aviso("Não foi possível salvar a nova ordem.", "erro");
    } finally {
        finalizarArraste();
    }
}

// ------------------------------------------------------
// Cliques no quadro
// ------------------------------------------------------

quadro.addEventListener("click", (e) => {
    const card = e.target.closest(".card-func");
    if (card) return abrirFuncionario(card.dataset.id);

    const nova = e.target.closest("[data-nova-na-equipe]");
    if (nova) return abrirFuncionario(null, nova.dataset.novaNaEquipe);

    const editar = e.target.closest("[data-editar-equipe]");
    if (editar) return abrirEquipe(editar.dataset.editarEquipe);

    if (e.target.closest("#colunaNova")) return abrirEquipe(null);
});

quadro.addEventListener("keydown", (e) => {
    const card = e.target.closest(".card-func");
    if (card && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        abrirFuncionario(card.dataset.id);
    }
});

document.getElementById("btnNovo").addEventListener("click", () => abrirFuncionario(null));
document.getElementById("btnNovaEquipe").addEventListener("click", () => abrirEquipe(null));

// ------------------------------------------------------
// Filtros
// ------------------------------------------------------

document.getElementById("busca").addEventListener("input", (e) => {
    filtro.texto = e.target.value.trim().toLowerCase();
    render();
});

document.querySelectorAll(".filtro-turno .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
        document.querySelectorAll(".filtro-turno .chip").forEach((c) => c.classList.remove("ativo"));
        chip.classList.add("ativo");
        filtro.turno = chip.dataset.turno;
        render();
    });
});

document.getElementById("mostrarInativos").addEventListener("change", (e) => {
    filtro.inativos = e.target.checked;
    render();
});

// ------------------------------------------------------
// Modais (abrir/fechar)
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

// ------------------------------------------------------
// Funcionário
// ------------------------------------------------------

const modalFunc = document.getElementById("modalFuncionario");
const formFunc = document.getElementById("formFuncionario");
const campo = (id) => document.getElementById(id);

function atualizarListaFuncoes() {
    const funcoes = [...new Set(funcionarios.map((f) => f.funcao).filter(Boolean))].sort();
    campo("listaFuncoes").innerHTML = funcoes.map((f) => `<option value="${esc(f)}">`).join("");
}

function preencherSelectEquipes(selecionada) {
    campo("funcEquipe").innerHTML =
        `<option value="">Sem equipe</option>` +
        equipes.map((e) => `<option value="${esc(e.id)}" ${e.id === selecionada ? "selected" : ""}>${esc(e.nome)}</option>`).join("");
}

function abrirFuncionario(id, equipePadrao) {
    const f = id ? funcionarios.find((x) => x.id === id) : null;
    const equipe = f ? f.equipeId : (equipePadrao && equipePadrao !== SEM_EQUIPE ? equipePadrao : "");

    campo("tituloFuncionario").textContent = f ? "Editar funcionário" : "Novo funcionário";
    campo("funcId").value = f?.id || "";
    campo("funcNome").value = f?.nome || "";
    campo("funcMatricula").value = f?.matricula || "";
    campo("funcFuncao").value = f?.funcao || "";
    campo("funcTurno").value = f?.turno || "Manhã";
    campo("funcStatus").value = f?.status || "Ativo";
    preencherSelectEquipes(equipe);
    campo("btnExcluirFunc").classList.toggle("hidden", !f);

    abrirModal(modalFunc, campo("funcNome"));
}

formFunc.addEventListener("submit", async (e) => {
    e.preventDefault();

    const nome = campo("funcNome").value.trim();
    if (!nome) {
        aviso("Informe o nome do funcionário.", "erro");
        campo("funcNome").focus();
        return;
    }

    const id = campo("funcId").value;
    const equipeId = campo("funcEquipe").value || null;
    const atual = funcionarios.find((x) => x.id === id);

    const dados = {
        nome,
        matricula: campo("funcMatricula").value.trim(),
        funcao: campo("funcFuncao").value.trim(),
        turno: campo("funcTurno").value,
        status: campo("funcStatus").value,
        equipeId
    };

    // entrando numa equipe nova: vai para o fim da coluna
    if (!atual || (atual.equipeId || null) !== equipeId) {
        dados.ordem = funcionarios.filter((x) => (x.equipeId || null) === equipeId).length;
    }

    const botao = campo("btnSalvarFunc");
    botao.disabled = true;

    try {
        if (id) await updateDoc(doc(db, "funcionarios", id), dados);
        else await addDoc(collection(db, "funcionarios"), dados);
        fecharModal(modalFunc);
        aviso(id ? "Funcionário atualizado." : `${nome} foi adicionado.`);
    } catch (erro) {
        console.error(erro);
        aviso("Não foi possível salvar o funcionário.", "erro");
    } finally {
        botao.disabled = false;
    }
});

campo("btnExcluirFunc").addEventListener("click", async () => {
    const id = campo("funcId").value;
    const f = funcionarios.find((x) => x.id === id);
    if (!f || !confirm(`Excluir ${f.nome}? Essa ação não pode ser desfeita.`)) return;

    try {
        await deleteDoc(doc(db, "funcionarios", id));
        fecharModal(modalFunc);
        aviso(`${f.nome} foi excluído.`);
    } catch (erro) {
        console.error(erro);
        aviso("Não foi possível excluir.", "erro");
    }
});

// ------------------------------------------------------
// Equipe
// ------------------------------------------------------

const modalEquipe = document.getElementById("modalEquipe");
const formEquipe = document.getElementById("formEquipe");

function proximoNomeEquipe() {
    const letras = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const usados = new Set(equipes.map((e) => e.nome));
    for (const l of letras) if (!usados.has(`Equipe ${l}`)) return `Equipe ${l}`;
    return `Equipe ${equipes.length + 1}`;
}

function abrirEquipe(id) {
    const e = id ? equipes.find((x) => x.id === id) : null;
    const corAtual = e?.cor || CORES_EQUIPE[equipes.length % CORES_EQUIPE.length];

    campo("tituloEquipe").textContent = e ? "Editar equipe" : "Nova equipe";
    campo("equipeId").value = e?.id || "";
    campo("equipeNome").value = e?.nome || proximoNomeEquipe();
    campo("equipeCores").innerHTML = CORES_EQUIPE.map((c) => `
        <label title="${c}">
            <input type="radio" name="cor" value="${c}" ${c === corAtual ? "checked" : ""}>
            <span style="--c:${c}"></span>
        </label>`).join("");
    campo("btnExcluirEquipe").classList.toggle("hidden", !e);

    abrirModal(modalEquipe, campo("equipeNome"));
}

formEquipe.addEventListener("submit", async (e) => {
    e.preventDefault();

    const nome = campo("equipeNome").value.trim();
    if (!nome) {
        aviso("Informe o nome da equipe.", "erro");
        return;
    }

    const id = campo("equipeId").value;
    const cor = formEquipe.querySelector('input[name="cor"]:checked')?.value || CORES_EQUIPE[0];

    try {
        if (id) {
            await updateDoc(doc(db, "equipes", id), { nome, cor });
        } else {
            const ordem = equipes.length ? Math.max(...equipes.map((x) => x.ordem ?? 0)) + 1 : 0;
            await addDoc(collection(db, "equipes"), { nome, cor, ordem });
        }
        fecharModal(modalEquipe);
        aviso(id ? "Equipe atualizada." : `${nome} foi criada. Arraste funcionários para ela.`);
    } catch (erro) {
        console.error(erro);
        aviso("Não foi possível salvar a equipe.", "erro");
    }
});

campo("btnExcluirEquipe").addEventListener("click", async () => {
    const id = campo("equipeId").value;
    const equipe = equipes.find((x) => x.id === id);
    const membros = funcionarios.filter((f) => f.equipeId === id);

    const msg = membros.length
        ? `Excluir ${equipe.nome}? Os ${membros.length} funcionários voltam para "Sem equipe" e o rodízio passa a ter ${equipes.length - 1} equipes.`
        : `Excluir ${equipe.nome}?`;
    if (!confirm(msg)) return;

    try {
        const lote = writeBatch(db);
        membros.forEach((f) => lote.update(doc(db, "funcionarios", f.id), { equipeId: null }));
        lote.delete(doc(db, "equipes", id));
        await lote.commit();
        fecharModal(modalEquipe);
        aviso(`${equipe.nome} foi excluída.`);
    } catch (erro) {
        console.error(erro);
        aviso("Não foi possível excluir a equipe.", "erro");
    }
});
