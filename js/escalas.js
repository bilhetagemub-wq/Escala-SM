// ======================================================
// Escala São Miguel
// escalas.js — escala mensal por turma (fim de semana A / B)
// ======================================================
//
// O rodízio alterna as turmas A e B. Em cada dia trabalham todos
// os funcionários da turma do dia, agrupados por equipe (função).
// Encarregados aparecem em destaque; na diurna trabalham nos dois
// fins de semana (configurável na aba Rotação).

import { db } from "./firebase.js";
import { montarLayout, aviso } from "./layout.js";
import {
    ouvirEquipes, ouvirFuncionarios, ouvirFeriados,
    lerConfig, salvarConfig, lerAjustesDoMes, salvarEscalaDoMes,
    ROTULO_AUSENCIA, TIPOS, turmasDe, turmaPorId, turmaFixaDoFeriado, encarregadoForaDasTurmas,
    modoEncarregado, pessoasDoDia, ativosDaEscala, turmaDe, ehEncarregado, esc,
    encarregadosDaEscala, TEXTO_MODO_ENCARREGADO, completarConfig
} from "./dados.js";
import {
    gerarEscalaDoMes, distribuirFeriados, feriadosNacionais, atribuirEncarregados, somarDias,
    sabadoDoFimDeSemana, hojeISO, mesDe, somarMeses, diaDaSemana,
    NOMES_DIA, NOMES_DIA_CURTO, NOMES_MES, dataCurta, dataCompleta, tituloMes
} from "./escala-engine.js";

