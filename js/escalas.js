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
    ROTULO_AUSENCIA, TIPOS, TURMAS, turmaPorId, turmaFixaDoFeriado,
    modoEncarregado, pessoasDoDia, ativosDaEscala, turmaDe, ehEncarregado, esc
} from "./dados.js";
import {
    gerarEscalaDoMes, distribuirFeriados, feriadosNacionais,
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
let ajustes = { trocas: {}, ausencias: {}, salvo: false };
let sujo = false;
const pronto = { equipes: false, funcionarios: false, feriados: false, config: false };

const $ = (id) => document.getElementById(id);
const hoje = hojeISO();
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const corTurma = (id) => turmaPorId(id)?.cor || "#8b93a1";
const nomeTurma = (id) => turmaPorId(id)?.curto || "Sem turma";

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
        config = c;

        // primeiro uso: o rodízio parte deste fim de semana com a turma A
        if (!config.existe) {
            config = {
                ...config,
                dataReferencia: sabadoDoFimDeSemana(hoje),
                equipeInicialId: "A",
                feriadoEquipeInicialId: "A",
                existe: true
            };
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
        ajustes = { trocas: {}, ausencias: {}, salvo: false };
        aviso("Não foi possível ler os ajustes salvos deste mês.", "erro");
    }
    renderMes();
}

$("mesAnterior").addEventListener("click", () => carregarMes(somarMeses(mesAtual, -1)));
$("mesProximo").addEventListener("click", () => carregarMes(somarMeses(mesAtual, 1)));
$("mesHoje").addEventListener("click", () => carregarMes(mesDe(hoje)));
$("mes").addEventListener("change", (e) => e.target.value && carregarMes(e.target.value));

const modo = () => modoEncarregado(config, tipoAtual);

function diasDoMesAtual() {
    return gerarEscalaDoMes(mesAtual, { equipes: TURMAS, feriados, config: config || {}, ajustes });
}

const pessoas = (d) => pessoasDoDia(d, funcionarios, ajustes, tipoAtual, modo(), equipes);

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

