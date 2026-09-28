// ======================================================
// Escala São Miguel
// escalas.js — escala mensal automática, feriados e rotação
// ======================================================

import { db } from "./firebase.js";
import { montarLayout, aviso } from "./layout.js";
import {
    ouvirEquipes, ouvirFuncionarios, ouvirFeriados,
    lerConfig, salvarConfig, lerAjustesDoMes, salvarEscalaDoMes,
    ROTULO_AUSENCIA, TIPOS, tipoDaEquipe, equipeFixaDoTipo, esc
} from "./dados.js";
import {
    gerarEscalaDoMes, integrantesDoDia, distribuirFeriados, feriadosNacionais,
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

// "equipes" e "feriados" guardam só o que vale para a escala aberta
// (diurna ou noturna); as listas completas ficam em "todas...".
let todasEquipes = [];
let todosFeriados = [];
let equipes = [];
let funcionarios = [];
let feriados = [];
const params = new URLSearchParams(location.search);
let tipoAtual = params.get("tipo") === "noturna" ? "noturna" : "diurna";
let config = null;
let mesAtual = params.get("mes") || mesDe(hojeISO());
let ajustes = { trocas: {}, ausencias: {}, salvo: false };
let sujo = false;
const pronto = { equipes: false, funcionarios: false, feriados: false, config: false };

const $ = (id) => document.getElementById(id);
const hoje = hojeISO();

const equipePorId = (id) => equipes.find((e) => e.id === id);
const nomeEquipe = (id) => equipePorId(id)?.nome || "Sem equipe";
const corEquipe = (id) => equipePorId(id)?.cor || "#8b93a1";
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

// ------------------------------------------------------
// Carregamento
// ------------------------------------------------------

function filtrarPorTipo() {
    equipes = todasEquipes.filter((e) => tipoDaEquipe(e) === tipoAtual);
    feriados = todosFeriados.map((f) => ({ ...f, equipeFixaId: equipeFixaDoTipo(f, tipoAtual, todasEquipes) }));
}

ouvirEquipes((l) => { todasEquipes = l; filtrarPorTipo(); pronto.equipes = true; aoMudarDados(); });
ouvirFuncionarios((l) => { funcionarios = l; pronto.funcionarios = true; aoMudarDados(); });
ouvirFeriados((l) => { todosFeriados = l; filtrarPorTipo(); pronto.feriados = true; aoMudarDados(); });

let pedidoConfig = 0;
async function carregarConfig() {
    const pedido = ++pedidoConfig;
    pronto.config = false;
    try {
        const c = await lerConfig(tipoAtual);
        if (pedido !== pedidoConfig) return; // trocou de escala no meio
        config = c;
        pronto.config = true;
        preencherFormRotacao();
        aoMudarDados();
    } catch (erro) {
        console.error(erro);
        aviso("Não foi possível ler a configuração do rodízio.", "erro");
    }
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
    document.getElementById("linkOrdem").href = `/pages/funcionarios.html?tipo=${tipoAtual}`;
    document.title = `${TIPOS[tipoAtual].rotulo} | Escala São Miguel`;
}

document.querySelectorAll(".seletor-bt").forEach((bt) => {
    bt.addEventListener("click", async () => {
        if (bt.dataset.tipo === tipoAtual) return;
        if (sujo && !confirm("Há alterações não salvas nesta escala. Descartar e trocar?")) return;
        tipoAtual = bt.dataset.tipo;
        sujo = false;
        filtrarPorTipo();
        atualizarSeletor();
        carregarConfig();
        await carregarMes(mesAtual, true);
    });
});

async function aoMudarDados() {
    if (!Object.values(pronto).every(Boolean)) return;

    // Primeiro uso: fixa o ponto de partida no fim de semana atual,
    // para o rodízio não mudar sozinho com o passar do tempo.
    if (!config.existe && equipes.length) {
        config = {
            ...config,
            dataReferencia: sabadoDoFimDeSemana(hoje),
            equipeInicialId: equipes[0].id,
            feriadoEquipeInicialId: equipes[0].id,
            existe: true
        };
        try {
            await salvarConfig(tipoAtual, config);
            aviso(`${TIPOS[tipoAtual].rotulo}: ${equipes[0].nome} começa neste fim de semana. Ajuste na aba Rotação.`);
        } catch (erro) {
            console.error(erro);
        }
        preencherFormRotacao();
    }

    renderMes();
    renderFeriados();
    renderOrdemEquipes();
    renderPrevia();
}

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

function diasDoMesAtual() {
    return gerarEscalaDoMes(mesAtual, { equipes, feriados, config: config || {}, ajustes });
}

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

    if (!primeiro.fimDeSemana) {
        return `${cap(NOMES_DIA[primeiro.diaSemana])}, ${dia(primeiro.data)} de ${mes}`;
    }
    if (bloco.length === 2) {
        return `Fim de semana de ${dia(bloco[0].data)} e ${dia(bloco[1].data)} de ${mes}`;
    }
    return `${cap(NOMES_DIA[primeiro.diaSemana])}, ${dia(primeiro.data)} de ${mes}`;
}