import {
    collection, doc, addDoc, updateDoc, deleteDoc, writeBatch
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

montarLayout("escalas");

// ------------------------------------------------------
// Estado
// ------------------------------------------------------

const params = new URLSearchParams(location.search);
let tipoAtual = params.get("tipo") === "noturna" ? "noturna" : "diurna";
let mesAtual = params.get("mes") || mesDe(hojeISO());

let equipes = [];          // equipes = funções (Elétrica, Mecânica...)
let funcionarios = [];
let todosFeriados = [];
let feriados = [];         // com a turma fixa da escala aberta
let config = null;
let ajustes = { trocas: {}, ausencias: {}, encarregados: {}, salvo: false };
let sujo = false;
const pronto = { equipes: false, funcionarios: false, feriados: false, config: false };

const $ = (id) => document.getElementById(id);
const hoje = hojeISO();
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const corTurma = (id) => turmaPorId(id)?.cor || "#8b93a1";
const nomeTurma = (id) => turmaPorId(id)?.curto || "Sem turma";
const turmas = () => turmasDe(tipoAtual);

function filtrarFeriados() {
    feriados = todosFeriados.map((f) => ({ ...f, equipeFixaId: turmaFixaDoFeriado(f, tipoAtual) }));
}

// ------------------------------------------------------
// Carregamento
// ------------------------------------------------------

ouvirEquipes((l) => { equipes = l; pronto.equipes = true; aoMudarDados(); });
ouvirFuncionarios((l) => { funcionarios = l; pronto.funcionarios = true; aoMudarDados(); });
ouvirFeriados((l) => { todosFeriados = l; filtrarFeriados(); pronto.feriados = true; aoMudarDados(); });

let pedidoConfig = 0;
async function carregarConfig() {
    const pedido = ++pedidoConfig;
    pronto.config = false;
    try {
        const c = await lerConfig(tipoAtual);
        if (pedido !== pedidoConfig) return;
        config = completarConfig(c, tipoAtual);

        // primeiro uso: grava o ponto de partida (este fim de semana, turma A)
        if (config.novo) {
            config = { ...config, existe: true, novo: false };
            salvarConfig(tipoAtual, config)
                .then(() => aviso(`${TIPOS[tipoAtual].rotulo}: a turma A começa neste fim de semana. Ajuste na aba Rotação.`))
                .catch((erro) => console.error(erro));
        }

        pronto.config = true;
        preencherFormRotacao();
        aoMudarDados();
    } catch (erro) {
        console.error(erro);
        aviso("Não foi possível ler a configuração do rodízio.", "erro");
    }
}

function aoMudarDados() {
    if (!Object.values(pronto).every(Boolean)) return;
    preencherEncarregadoInicial($("encarregadoInicial").value || config.encarregadoInicialId);
    atualizarCampoEncarregado();
    renderMes();
    renderFeriados();
    renderPrevia();
}

carregarConfig();
carregarMes(mesAtual, true);
atualizarSeletor();

// ------------------------------------------------------
// Diurna / noturna
// ------------------------------------------------------

function atualizarSeletor() {
    document.querySelectorAll(".seletor-bt").forEach((b) => {
        b.classList.toggle("ativo", b.dataset.tipo === tipoAtual);
        b.setAttribute("aria-selected", b.dataset.tipo === tipoAtual);
    });
    document.title = `${TIPOS[tipoAtual].rotulo} | Escala São Miguel`;
}

document.querySelectorAll(".seletor-bt").forEach((bt) => {
    bt.addEventListener("click", async () => {
        if (bt.dataset.tipo === tipoAtual) return;
        if (sujo && !confirm("Há alterações não salvas nesta escala. Descartar e trocar?")) return;
        tipoAtual = bt.dataset.tipo;
        sujo = false;
        filtrarFeriados();
        atualizarSeletor();
        carregarConfig();
        await carregarMes(mesAtual, true);
    });
});

// ------------------------------------------------------
// Abas
// ------------------------------------------------------

document.querySelectorAll(".aba-bt").forEach((bt) => {
    bt.addEventListener("click", () => {
        document.querySelectorAll(".aba-bt").forEach((b) => {
            b.classList.toggle("ativo", b === bt);
            b.setAttribute("aria-selected", b === bt);
        });
        document.querySelectorAll(".aba").forEach((a) => a.classList.add("hidden"));
        $(`aba-${bt.dataset.aba}`).classList.remove("hidden");
        if (bt.dataset.aba === "rotacao") renderPrevia();
    });
});

// ======================================================
// ESCALA DO MÊS
// ======================================================

async function carregarMes(mes, inicial = false) {
    if (!inicial && sujo && !confirm("Há alterações não salvas neste mês. Descartar e trocar de mês?")) {
        $("mes").value = mesAtual;
        return;
    }

    mesAtual = mes;
    sujo = false;
    $("mes").value = mes;
    $("mesTitulo").textContent = tituloMes(mes);
    history.replaceState(null, "", `?tipo=${tipoAtual}&mes=${mes}`);

    try {
        ajustes = await lerAjustesDoMes(mes, tipoAtual);
    } catch (erro) {
        console.error(erro);
        ajustes = { trocas: {}, ausencias: {}, encarregados: {}, salvo: false };
        aviso("Não foi possível ler os ajustes salvos deste mês.", "erro");
    }
    renderMes();
}

$("mesAnterior").addEventListener("click", () => carregarMes(somarMeses(mesAtual, -1)));
$("mesProximo").addEventListener("click", () => carregarMes(somarMeses(mesAtual, 1)));
$("mesHoje").addEventListener("click", () => carregarMes(mesDe(hoje)));
$("mes").addEventListener("change", (e) => e.target.value && carregarMes(e.target.value));

const modo = () => modoEncarregado(config, tipoAtual);
const encarregados = () => encarregadosDaEscala(funcionarios, tipoAtual, equipes);
const nomePessoa = (id) => funcionarios.find((f) => f.id === id)?.nome || "";

function comEncarregados(dias, cfg, ajustesDoMes) {
    return atribuirEncarregados(dias, {
        encarregados: encarregados().map((f) => ({ id: f.id, turma: turmaDe(f) })),
        config: cfg || {},
        modo: modoEncarregado(cfg, tipoAtual),
        ajustes: ajustesDoMes
    });
}

function diasDoMesAtual() {
    const dias = gerarEscalaDoMes(mesAtual, { equipes: turmas(), feriados, config: config || {}, ajustes });
    return comEncarregados(dias, config, ajustes);
}

const pessoas = (d, agruparPor = "equipe") => pessoasDoDia(d, funcionarios, ajustes, tipoAtual, equipes, agruparPor);

function marcarSujo() {
    sujo = true;
    renderStatus();
}

function renderStatus() {
    const el = $("statusEscala");
    if (sujo) {
        el.className = "status status--pendente";
        el.textContent = "Alterações não salvas";
    } else if (ajustes.salvo) {
        const d = ajustes.atualizadoEm;
        el.className = "status status--salvo";
        el.textContent = d
            ? `Salva em ${d.toLocaleDateString("pt-BR")} às ${d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`
            : "Salva";
    } else {
        el.className = "status";
        el.textContent = "Gerada pelo rodízio, ainda não salva";
    }
}

function tituloBloco(bloco) {
    const [primeiro] = bloco;
    const mes = NOMES_MES[Number(primeiro.data.slice(5, 7)) - 1];
    const dia = (iso) => Number(iso.slice(8));
    if (primeiro.fimDeSemana && bloco.length === 2) {
        return `Fim de semana de ${dia(bloco[0].data)} e ${dia(bloco[1].data)} de ${mes}`;
    }
    return `${cap(NOMES_DIA[primeiro.diaSemana])}, ${dia(primeiro.data)} de ${mes}`;
}

function htmlPessoa(p, d, classe = "") {
    return `
        <li>
            <button class="membro ${classe} ${p.ausencia ? "ausente" : ""}"
                    data-membro="${esc(p.id)}" data-dia="${d.data}"
                    title="${p.ausencia ? "Clique para mudar ou remover a ausência" : "Clique para marcar férias ou afastamento"}">
                ${classe === "membro--lider" ? `<i class="fa-solid fa-star" aria-hidden="true"></i>` : ""}
                <span class="nome">${esc(p.nome)}</span>
                ${p.ausencia ? `<small>${ROTULO_AUSENCIA[p.ausencia]}</small>` : ""}
            </button>
        </li>`;
}

function htmlLider(d, lider) {
    const lista = encarregados();
    if (!lista.length) return "";
    const aus = lider?.ausencia;
    const original = d.encarregadoOriginalId ? nomePessoa(d.encarregadoOriginalId) : "sem encarregado";

    return `
        <div class="dia-lider ${lider ? "" : "vazio-lider"} ${aus ? "ausente" : ""}">
            <span class="lider-icone" aria-hidden="true"><i class="fa-solid fa-star"></i></span>
            <label class="lider-campo">
                <span class="lider-rotulo">Encarregado${d.encarregadoAlterado ? " (trocado)" : ""}</span>
                <select data-lider="${d.data}" aria-label="Encarregado em ${dataCurta(d.data)}">
                    <option value="" ${!d.encarregadoId ? "selected" : ""}>Sem encarregado</option>
                    ${lista.map((f) => `<option value="${esc(f.id)}" ${f.id === d.encarregadoId ? "selected" : ""}>${esc(f.nome)}</option>`).join("")}
                </select>
            </label>
            ${lider ? `
                <button class="lider-ausencia" data-membro="${esc(lider.id)}" data-dia="${d.data}"
                        title="${aus ? "Clique para mudar ou remover a ausência" : "Marcar férias ou afastamento"}">
                    ${aus ? ROTULO_AUSENCIA[aus] : `<i class="fa-solid fa-user-clock" aria-hidden="true"></i><span class="sr">Ausência</span>`}
                </button>` : ""}
            ${d.encarregadoAlterado ? `<button class="voltar-auto" data-voltar-lider="${d.data}" title="Voltar para o encarregado do rodízio (${esc(original)})" aria-label="Voltar para ${esc(original)}"><i class="fa-solid fa-rotate-left"></i></button>` : ""}
        </div>`;
}

function htmlDia(d) {
    const { encarregado, integrantes, grupos } = pessoas(d);
    const presentes = integrantes.filter((p) => !p.ausencia).length + (encarregado && !encarregado.ausencia ? 1 : 0);
    const turma = turmaPorId(d.equipeId);

    return `
        <article class="dia ${d.data === hoje ? "hoje" : ""}" style="--cor:${corTurma(d.equipeId)}">
            <div class="dia-vela" aria-hidden="true">
                <strong>${d.data.slice(8)}</strong>
                <span>${NOMES_DIA_CURTO[d.diaSemana]}</span>
                <em>${d.equipeId || "?"}</em>
            </div>
            <div class="dia-corpo">
                <div class="dia-topo">
                    <span class="dia-nome">${cap(NOMES_DIA[d.diaSemana])}, ${dataCurta(d.data)}</span>
                    <span class="dia-tags">
                        ${d.feriado ? `<span class="tag tag-feriado">Feriado</span>` : ""}
                        ${d.alterado ? `<span class="tag tag-alterado">Trocada</span>` : ""}
                    </span>
                </div>
                ${d.feriado ? `<p class="feriado-nome">${esc(d.feriado.descricao)}</p>` : ""}

                <div class="dia-turma">
                    <div class="turma-botoes" role="group" aria-label="Turma de ${dataCurta(d.data)}">
                        ${turmas().map((t) => `
                            <button class="turma-bt ${t.id === d.equipeId ? "ativo" : ""}" style="--cor:${t.cor}"
                                    data-troca="${d.data}" data-turma="${t.id}" aria-pressed="${t.id === d.equipeId}">
                                ${t.curto}
                            </button>`).join("")}
                    </div>
                    ${d.alterado ? `<button class="voltar-auto" data-voltar="${d.data}" title="Voltar para a ${esc(nomeTurma(d.equipeOriginalId))}, do rodízio" aria-label="Voltar para o rodízio"><i class="fa-solid fa-rotate-left"></i></button>` : ""}
                    <span class="dia-total">${presentes} ${presentes === 1 ? "pessoa" : "pessoas"}</span>
                </div>

                ${htmlLider(d, encarregado)}

                ${grupos.map((g) => `
                    <div class="dia-grupo" style="--cor-grupo:${esc(g.cor)}">
                        <span class="grupo-nome"><i aria-hidden="true"></i>${esc(g.nome)}</span>
                        <ul class="membros">${g.pessoas.map((p) => htmlPessoa(p, d)).join("")}</ul>
                    </div>`).join("")}

                ${!integrantes.length
                    ? `<p class="sem-membros">Ninguém na ${esc(turma?.curto || "turma")}. Defina as turmas em Funcionários.</p>`
                    : presentes === 0 ? `<p class="sem-membros">Todos ausentes. Troque a turma deste dia.</p>` : ""}
            </div>
        </article>`;
}

function resumoEncarregados(dias) {
    const lista = encarregados();
    if (!lista.length) return "";
    const conta = new Map(lista.map((f) => [f.id, 0]));
    dias.forEach((d) => d.encarregadoId && conta.set(d.encarregadoId, (conta.get(d.encarregadoId) || 0) + 1));
    return `<span class="resumo-sep" aria-hidden="true"></span>` + lista.map((f) => `
        <div class="resumo-item resumo-item--lider">
            <i class="fa-solid fa-star" aria-hidden="true"></i>
            <strong>${esc(f.nome)}</strong>
            <span>${conta.get(f.id)} ${conta.get(f.id) === 1 ? "dia" : "dias"}</span>
        </div>`).join("");
}

function renderMes() {
    renderStatus();
    const grade = $("gradeDias");
    const resumo = $("resumoEquipes");

    if (!pronto.config || !pronto.funcionarios || !pronto.equipes) {
        grade.innerHTML = `<p class="texto-apoio">Carregando escala…</p>`;
        return;
    }

    const ativos = ativosDaEscala(funcionarios, tipoAtual);
    const fora = encarregadoForaDasTurmas(config, tipoAtual);
    const semTurma = ativos.filter((f) => !turmaDe(f) && !(fora && ehEncarregado(f, equipes))).length;

    if (!ativos.some((f) => turmaDe(f))) {
        resumo.innerHTML = "";
        grade.innerHTML = `
            <div class="vazio">
                <h3>Ninguém da ${TIPOS[tipoAtual].rotulo.toLowerCase()} está em uma turma ainda</h3>
                <p>Em Funcionários, arraste cada pessoa para o fim de semana A ou B. A escala aparece aqui na hora.</p>
                <a class="bt bt-principal" href="/pages/funcionarios.html?tipo=${tipoAtual}"><i class="fa-solid fa-people-group"></i> Organizar turmas</a>
            </div>`;
        return;
    }

    const dias = diasDoMesAtual();

    resumo.innerHTML = turmas().map((t) => {
        const nDias = dias.filter((d) => d.equipeId === t.id).length;
        const nPessoas = ativos.filter((f) => turmaDe(f) === t.id && !ehEncarregado(f, equipes)).length;
        return `
            <div class="resumo-item" style="--cor:${t.cor}">
                <i class="vela" aria-hidden="true"></i>
                <strong>${t.curto}</strong>
                <span>${nDias} ${nDias === 1 ? "dia" : "dias"}, ${nPessoas} ${nPessoas === 1 ? "pessoa" : "pessoas"}</span>
            </div>`;
    }).join("") + resumoEncarregados(dias) + (semTurma
        ? `<a class="resumo-item resumo-item--alerta" href="/pages/funcionarios.html?tipo=${tipoAtual}">
               <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
               <strong>${semTurma} ${tipoAtual === "noturna" ? "sem noite definida" : "sem fim de semana"}</strong>
               <span>ficam fora da escala</span>
           </a>`
        : "");

    // sábado e domingo juntos; feriado em dia útil sozinho
    const blocos = new Map();
    dias.forEach((d) => {
        const chave = d.fimDeSemana ? `fds-${sabadoDoFimDeSemana(d.data)}` : `dia-${d.data}`;
        if (!blocos.has(chave)) blocos.set(chave, []);
        blocos.get(chave).push(d);
    });

    grade.innerHTML = [...blocos.values()].map((bloco) => `
        <section class="bloco">
            <h3 class="bloco-titulo">${tituloBloco(bloco)}</h3>
            <div class="bloco-dias">${bloco.map(htmlDia).join("")}</div>
        </section>`).join("");
}

$("gradeDias").addEventListener("change", (e) => {
    const sel = e.target.closest("select[data-lider]");
    if (!sel) return;
    const iso = sel.dataset.lider;
    const dia = diasDoMesAtual().find((d) => d.data === iso);
    const trocas = { ...(ajustes.encarregados || {}) };
    if ((sel.value || null) === (dia?.encarregadoOriginalId || null)) delete trocas[iso];
    else trocas[iso] = sel.value;
    ajustes = { ...ajustes, encarregados: trocas };
    marcarSujo();
    renderMes();
});

$("gradeDias").addEventListener("click", (e) => {
    const voltarLider = e.target.closest("[data-voltar-lider]");
    if (voltarLider) {
        const trocas = { ...(ajustes.encarregados || {}) };
        delete trocas[voltarLider.dataset.voltarLider];
        ajustes = { ...ajustes, encarregados: trocas };
        marcarSujo();
        renderMes();
        return;
    }

    // trocar a turma do dia
    const troca = e.target.closest("[data-troca]");
    if (troca) {
        const iso = troca.dataset.troca;
        const dia = diasDoMesAtual().find((d) => d.data === iso);
        const trocas = { ...ajustes.trocas };
        if (troca.dataset.turma === dia?.equipeOriginalId) delete trocas[iso];
        else trocas[iso] = troca.dataset.turma;
        ajustes = { ...ajustes, trocas };
        marcarSujo();
        renderMes();
        return;
    }

    const voltar = e.target.closest("[data-voltar]");
    if (voltar) {
        const trocas = { ...ajustes.trocas };
        delete trocas[voltar.dataset.voltar];
        ajustes = { ...ajustes, trocas };
        marcarSujo();
        renderMes();
        return;
    }

    // presente -> férias -> afastamento -> presente
    const membro = e.target.closest("[data-membro]");
    if (membro) {
        const { membro: id, dia } = membro.dataset;
        const ausencias = structuredClone(ajustes.ausencias || {});
        const atual = ausencias[dia]?.[id] || null;
        const proximo = { null: "FE", FE: "A", A: null }[atual];
        ausencias[dia] = ausencias[dia] || {};
        if (proximo) ausencias[dia][id] = proximo;
        else delete ausencias[dia][id];
        if (!Object.keys(ausencias[dia]).length) delete ausencias[dia];
        ajustes = { ...ajustes, ausencias };
        marcarSujo();
        renderMes();
    }
});

// ------------------------------------------------------
// Salvar
// ------------------------------------------------------

$("btnSalvar").addEventListener("click", async () => {
    const retrato = diasDoMesAtual().map((d) => {
        const { encarregado, integrantes } = pessoas(d);
        const resumo = (p) => ({ id: p.id, nome: p.nome, equipeId: p.equipeId || null, ausencia: p.ausencia });
        return {
            data: d.data,
            tipo: d.tipo,
            feriado: d.feriado?.descricao || null,
            turma: d.equipeId,
            trocada: d.alterado,
            encarregado: encarregado ? resumo(encarregado) : null,
            integrantes: integrantes.map(resumo)
        };
    });

    const bt = $("btnSalvar");
    bt.disabled = true;
    try {
        await salvarEscalaDoMes(mesAtual, tipoAtual, ajustes, retrato);
        ajustes = { ...ajustes, salvo: true, atualizadoEm: new Date() };
        sujo = false;
        renderStatus();
        aviso(`${TIPOS[tipoAtual].rotulo} de ${tituloMes(mesAtual).toLowerCase()} salva.`);
    } catch (erro) {
        console.error(erro);
        aviso("Não foi possível salvar a escala. Verifique a conexão.", "erro");
    } finally {
        bt.disabled = false;
    }
});

window.addEventListener("beforeunload", (e) => {
    if (!sujo) return;
    e.preventDefault();
    e.returnValue = "";
});

// ------------------------------------------------------
// Impressão por fim de semana
// ------------------------------------------------------

const modalImprimir = $("modalImprimir");

modalImprimir.addEventListener("click", (e) => {
    if (e.target === modalImprimir || e.target.closest("[data-fechar]")) modalImprimir.classList.add("hidden");
});
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") modalImprimir.classList.add("hidden");
});