function htmlDia(d) {
    const { encarregados, integrantes, grupos } = pessoas(d);
    const presentes = [...encarregados, ...integrantes].filter((p) => !p.ausencia).length;
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
                        ${TURMAS.map((t) => `
                            <button class="turma-bt ${t.id === d.equipeId ? "ativo" : ""}" style="--cor:${t.cor}"
                                    data-troca="${d.data}" data-turma="${t.id}" aria-pressed="${t.id === d.equipeId}">
                                ${t.curto}
                            </button>`).join("")}
                    </div>
                    ${d.alterado ? `<button class="voltar-auto" data-voltar="${d.data}" title="Voltar para a ${esc(nomeTurma(d.equipeOriginalId))}, do rodízio" aria-label="Voltar para o rodízio"><i class="fa-solid fa-rotate-left"></i></button>` : ""}
                    <span class="dia-total">${presentes} ${presentes === 1 ? "pessoa" : "pessoas"}</span>
                </div>

                ${encarregados.length ? `
                    <div class="dia-lider">
                        <span class="lider-rotulo">${encarregados.length === 1 ? "Encarregado" : "Encarregados"}</span>
                        <ul class="membros">${encarregados.map((p) => htmlPessoa(p, d, "membro--lider")).join("")}</ul>
                    </div>` : ""}

                ${grupos.map((g) => `
                    <div class="dia-grupo" style="--cor-grupo:${esc(g.cor)}">
                        <span class="grupo-nome"><i aria-hidden="true"></i>${esc(g.nome)}</span>
                        <ul class="membros">${g.pessoas.map((p) => htmlPessoa(p, d)).join("")}</ul>
                    </div>`).join("")}

                ${!encarregados.length && !integrantes.length
                    ? `<p class="sem-membros">Ninguém na ${esc(turma?.curto || "turma")}. Defina as turmas em Funcionários.</p>`
                    : presentes === 0 ? `<p class="sem-membros">Todos ausentes. Troque a turma deste dia.</p>` : ""}
            </div>
        </article>`;
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
    const semTurma = ativos.filter((f) => !turmaDe(f) && !(modo() === "todos" && ehEncarregado(f, equipes))).length;

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

    resumo.innerHTML = TURMAS.map((t) => {
        const nDias = dias.filter((d) => d.equipeId === t.id).length;
        const nPessoas = ativos.filter((f) => turmaDe(f) === t.id && !(modo() === "todos" && ehEncarregado(f, equipes))).length;
        return `
            <div class="resumo-item" style="--cor:${t.cor}">
                <i class="vela" aria-hidden="true"></i>
                <strong>${t.curto}</strong>
                <span>${nDias} ${nDias === 1 ? "dia" : "dias"}, ${nPessoas} ${nPessoas === 1 ? "pessoa" : "pessoas"}</span>
            </div>`;
    }).join("") + (semTurma
        ? `<a class="resumo-item resumo-item--alerta" href="/pages/funcionarios.html?tipo=${tipoAtual}">
               <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
               <strong>${semTurma} sem fim de semana</strong>
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

$("gradeDias").addEventListener("click", (e) => {
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
        const { encarregados, integrantes } = pessoas(d);
        const resumo = (p) => ({ id: p.id, nome: p.nome, equipeId: p.equipeId || null, ausencia: p.ausencia });
        return {
            data: d.data,
            tipo: d.tipo,
            feriado: d.feriado?.descricao || null,
            turma: d.equipeId,
            trocada: d.alterado,
            encarregados: encarregados.map(resumo),
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

// ======================================================
// PDF
// ======================================================

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

$("btnPDF").addEventListener("click", async () => {
    if (!window.jspdf) {
        aviso("O gerador de PDF não carregou. Recarregue a página.", "erro");
        return;
    }

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF("p", "mm", "a4");
    const largura = pdf.internal.pageSize.getWidth();
    const dias = diasDoMesAtual();
    const comAusencia = (p) => (p.ausencia ? `${p.nome} (${ROTULO_AUSENCIA[p.ausencia].toLowerCase()})` : p.nome);

    const logo = await logoComoDataURL();
    if (logo) pdf.addImage(logo, "JPEG", 14, 10, 54, 18);

    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(16);
    pdf.text(`${TIPOS[tipoAtual].rotulo} de plantão`, largura - 14, 17, { align: "right" });
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(12);
    pdf.text(`Manutenção, ${tituloMes(mesAtual).toLowerCase()}`, largura - 14, 24, { align: "right" });

    const corpo = dias.map((d) => {
        const { encarregados, grupos } = pessoas(d);
        const integrantes = grupos.map((g) => `${g.nome}: ${g.pessoas.map(comAusencia).join(", ")}`).join("\n");
        const obs = [d.feriado ? `Feriado: ${d.feriado.descricao}` : "", d.alterado ? "Turma trocada" : ""]
            .filter(Boolean).join(". ");
        return [
            dataCurta(d.data),
            cap(NOMES_DIA[d.diaSemana]),
            nomeTurma(d.equipeId),
            encarregados.map(comAusencia).join(", ") || "-",
            integrantes || "-",
            obs
        ];
    });

    pdf.autoTable({
        startY: 34,
        head: [["Data", "Dia", "Turma", "Encarregado", "Integrantes", "Observação"]],
        body: corpo,
        styles: { fontSize: 8.5, cellPadding: 2.2, valign: "middle" },
        headStyles: { fillColor: [27, 35, 48], textColor: 255 },
        columnStyles: {
            0: { cellWidth: 13, fontStyle: "bold" },
            1: { cellWidth: 21 },
            2: { cellWidth: 17, fontStyle: "bold" },
            3: { cellWidth: 32, fontStyle: "bold" },
            5: { cellWidth: 30 }
        },
        didParseCell: (data) => {
            if (data.section !== "body") return;
            const d = dias[data.row.index];
            if (data.column.index === 2) {
                data.cell.styles.fillColor = hexParaRGB(corTurma(d.equipeId));
                data.cell.styles.textColor = 255;
            } else if (data.column.index === 3) {
                data.cell.styles.fillColor = [255, 244, 219];
                data.cell.styles.textColor = [120, 78, 0];
            } else if (d.feriado) {
                data.cell.styles.fillColor = [253, 236, 236];
            }
        }
    });

    // composição das turmas
    const ativos = ativosDaEscala(funcionarios, tipoAtual);
    const nomeEquipe = (id) => equipes.find((e) => e.id === id)?.nome || "Sem equipe";
    const linhasTurma = TURMAS.map((t) => {
        const daTurma = ativos.filter((f) => turmaDe(f) === t.id && !(modo() === "todos" && ehEncarregado(f, equipes)));
        const porEquipe = new Map();
        daTurma.forEach((f) => {
            const k = nomeEquipe(f.equipeId);
            porEquipe.set(k, [...(porEquipe.get(k) || []), f.nome]);
        });
        return [t.curto, [...porEquipe.entries()].map(([k, v]) => `${k}: ${v.join(", ")}`).join("\n") || "-"];
    });
    if (modo() === "todos") {
        const lideres = ativos.filter((f) => ehEncarregado(f, equipes)).map((f) => f.nome);
        if (lideres.length) linhasTurma.unshift(["Encarregados", `${lideres.join(", ")} (nos dois fins de semana)`]);
    }

    pdf.autoTable({
        startY: pdf.lastAutoTable.finalY + 10,
        head: [["Turma", "Integrantes"]],
        body: linhasTurma,
        styles: { fontSize: 8.5, cellPadding: 2.4 },
        headStyles: { fillColor: [27, 35, 48], textColor: 255 },
        columnStyles: { 0: { cellWidth: 30, fontStyle: "bold" } },
        didParseCell: (data) => {
            if (data.section !== "body" || data.column.index !== 0) return;
            const t = TURMAS.find((x) => x.curto === data.cell.raw);
            data.cell.styles.fillColor = t ? hexParaRGB(t.cor) : [227, 154, 18];
            data.cell.styles.textColor = 255;
        }
    });

    const paginas = pdf.getNumberOfPages();
    for (let p = 1; p <= paginas; p++) {
        pdf.setPage(p);
        pdf.setFontSize(8);
        pdf.setTextColor(120);
        pdf.text(`Gerado em ${new Date().toLocaleDateString("pt-BR")}${sujo ? " (com alterações não salvas)" : ""}`, 14, 290);
        pdf.text(`Página ${p} de ${paginas}`, largura - 14, 290, { align: "right" });
    }

    pdf.save(`Escala_${TIPOS[tipoAtual].curto}_${mesAtual}.pdf`);
});

// ======================================================
// FERIADOS
// ======================================================

const opcoesTurma = (selecionada, rotuloAuto) =>
    `<option value="">${esc(rotuloAuto)}</option>` +
    TURMAS.map((t) => `<option value="${t.id}" ${t.id === selecionada ? "selected" : ""}>${t.curto}</option>`).join("");

function renderFeriados() {
    $("feriadoEquipe").innerHTML = opcoesTurma(null, "Próxima da fila (automático)");

    const lista = $("listaFeriados");
    const mostrarPassados = $("mostrarPassados").checked;
    const distribuidos = distribuirFeriados(feriados, TURMAS, config || {})
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
const turmaValida = (v) => (v === "A" || v === "B" ? v : "A");

function marcar(nome, valor) {
    const r = formRotacao.querySelector(`input[name="${nome}"][value="${valor}"]`) ||
        formRotacao.querySelector(`input[name="${nome}"]`);
    if (r) r.checked = true;
}

function preencherFormRotacao() {
    if (!config) return;
    marcar("modo", config.modo);
    marcar("feriadoFds", config.feriadoNoFimDeSemana);
    marcar("modoEncarregado", modoEncarregado(config, tipoAtual));
    $("dataReferencia").value = config.dataReferencia;
    $("equipeInicial").value = turmaValida(config.equipeInicialId);
    $("feriadoEquipeInicial").value = turmaValida(config.feriadoEquipeInicialId);
}

function lerFormRotacao() {
    const valor = (nome, padrao) => formRotacao.querySelector(`input[name="${nome}"]:checked`)?.value || padrao;
    return {
        ...config,
        modo: valor("modo", "fimdesemana"),
        dataReferencia: sabadoDoFimDeSemana($("dataReferencia").value || config.dataReferencia),
        equipeInicialId: $("equipeInicial").value,
        feriadoEquipeInicialId: $("feriadoEquipeInicial").value,
        feriadoNoFimDeSemana: valor("feriadoFds", "feriado"),
        encarregadoModo: valor("modoEncarregado", modoEncarregado(config, tipoAtual))
    };
}

function renderPrevia() {
    const lista = $("previa");
    if (!config) return;

    const rascunho = lerFormRotacao();
    const modoRascunho = modoEncarregado(rascunho, tipoAtual);
    const dias = [0, 1, 2, 3]
        .flatMap((n) => gerarEscalaDoMes(somarMeses(mesDe(hoje), n), { equipes: TURMAS, feriados, config: rascunho }))
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
        const lideres = [...new Set(bloco.flatMap((d) =>
            pessoasDoDia(d, funcionarios, {}, tipoAtual, modoRascunho, equipes).encarregados.map((p) => p.nome)))];

        return `
            <li>
                <span class="previa-data">${rotulo}<small>${sub}</small></span>
                <span class="previa-equipes">
                    ${bloco.map((d) => `
                        <span class="pilula ${d.feriado ? "pilula--feriado" : ""}" style="--cor:${corTurma(d.equipeId)}"
                              title="${d.feriado ? esc(d.feriado.descricao) : ""}">
                            <i aria-hidden="true"></i>${cap(NOMES_DIA_CURTO[d.diaSemana])} ${nomeTurma(d.equipeId)}${d.feriado ? " (feriado)" : ""}
                        </span>`).join("")}
                    ${lideres.length ? `<span class="pilula pilula--lider"><i class="fa-solid fa-star" aria-hidden="true"></i>${esc(lideres.join(", "))}</span>` : ""}
                </span>
            </li>`;
    }).join("");
}

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