function htmlDia(d) {
    const integrantes = integrantesDoDia(d, funcionarios, ajustes);
    const presentes = integrantes.filter((i) => !i.ausencia).length;
    const original = nomeEquipe(d.equipeOriginalId);

    const chips = integrantes.map((i) => `
        <li>
            <button class="membro ${i.ausencia ? "ausente" : ""}"
                    data-membro="${esc(i.id)}" data-dia="${d.data}"
                    title="${i.ausencia ? "Clique para mudar ou remover a ausência" : "Clique para marcar férias ou afastamento"}">
                <span class="nome">${esc(i.nome)}</span>
                ${i.ausencia ? `<small>${ROTULO_AUSENCIA[i.ausencia]}</small>` : ""}
            </button>
        </li>`).join("");

    return `
        <article class="dia ${d.data === hoje ? "hoje" : ""}" style="--cor:${esc(corEquipe(d.equipeId))}">
            <div class="dia-vela" aria-hidden="true">
                <strong>${d.data.slice(8)}</strong>
                <span>${NOMES_DIA_CURTO[d.diaSemana]}</span>
            </div>
            <div class="dia-corpo">
                <div class="dia-topo">
                    <span class="dia-nome">${cap(NOMES_DIA[d.diaSemana])}, ${dataCurta(d.data)}</span>
                    ${d.feriado ? `<span class="tag tag-feriado">Feriado</span>` : ""}
                    ${d.alterado ? `<span class="tag tag-alterado">Trocada</span>` : ""}
                </div>
                ${d.feriado ? `<p class="feriado-nome">${esc(d.feriado.descricao)}</p>` : ""}
                <div class="dia-equipe">
                    <select data-troca="${d.data}" aria-label="Equipe de plantão em ${dataCurta(d.data)}">
                        ${equipes.map((e) => `<option value="${esc(e.id)}" ${e.id === d.equipeId ? "selected" : ""}>${esc(e.nome)}</option>`).join("")}
                    </select>
                    ${d.alterado ? `<button class="voltar-auto" data-voltar="${d.data}" title="Voltar para a equipe do rodízio (${esc(original)})" aria-label="Voltar para ${esc(original)}"><i class="fa-solid fa-rotate-left"></i></button>` : ""}
                </div>
                ${integrantes.length
                    ? `<ul class="membros">${chips}</ul>${presentes === 0 ? `<p class="sem-membros">Todos ausentes. Troque a equipe deste dia.</p>` : ""}`
                    : `<p class="sem-membros">Esta equipe não tem funcionários ativos.</p>`}
            </div>
        </article>`;
}