// Plantões de um mês: cada fim de semana (sáb + dom, mesmo virando o mês)
// e cada feriado em dia útil
function plantoesDoMes(mes) {
    const blocos = [];
    const vistos = new Set();
    const feriadosUteis = new Map(todosFeriados.filter((f) => f.data.startsWith(mes)).map((f) => [f.data, f]));

    diasDoMesDe(mes).forEach((iso) => {
        const d = diaDaSemana(iso);
        if (d === 6 || d === 0) {
            const sab = sabadoDoFimDeSemana(iso);
            if (vistos.has(sab)) return;
            vistos.add(sab);
            blocos.push({ chave: sab, datas: [sab, somarDias(sab, 1)] });
        } else if (feriadosUteis.has(iso)) {
            blocos.push({ chave: iso, datas: [iso], feriado: feriadosUteis.get(iso).descricao });
        }
    });
    return blocos;
}

function diasDoMesDe(mes) {
    const [a, m] = mes.split("-").map(Number);
    const total = new Date(Date.UTC(a, m, 0)).getUTCDate();
    return Array.from({ length: total }, (_, i) => `${mes}-${String(i + 1).padStart(2, "0")}`);
}

function rotuloBloco(b) {
    const [d1, d2] = b.datas;
    const mes1 = NOMES_MES[Number(d1.slice(5, 7)) - 1];
    if (b.datas.length === 1) return `${cap(NOMES_DIA[diaDaSemana(d1)])}, ${Number(d1.slice(8))} de ${mes1} (feriado)`;
    const mes2 = NOMES_MES[Number(d2.slice(5, 7)) - 1];
    return mes1 === mes2
        ? `Sábado ${Number(d1.slice(8))} e domingo ${Number(d2.slice(8))} de ${mes1}`
        : `Sábado ${Number(d1.slice(8))} de ${mes1} e domingo ${Number(d2.slice(8))} de ${mes2}`;
}

function blocoDaData(iso, blocos) {
    const exato = blocos.find((b) => b.datas.includes(iso));
    if (exato) return exato;
    const sab = sabadoDoFimDeSemana(iso); // dia útil sem feriado: o fim de semana seguinte
    return blocos.find((b) => b.chave === sab) || null;
}

function renderListaImpressao(marcar = null) {
    const data = $("impData").value || hoje;
    const blocos = plantoesDoMes(mesDe(data));
    const escolhido = marcar ?? blocoDaData(data, blocos)?.chave;
    $("impLista").innerHTML = blocos.map((b) => `
        <label class="imp-item ${b.feriado ? "imp-item--feriado" : ""}">
            <input type="checkbox" value="${b.chave}" ${b.chave === escolhido ? "checked" : ""}>
            <span>${rotuloBloco(b)}${b.feriado ? `<small>${esc(b.feriado)}</small>` : ""}</span>
        </label>`).join("") || `<p class="texto-apoio">Nenhum plantão neste mês.</p>`;
}

$("btnPDF").addEventListener("click", () => {
    // sugere o próximo fim de semana dentro do mês aberto
    const sugestao = mesAtual === mesDe(hoje) ? hoje : `${mesAtual}-01`;
    $("impData").value = sugestao;
    $("impDiurna").checked = true;
    $("impNoturna").checked = true;
    renderListaImpressao();
    modalImprimir.classList.remove("hidden");
    setTimeout(() => $("impData").focus(), 30);
});