function renderMes() {
    renderStatus();

    const grade = $("gradeDias");
    const resumo = $("resumoEquipes");

    if (!pronto.equipes || !pronto.config) {
        grade.innerHTML = `<p class="texto-apoio">Carregando escala…</p>`;
        return;
    }

    if (!equipes.length) {
        resumo.innerHTML = "";
        grade.innerHTML = `
            <div class="vazio">
                <h3>A ${TIPOS[tipoAtual].rotulo.toLowerCase()} ainda não tem equipes</h3>
                <p>A escala reveza as equipes nos fins de semana. Monte pelo menos duas equipes ${tipoAtual === "noturna" ? "noturnas" : "diurnas"} e distribua os funcionários.</p>
                <a class="bt bt-principal" href="/pages/funcionarios.html?tipo=${tipoAtual}"><i class="fa-solid fa-people-group"></i> Montar equipes</a>
            </div>`;
        return;
    }

    const dias = diasDoMesAtual();

    // resumo: quantos dias cada equipe trabalha no mês
    const contagem = new Map(equipes.map((e) => [e.id, 0]));
    dias.forEach((d) => contagem.set(d.equipeId, (contagem.get(d.equipeId) || 0) + 1));
    resumo.innerHTML = equipes.map((e) => `
        <div class="resumo-item" style="--cor:${esc(e.cor)}">
            <i class="vela" aria-hidden="true"></i>
            <strong>${esc(e.nome)}</strong>
            <span>${contagem.get(e.id)} ${contagem.get(e.id) === 1 ? "dia" : "dias"}</span>
        </div>`).join("");

    // agrupa sábado+domingo do mesmo fim de semana; feriado em dia útil fica sozinho
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

// troca de equipe num dia
$("gradeDias").addEventListener("change", (e) => {
    const select = e.target.closest("select[data-troca]");
    if (!select) return;

    const iso = select.dataset.troca;
    const dia = diasDoMesAtual().find((d) => d.data === iso);
    const trocas = { ...ajustes.trocas };

    if (select.value === dia?.equipeOriginalId) delete trocas[iso];
    else trocas[iso] = select.value;

    ajustes = { ...ajustes, trocas };
    marcarSujo();
    renderMes();
});

$("gradeDias").addEventListener("click", (e) => {
    // voltar ao automático
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

// salvar
$("btnSalvar").addEventListener("click", async () => {
    if (!equipes.length) {
        aviso("Crie as equipes antes de salvar a escala.", "erro");
        return;
    }

    const retrato = diasDoMesAtual().map((d) => ({
        data: d.data,
        tipo: d.tipo,
        feriado: d.feriado?.descricao || null,
        equipeId: d.equipeId,
        equipeNome: nomeEquipe(d.equipeId),
        trocada: d.alterado,
        integrantes: integrantesDoDia(d, funcionarios, ajustes).map((i) => ({
            id: i.id, nome: i.nome, ausencia: i.ausencia
        }))
    }));

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
    if (!equipes.length) {
        aviso("Crie as equipes antes de exportar.", "erro");
        return;
    }

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF("p", "mm", "a4");
    const largura = pdf.internal.pageSize.getWidth();
    const dias = diasDoMesAtual();

    const logo = await logoComoDataURL();
    if (logo) pdf.addImage(logo, "JPEG", 14, 10, 54, 18);

    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(16);
    pdf.text(`${TIPOS[tipoAtual].rotulo} de plantão`, largura - 14, 17, { align: "right" });
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(12);
    pdf.text(`Manutenção, ${tituloMes(mesAtual).toLowerCase()}`, largura - 14, 24, { align: "right" });

    const corpo = dias.map((d) => {
        const integrantes = integrantesDoDia(d, funcionarios, ajustes)
            .map((i) => i.ausencia ? `${i.nome} (${ROTULO_AUSENCIA[i.ausencia].toLowerCase()})` : i.nome)
            .join(", ");
        const obs = [d.feriado ? `Feriado: ${d.feriado.descricao}` : "", d.alterado ? "Equipe trocada" : ""]
            .filter(Boolean).join(". ");
        return [dataCurta(d.data), cap(NOMES_DIA[d.diaSemana]), nomeEquipe(d.equipeId), integrantes || "Sem funcionários", obs];
    });

    pdf.autoTable({
        startY: 34,
        head: [["Data", "Dia", "Equipe", "Integrantes", "Observação"]],
        body: corpo,
        styles: { fontSize: 9, cellPadding: 2.4, valign: "middle" },
        headStyles: { fillColor: [27, 35, 48], textColor: 255 },
        columnStyles: {
            0: { cellWidth: 16, fontStyle: "bold" },
            1: { cellWidth: 26 },
            2: { cellWidth: 28, fontStyle: "bold" },
            4: { cellWidth: 42 }
        },
        didParseCell: (data) => {
            if (data.section !== "body") return;
            const d = dias[data.row.index];
            if (data.column.index === 2) {
                data.cell.styles.fillColor = hexParaRGB(corEquipe(d.equipeId));
                data.cell.styles.textColor = 255;
            }
            if (d.feriado && data.column.index !== 2) {
                data.cell.styles.fillColor = [253, 236, 236];
            }
        }
    });

    // composição das equipes
    pdf.autoTable({
        startY: pdf.lastAutoTable.finalY + 10,
        head: [["Equipe", "Integrantes"]],
        body: equipes.map((e) => [
            e.nome,
            funcionarios.filter((f) => f.equipeId === e.id && f.status !== "Inativo")
                .map((f) => f.funcao ? `${f.nome} (${f.funcao})` : f.nome).join(", ") || "Sem funcionários"
        ]),
        styles: { fontSize: 9, cellPadding: 2.4 },
        headStyles: { fillColor: [27, 35, 48], textColor: 255 },
        columnStyles: { 0: { cellWidth: 34, fontStyle: "bold" } },
        didParseCell: (data) => {
            if (data.section === "body" && data.column.index === 0) {
                data.cell.styles.fillColor = hexParaRGB(equipes[data.row.index].cor);
                data.cell.styles.textColor = 255;
            }
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

function opcoesEquipes(selecionada, rotuloAuto) {
    return `<option value="">${esc(rotuloAuto)}</option>` +
        equipes.map((e) => `<option value="${esc(e.id)}" ${e.id === selecionada ? "selected" : ""}>${esc(e.nome)}</option>`).join("");
}

function renderFeriados() {
    $("feriadoEquipe").innerHTML = opcoesEquipes(null, "Próxima da fila (automático)");

    const lista = $("listaFeriados");
    const mostrarPassados = $("mostrarPassados").checked;
    const distribuidos = distribuirFeriados(feriados, equipes, config || {})
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
            ? "Cai no fim de semana: segue a equipe do fim de semana"
            : f.fixo ? "Equipe fixada neste feriado" : "Próxima da fila";

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
                <div class="feriado-equipe" style="--cor:${esc(corEquipe(f.equipeId))}">
                    <i class="vela" aria-hidden="true"></i>
                    <select data-fixar="${esc(f.id)}" aria-label="Equipe do feriado de ${dataCurta(f.data)}" ${f.segueFimDeSemana ? "disabled" : ""}>
                        ${opcoesEquipes(f.fixo ? f.equipeFixaId : null, f.fixo ? "Automático" : `${nomeEquipe(f.equipeId)} (auto)`)}
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
    if (feriados.some((f) => f.data === data)) {
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

    const existentes = new Set(feriados.map((f) => f.data));
    // Só importa de hoje em diante: feriados que já passaram
    // mudariam a fila do rodízio sem necessidade.
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
            ? `Feriado fixado com ${nomeEquipe(select.value)} na ${TIPOS[tipoAtual].rotulo.toLowerCase()}.`
            : "Feriado voltou para o automático.");
    } catch (erro) {
        console.error(erro);
        aviso("Não foi possível alterar a equipe do feriado.", "erro");
    }
});

$("listaFeriados").addEventListener("click", async (e) => {
    const bt = e.target.closest("[data-excluir-feriado]");
    if (!bt) return;
    const f = feriados.find((x) => x.id === bt.dataset.excluirFeriado);
    if (!f || !confirm(`Excluir o feriado ${f.descricao} (${dataCompleta(f.data)})? Os feriados seguintes mudam de equipe.`)) return;
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

function preencherFormRotacao() {
    if (!config) return;
    const opcoes = (sel) => equipes.map((e) => `<option value="${esc(e.id)}" ${e.id === sel ? "selected" : ""}>${esc(e.nome)}</option>`).join("");

    const modo = formRotacao.querySelector(`input[name="modo"][value="${config.modo}"]`)
        || formRotacao.querySelector('input[name="modo"]');
    const fds = formRotacao.querySelector(`input[name="feriadoFds"][value="${config.feriadoNoFimDeSemana}"]`)
        || formRotacao.querySelector('input[name="feriadoFds"]');
    modo.checked = true;
    fds.checked = true;
    $("dataReferencia").value = config.dataReferencia;
    $("equipeInicial").innerHTML = opcoes(config.equipeInicialId);
    $("feriadoEquipeInicial").innerHTML = opcoes(config.feriadoEquipeInicialId);
}

function lerFormRotacao() {
    const data = $("dataReferencia").value || config.dataReferencia;
    return {
        ...config,
        modo: formRotacao.querySelector('input[name="modo"]:checked')?.value || "fimdesemana",
        dataReferencia: sabadoDoFimDeSemana(data),
        equipeInicialId: $("equipeInicial").value || config.equipeInicialId || equipes[0]?.id || null,
        feriadoEquipeInicialId: $("feriadoEquipeInicial").value || config.feriadoEquipeInicialId || equipes[0]?.id || null,
        feriadoNoFimDeSemana: formRotacao.querySelector('input[name="feriadoFds"]:checked')?.value || "feriado"
    };
}

function renderOrdemEquipes() {
    // mantém as escolhas do formulário ao atualizar a lista de equipes
    if (config && equipes.length) {
        const rascunho = lerFormRotacao();
        const opcoes = (sel) => equipes.map((e) => `<option value="${esc(e.id)}" ${e.id === sel ? "selected" : ""}>${esc(e.nome)}</option>`).join("");
        $("equipeInicial").innerHTML = opcoes(rascunho.equipeInicialId);
        $("feriadoEquipeInicial").innerHTML = opcoes(rascunho.feriadoEquipeInicialId);
    }

    $("ordemEquipes").innerHTML = equipes.length
        ? equipes.map((e, i) => `
            <span class="ordem-item" style="--cor:${esc(e.cor)}">
                <i class="vela" aria-hidden="true"></i>${i + 1}. ${esc(e.nome)}
            </span>`).join("")
        : `<span class="texto-apoio">Nenhuma equipe criada.</span>`;
}

function renderPrevia() {
    const lista = $("previa");
    if (!config || !equipes.length) {
        lista.innerHTML = `<li><span class="texto-apoio">Crie equipes para ver a prévia.</span></li>`;
        return;
    }

    const rascunho = lerFormRotacao();
    const dias = [0, 1, 2, 3]
        .flatMap((n) => gerarEscalaDoMes(somarMeses(mesDe(hoje), n), { equipes, feriados, config: rascunho }))
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

        return `
            <li>
                <span class="previa-data">${rotulo}<small>${sub}</small></span>
                <span class="previa-equipes">
                    ${bloco.map((d) => `
                        <span class="pilula ${d.feriado ? "pilula--feriado" : ""}" style="--cor:${esc(corEquipe(d.equipeId))}"
                              title="${d.feriado ? esc(d.feriado.descricao) : ""}">
                            <i aria-hidden="true"></i>${cap(NOMES_DIA_CURTO[d.diaSemana])} ${esc(nomeEquipe(d.equipeId))}${d.feriado ? " (feriado)" : ""}
                        </span>`).join("")}
                </span>
            </li>`;
    }).join("");
}

formRotacao.addEventListener("input", renderPrevia);
formRotacao.addEventListener("change", renderPrevia);

formRotacao.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!equipes.length) {
        aviso("Crie as equipes antes de configurar a rotação.", "erro");
        return;
    }

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