$("impData").addEventListener("change", () => renderListaImpressao());

// Escala de um tipo para um conjunto de datas (lê do Firestore o que não estiver aberto)
const cacheConfig = {};
const cacheAjustes = {};

async function escalaDoTipo(tipo, datas) {
    const cfg = tipo === tipoAtual ? config : (cacheConfig[tipo] ??= completarConfig(await lerConfig(tipo), tipo));
    const fer = todosFeriados.map((f) => ({ ...f, equipeFixaId: turmaFixaDoFeriado(f, tipo) }));
    const encs = encarregadosDaEscala(funcionarios, tipo, equipes).map((f) => ({ id: f.id, turma: turmaDe(f) }));
    const resultado = [];

    for (const mes of [...new Set(datas.map(mesDe))]) {
        const aj = tipo === tipoAtual && mes === mesAtual
            ? ajustes
            : (cacheAjustes[`${mes}-${tipo}`] ??= await lerAjustesDoMes(mes, tipo));
        const dias = atribuirEncarregados(
            gerarEscalaDoMes(mes, { equipes: turmasDe(tipo), feriados: fer, config: cfg || {}, ajustes: aj }),
            { encarregados: encs, config: cfg || {}, modo: modoEncarregado(cfg, tipo), ajustes: aj }
        );
        dias.filter((d) => datas.includes(d.data)).forEach((d) => resultado.push({ dia: d, ajustes: aj }));
    }
    return resultado.sort((a, b) => a.dia.data.localeCompare(b.dia.data));
}

async function logoComoDataURL() {
    try {
        const resp = await fetch("/img/logo-sao-miguel.jpg");
        if (!resp.ok) return null;
        const blob = await resp.blob();
        return await new Promise((ok) => {
            const leitor = new FileReader();
            leitor.onload = () => ok(leitor.result);
            leitor.onerror = () => ok(null);
            leitor.readAsDataURL(blob);
        });
    } catch {
        return null;
    }
}

function hexParaRGB(hex) {
    const n = parseInt(String(hex).replace("#", ""), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// cor da equipe bem clara, para o fundo da célula do grupo
const clarear = (rgb) => rgb.map((c) => Math.round(c + (255 - c) * 0.86));

$("formImprimir").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!window.jspdf) {
        aviso("O gerador de PDF não carregou. Recarregue a página.", "erro");
        return;
    }

    const blocos = plantoesDoMes(mesDe($("impData").value || hoje));
    const marcados = [...$("impLista").querySelectorAll("input:checked")].map((i) => i.value);
    const selecionados = blocos.filter((b) => marcados.includes(b.chave));
    const tipos = ["diurna", "noturna"].filter((t) => $(t === "diurna" ? "impDiurna" : "impNoturna").checked);
    const agruparPor = e.target.querySelector('input[name="impGrupo"]:checked')?.value || "equipe";

    if (!selecionados.length) return aviso("Marque pelo menos um fim de semana.", "erro");
    if (!tipos.length) return aviso("Marque a escala diurna, a noturna ou as duas.", "erro");

    const bt = $("btnGerarPDF");
    bt.disabled = true;

    try {
        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF("p", "mm", "a4");
        const largura = pdf.internal.pageSize.getWidth();
        const logo = await logoComoDataURL();
        const comAusencia = (p) => (p.ausencia ? `${p.nome} (${ROTULO_AUSENCIA[p.ausencia].toLowerCase()})` : p.nome);

        for (let bi = 0; bi < selecionados.length; bi++) {
            const bloco = selecionados[bi];
            if (bi > 0) pdf.addPage();

            if (logo) pdf.addImage(logo, "JPEG", 14, 10, 48, 16);
            pdf.setTextColor(27, 35, 48);
            pdf.setFont("helvetica", "bold");
            pdf.setFontSize(15);
            pdf.text("Escala de plantão da manutenção", largura - 14, 16, { align: "right" });
            pdf.setFont("helvetica", "normal");
            pdf.setFontSize(11);
            pdf.text(rotuloBloco(bloco) + ` de ${bloco.datas[0].slice(0, 4)}`, largura - 14, 22.5, { align: "right" });

            let y = 34;
            for (const tipo of tipos) {
                const linhasDia = await escalaDoTipo(tipo, bloco.datas);
                const nomesTurma = [...new Set(linhasDia.map((l) => l.dia.equipeId))].map((t) => turmaPorId(t)?.curto).filter(Boolean);

                pdf.setFont("helvetica", "bold");
                pdf.setFontSize(12);
                pdf.setTextColor(27, 35, 48);
                pdf.text(tipo === "diurna" && nomesTurma.length ? `${TIPOS[tipo].rotulo}: ${nomesTurma.join(" e ")}` : TIPOS[tipo].rotulo, 14, y);

                const corpo = [];
                linhasDia.forEach(({ dia, ajustes: aj }) => {
                    const { encarregado, grupos } = pessoasDoDia(dia, funcionarios, aj, tipo, equipes, agruparPor);
                    const n = Math.max(1, grupos.length);
                    const turma = turmaPorId(dia.equipeId);
                    const linhaTurma = tipo === "diurna" || !dia.fimDeSemana ? `\n${turma?.curto || ""}` : "";
                    const diaTexto = `${cap(NOMES_DIA[dia.diaSemana])}${linhaTurma}${dia.feriado ? `\nFeriado: ${dia.feriado.descricao}` : ""}`;
                    const fundoDia = dia.feriado ? [253, 236, 236] : [255, 255, 255];

                    const inicio = [
                        { content: dataCurta(dia.data), rowSpan: n, styles: { fontStyle: "bold", fillColor: fundoDia, valign: "middle" } },
                        { content: diaTexto, rowSpan: n, styles: { fillColor: fundoDia, valign: "middle" } },
                        {
                            content: encarregado ? comAusencia(encarregado) : "-",
                            rowSpan: n,
                            styles: { fontStyle: "bold", fillColor: [255, 244, 219], textColor: [120, 78, 0], valign: "middle" }
                        }
                    ];

                    if (!grupos.length) {
                        corpo.push([...inicio, { content: "-", colSpan: 2 }]);
                        return;
                    }
                    grupos.forEach((g, i) => {
                        const rgb = hexParaRGB(g.cor);
                        const celulas = [
                            { content: `${g.nome} (${g.pessoas.length})`, styles: { fontStyle: "bold", fillColor: clarear(rgb), textColor: [27, 35, 48] } },
                            { content: g.pessoas.map(comAusencia).join(", ") }
                        ];
                        corpo.push(i === 0 ? [...inicio, ...celulas] : celulas);
                    });
                });

                pdf.autoTable({
                    startY: y + 3,
                    head: [["Data", "Dia", "Encarregado", agruparPor === "cargo" ? "Cargo" : "Grupo", "Integrantes"]],
                    body: corpo,
                    theme: "grid",
                    styles: { fontSize: 9, cellPadding: 2.4, valign: "middle", lineColor: [221, 226, 234], lineWidth: 0.2, textColor: [27, 35, 48] },
                    headStyles: { fillColor: hexParaRGB(tipo === "diurna" ? "#0A9447" : "#3B3F96"), textColor: 255 },
                    columnStyles: {
                        0: { cellWidth: 15 },
                        1: { cellWidth: 30 },
                        2: { cellWidth: 36 },
                        3: { cellWidth: 32 }
                    },
                    margin: { left: 14, right: 14 }
                });
                y = pdf.lastAutoTable.finalY + 12;
            }
        }

        const paginas = pdf.getNumberOfPages();
        for (let p = 1; p <= paginas; p++) {
            pdf.setPage(p);
            pdf.setFontSize(8);
            pdf.setTextColor(120);
            pdf.text(`Gerado em ${new Date().toLocaleDateString("pt-BR")}${sujo ? " (com alterações não salvas)" : ""}`, 14, 290);
            pdf.text(`Página ${p} de ${paginas}`, largura - 14, 290, { align: "right" });
        }

        const nome = selecionados.length === 1
            ? `Escala_${selecionados[0].chave}.pdf`
            : `Escala_${selecionados.length}_plantoes_${mesDe(selecionados[0].chave)}.pdf`;
        pdf.save(nome);
        modalImprimir.classList.add("hidden");
    } catch (erro) {
        console.error(erro);
        aviso("Não foi possível gerar o PDF.", "erro");
    } finally {
        bt.disabled = false;
    }
});

// ======================================================
// FERIADOS
// ======================================================

const opcoesTurma = (selecionada, rotuloAuto) =>
    `<option value="">${esc(rotuloAuto)}</option>` +
    turmas().map((t) => `<option value="${t.id}" ${t.id === selecionada ? "selected" : ""}>${t.curto}</option>`).join("");

function renderFeriados() {
    $("feriadoEquipe").innerHTML = opcoesTurma(null, "Próxima da fila (automático)");

    const lista = $("listaFeriados");
    const mostrarPassados = $("mostrarPassados").checked;
    const distribuidos = distribuirFeriados(feriados, turmas(), config || {})
        .filter((f) => mostrarPassados || f.data >= hoje);

    if (!distribuidos.length) {
        lista.innerHTML = `
            <div class="vazio">
                <h3>Nenhum feriado ${mostrarPassados ? "cadastrado" : "pela frente"}</h3>
                <p>Importe os feriados nacionais do ano ou adicione um feriado ao lado.</p>
            </div>`;
        return;
    }

    let anoAnterior = null;
    lista.innerHTML = distribuidos.map((f) => {
        const ano = f.data.slice(0, 4);
        const cabecalho = ano !== anoAnterior ? `<h4 class="ano-titulo">${ano}</h4>` : "";
        anoAnterior = ano;
        const origem = f.segueFimDeSemana
            ? "Cai no fim de semana: segue a turma do fim de semana"
            : f.fixo ? "Turma fixada neste feriado" : "Próxima da fila";

        return `${cabecalho}
            <div class="feriado ${f.data < hoje ? "passado" : ""}">
                <div class="feriado-data">
                    <strong>${dataCurta(f.data)}</strong>
                    <span>${NOMES_DIA_CURTO[diaDaSemana(f.data)]}</span>
                </div>
                <div class="feriado-desc">
                    ${esc(f.descricao)}
                    <small>${origem}</small>
                </div>
                <div class="feriado-equipe" style="--cor:${corTurma(f.equipeId)}">
                    <i class="vela" aria-hidden="true"></i>
                    <select data-fixar="${esc(f.id)}" aria-label="Turma do feriado de ${dataCurta(f.data)}" ${f.segueFimDeSemana ? "disabled" : ""}>
                        ${opcoesTurma(f.fixo ? f.equipeFixaId : null, f.fixo ? "Automático" : `${nomeTurma(f.equipeId)} (auto)`)}
                    </select>
                </div>
                <button class="excluir" data-excluir-feriado="${esc(f.id)}" aria-label="Excluir ${esc(f.descricao)}">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>`;
    }).join("");
}

$("mostrarPassados").addEventListener("change", renderFeriados);

$("formFeriado").addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = $("feriadoData").value;
    const descricao = $("feriadoDescricao").value.trim();
    if (!data || !descricao) {
        aviso("Informe a data e a descrição do feriado.", "erro");
        return;
    }
    if (todosFeriados.some((f) => f.data === data)) {
        aviso(`Já existe um feriado em ${dataCompleta(data)}.`, "erro");
        return;
    }
    try {
        await addDoc(collection(db, "feriados"), {
            data, descricao, equipeFixa: { [tipoAtual]: $("feriadoEquipe").value || null }
        });
        e.target.reset();
        aviso(`${descricao} (${dataCompleta(data)}) adicionado.`);
    } catch (erro) {
        console.error(erro);
        aviso("Não foi possível adicionar o feriado.", "erro");
    }
});

$("anoImportar").value = new Date().getFullYear() + (new Date().getMonth() >= 9 ? 1 : 0);

$("btnImportar").addEventListener("click", async () => {
    const ano = Number($("anoImportar").value);
    if (!ano || ano < 2020 || ano > 2100) {
        aviso("Informe um ano válido.", "erro");
        return;
    }
    // só de hoje em diante: feriados passados mudariam a fila sem necessidade
    const existentes = new Set(todosFeriados.map((f) => f.data));
    const novos = feriadosNacionais(ano, $("incluirFacultativos").checked)
        .filter((f) => f.data >= hoje && !existentes.has(f.data));
    if (!novos.length) {
        aviso(`Não há feriados nacionais de ${ano} a partir de hoje para importar.`);
        return;
    }
    try {
        const lote = writeBatch(db);
        novos.forEach((f) => lote.set(doc(collection(db, "feriados")), { ...f, equipeFixa: {} }));
        await lote.commit();
        aviso(novos.length === 1 ? `1 feriado de ${ano} importado.` : `${novos.length} feriados de ${ano} importados.`);
    } catch (erro) {
        console.error(erro);
        aviso("Não foi possível importar os feriados.", "erro");
    }
});

$("listaFeriados").addEventListener("change", async (e) => {
    const select = e.target.closest("[data-fixar]");
    if (!select) return;
    try {
        await updateDoc(doc(db, "feriados", select.dataset.fixar), { [`equipeFixa.${tipoAtual}`]: select.value || null });
        aviso(select.value
            ? `Feriado fixado com a ${nomeTurma(select.value)} na ${TIPOS[tipoAtual].rotulo.toLowerCase()}.`
            : "Feriado voltou para o automático.");
    } catch (erro) {
        console.error(erro);
        aviso("Não foi possível alterar a turma do feriado.", "erro");
    }
});

$("listaFeriados").addEventListener("click", async (e) => {
    const bt = e.target.closest("[data-excluir-feriado]");
    if (!bt) return;
    const f = todosFeriados.find((x) => x.id === bt.dataset.excluirFeriado);
    if (!f || !confirm(`Excluir o feriado ${f.descricao} (${dataCompleta(f.data)})? Os feriados seguintes mudam de turma.`)) return;
    try {
        await deleteDoc(doc(db, "feriados", f.id));
        aviso(`${f.descricao} excluído.`);
    } catch (erro) {
        console.error(erro);
        aviso("Não foi possível excluir o feriado.", "erro");
    }
});

// ======================================================
// ROTAÇÃO
// ======================================================

const formRotacao = $("formRotacao");

function marcar(nome, valor) {
    const r = formRotacao.querySelector(`input[name="${nome}"][value="${valor}"]`) ||
        formRotacao.querySelector(`input[name="${nome}"]`);
    if (r) r.checked = true;
}

function preencherFormRotacao() {
    if (!config) return;

    // noturna: sábado e domingo fixos; os campos de fim de semana A/B não se aplicam
    const noturna = tipoAtual === "noturna";
    $("grupoFimDeSemana").classList.toggle("hidden", noturna);
    $("avisoNoturna").classList.toggle("hidden", !noturna);
    $("tituloRotacao").textContent = noturna ? "Como a noite se organiza" : "Como as turmas se revezam";
    $("feriadoEquipeInicial").innerHTML = turmas().map((t) => `<option value="${t.id}">${t.curto}</option>`).join("");
    formRotacao.querySelectorAll('input[name="modoEncarregado"]').forEach((r) => {
        r.closest(".opcao").classList.toggle("hidden", !(r.dataset.tipos || "diurna noturna").includes(tipoAtual));
    });
    marcar("modo", config.modo);
    marcar("feriadoFds", config.feriadoNoFimDeSemana);
    marcar("modoEncarregado", modoEncarregado(config, tipoAtual));
    preencherEncarregadoInicial(config.encarregadoInicialId);
    $("dataReferencia").value = config.dataReferencia;
    $("equipeInicial").value = config.equipeInicialId;
    $("feriadoEquipeInicial").value = config.feriadoEquipeInicialId;
    atualizarCampoEncarregado();
}

function lerFormRotacao() {
    const valor = (nome, padrao) => formRotacao.querySelector(`input[name="${nome}"]:checked`)?.value || padrao;
    return {
        ...config,
        modo: tipoAtual === "noturna" ? "pordia" : valor("modo", "fimdesemana"),
        dataReferencia: sabadoDoFimDeSemana($("dataReferencia").value || config.dataReferencia),
        equipeInicialId: tipoAtual === "noturna" ? config.equipeInicialId : $("equipeInicial").value,
        feriadoEquipeInicialId: $("feriadoEquipeInicial").value,
        versao: 2,
        feriadoNoFimDeSemana: valor("feriadoFds", "feriado"),
        encarregadoModo: valor("modoEncarregado", modoEncarregado(config, tipoAtual)),
        encarregadoInicialId: $("encarregadoInicial").value || config.encarregadoInicialId || null
    };
}

function atualizarCampoEncarregado() {
    const porTurma = formRotacao.querySelector('input[name="modoEncarregado"]:checked')?.value === "turma";
    $("campoEncarregadoInicial").classList.toggle("hidden", porTurma);
    $("ordemEncarregados").classList.toggle("hidden", porTurma);
    $("avisoEncarregadoTurma").classList.toggle("hidden", !porTurma);
    if (porTurma) {
        const porNoite = turmas().map((t) => {
            const nomes = encarregados().filter((f) => turmaDe(f) === t.id).map((f) => f.nome);
            return `${t.curto}: ${nomes.join(", ") || "nenhum"}`;
        });
        $("avisoEncarregadoTurma").innerHTML =
            `${esc(porNoite.join(". "))}. <a class="link" href="/pages/funcionarios.html?tipo=${tipoAtual}">Mudar em Funcionários</a>`;
    }
}

function preencherEncarregadoInicial(selecionado) {
    const lista = encarregados();
    const valido = lista.some((f) => f.id === selecionado) ? selecionado : lista[0]?.id;
    $("encarregadoInicial").innerHTML = lista.length
        ? lista.map((f) => `<option value="${esc(f.id)}" ${f.id === valido ? "selected" : ""}>${esc(f.nome)}</option>`).join("")
        : `<option value="">Nenhum encarregado cadastrado</option>`;
    $("encarregadoInicial").disabled = !lista.length;
    $("ordemEncarregados").textContent = lista.length
        ? `Ordem do revezamento: ${lista.map((f) => f.nome).join(", ")}.`
        : "Marque o funcionário como encarregado no cadastro, em Funcionários.";
}

function renderPrevia() {
    const lista = $("previa");
    if (!config) return;

    const rascunho = lerFormRotacao();
    const dias = [0, 1, 2, 3]
        .flatMap((n) => comEncarregados(
            gerarEscalaDoMes(somarMeses(mesDe(hoje), n), { equipes: turmas(), feriados, config: rascunho }), rascunho, {}
        ))
        .filter((d) => d.data >= hoje);

    const blocos = new Map();
    dias.forEach((d) => {
        const chave = d.fimDeSemana ? `fds-${sabadoDoFimDeSemana(d.data)}` : `dia-${d.data}`;
        if (!blocos.has(chave)) blocos.set(chave, []);
        blocos.get(chave).push(d);
    });

    lista.innerHTML = [...blocos.values()].slice(0, 10).map((bloco) => {
        const rotulo = bloco.length === 2
            ? `${dataCurta(bloco[0].data)} e ${dataCurta(bloco[1].data)}`
            : dataCurta(bloco[0].data);
        const sub = bloco[0].fimDeSemana ? "Fim de semana" : cap(NOMES_DIA[bloco[0].diaSemana]);
        const lideres = bloco.map((d) => (d.encarregadoId ? `${cap(NOMES_DIA_CURTO[d.diaSemana])} ${nomePessoa(d.encarregadoId)}` : null)).filter(Boolean);
        const unico = new Set(bloco.map((d) => d.encarregadoId)).size === 1 && bloco[0].encarregadoId;

        return `
            <li>
                <span class="previa-data">${rotulo}<small>${sub}</small></span>
                <span class="previa-equipes">
                    ${bloco.map((d) => `
                        <span class="pilula ${d.feriado ? "pilula--feriado" : ""}" style="--cor:${corTurma(d.equipeId)}"
                              title="${d.feriado ? esc(d.feriado.descricao) : ""}">
                            <i aria-hidden="true"></i>${tipoAtual === "noturna" && d.fimDeSemana ? nomeTurma(d.equipeId) : `${cap(NOMES_DIA_CURTO[d.diaSemana])} ${nomeTurma(d.equipeId)}`}${d.feriado ? " (feriado)" : ""}
                        </span>`).join("")}
                    ${unico
                        ? `<span class="pilula pilula--lider"><i class="fa-solid fa-star" aria-hidden="true"></i>${esc(nomePessoa(bloco[0].encarregadoId))}</span>`
                        : lideres.map((l) => `<span class="pilula pilula--lider"><i class="fa-solid fa-star" aria-hidden="true"></i>${esc(l)}</span>`).join("")}
                </span>
            </li>`;
    }).join("");
}

formRotacao.addEventListener("change", (e) => {
    if (e.target.name === "modoEncarregado") atualizarCampoEncarregado();
});
formRotacao.addEventListener("input", renderPrevia);
formRotacao.addEventListener("change", renderPrevia);

formRotacao.addEventListener("submit", async (e) => {
    e.preventDefault();
    const novo = lerFormRotacao();
    try {
        await salvarConfig(tipoAtual, novo);
        config = { ...novo, existe: true };
        $("dataReferencia").value = config.dataReferencia;
        renderMes();
        renderFeriados();
        renderPrevia();
        aviso(`Rotação da ${TIPOS[tipoAtual].rotulo.toLowerCase()} salva. Meses já salvos mantêm os ajustes feitos.`);
    } catch (erro) {
        console.error(erro);
        aviso("Não foi possível salvar a rotação.", "erro");
    }
});
