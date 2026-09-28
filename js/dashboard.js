// ======================================================
// Escala São Miguel
// dashboard.js — plantão atual (diurna e noturna), feriados e turmas
// ======================================================

import { montarLayout } from "./layout.js";
import {
    lerColecao, lerConfig, salvarConfig, lerAjustesDoMes, ordenarEquipes,
    ROTULO_AUSENCIA, TIPOS, TURMAS, turmaPorId, turmaDe, turmaFixaDoFeriado,
    modoEncarregado, pessoasDoDia, ativosDaEscala, ehEncarregado, esc
} from "./dados.js";
import {
    gerarEscalaDoMes, distribuirFeriados, sabadoDoFimDeSemana,
    somarDias, hojeISO, mesDe, NOMES_DIA, NOMES_DIA_CURTO, NOMES_MES, dataCurta, diaDaSemana
} from "./escala-engine.js";

montarLayout("dashboard");

const hora = new Date().getHours();
document.getElementById("saudacao").textContent =
    hora < 12 ? "Bom dia" : hora < 18 ? "Boa tarde" : "Boa noite";

const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const hoje = hojeISO();

// Próximo plantão de uma escala: fim de semana atual (ou o próximo),
// com o feriado mais próximo na frente se ele vier antes
async function plantaoDaEscala(tipo, equipes, funcionarios, todosFeriados) {
    let config = await lerConfig(tipo);
    if (!config.existe) {
        config = { ...config, dataReferencia: sabadoDoFimDeSemana(hoje), equipeInicialId: "A", feriadoEquipeInicialId: "A", existe: true };
        salvarConfig(tipo, config).catch((erro) => console.error(erro));
    }

    const modo = modoEncarregado(config, tipo);
    const feriados = todosFeriados.map((f) => ({ ...f, equipeFixaId: turmaFixaDoFeriado(f, tipo) }));
    const temTurmas = ativosDaEscala(funcionarios, tipo).some((f) => turmaDe(f));

    const sabado = sabadoDoFimDeSemana(hoje);
    const datas = [sabado, somarDias(sabado, 1)].filter((d) => d >= hoje);
    const distribuidos = distribuirFeriados(feriados, TURMAS, config);
    const feriadoAntes = distribuidos.find((f) => f.data >= hoje && f.data < datas[0]);
    if (feriadoAntes) datas.unshift(feriadoAntes.data);

    const meses = [...new Set(datas.map(mesDe))];
    const ajustesPorMes = Object.fromEntries(
        await Promise.all(meses.map(async (m) => [m, await lerAjustesDoMes(m, tipo)]))
    );
    const escalaPorMes = Object.fromEntries(meses.map((m) => [
        m, gerarEscalaDoMes(m, { equipes: TURMAS, feriados, config, ajustes: ajustesPorMes[m] })
    ]));

    const dias = datas
        .map((iso) => escalaPorMes[mesDe(iso)].find((d) => d.data === iso))
        .filter(Boolean)
        .map((d) => ({ ...d, ...pessoasDoDia(d, funcionarios, ajustesPorMes[mesDe(d.data)], tipo, modo, equipes) }));

    return { tipo, dias, temTurmas, feriados: distribuidos.filter((f) => f.data >= hoje) };
}

function htmlPlantao({ tipo, dias, temTurmas }) {
    const titulo = `<h2 class="plantao-titulo"><i class="fa-solid ${TIPOS[tipo].icone}" aria-hidden="true"></i> ${TIPOS[tipo].rotulo}</h2>`;

    if (!temTurmas) {
        return `${titulo}
            <div class="vazio" style="margin-bottom:28px">
                <p>Ninguém da ${TIPOS[tipo].rotulo.toLowerCase()} está em uma turma ainda.</p>
                <a class="bt bt-contorno" href="/pages/funcionarios.html?tipo=${tipo}">Organizar turmas</a>
            </div>`;
    }

    const nome = (p) => `<li class="${p.ausencia ? "ausente" : ""}" title="${p.ausencia ? ROTULO_AUSENCIA[p.ausencia] : ""}">${esc(p.nome)}</li>`;

    return `${titulo}
        <section class="plantao">
            ${dias.map((d) => {
                const t = turmaPorId(d.equipeId);
                const quando = d.data === hoje ? "Hoje" : d.data === somarDias(hoje, 1) ? "Amanhã" : cap(NOMES_DIA[d.diaSemana]);
                return `
                    <article class="plantao-dia" style="--cor:${t?.cor || "#8b93a1"}">
                        <div class="plantao-data" aria-hidden="true">
                            <strong>${d.data.slice(8)}</strong>
                            <span>${NOMES_DIA_CURTO[d.diaSemana]} ${NOMES_MES[Number(d.data.slice(5, 7)) - 1].slice(0, 3)}</span>
                        </div>
                        <p class="plantao-quando">${quando}, ${dataCurta(d.data)}</p>
                        <h3 class="plantao-equipe">${esc(t?.nome || "Sem turma")}</h3>
                        ${d.feriado ? `<p class="plantao-feriado">Feriado: ${esc(d.feriado.descricao)}</p>` : ""}
                        ${d.encarregados.length ? `
                            <p class="plantao-lider">
                                <i class="fa-solid fa-star" aria-hidden="true"></i>
                                <span>${d.encarregados.length === 1 ? "Encarregado" : "Encarregados"}</span>
                                <strong>${d.encarregados.map((p) => esc(p.nome) + (p.ausencia ? ` (${ROTULO_AUSENCIA[p.ausencia].toLowerCase()})` : "")).join(", ")}</strong>
                            </p>` : ""}
                        ${d.grupos.map((g) => `
                            <div class="plantao-grupo">
                                <span class="plantao-grupo-nome" style="--cor-grupo:${esc(g.cor)}"><i aria-hidden="true"></i>${esc(g.nome)}</span>
                                <ul class="plantao-membros">${g.pessoas.map(nome).join("")}</ul>
                            </div>`).join("")}
                        ${!d.grupos.length && !d.encarregados.length ? `<p class="texto-apoio">Ninguém nesta turma.</p>` : ""}
                    </article>`;
            }).join("")}
        </section>`;
}

function renderFeriados(resultados) {
    const el = document.getElementById("proximosFeriados");
    const porData = new Map();
    resultados.forEach(({ tipo, feriados }) => feriados.forEach((f) => {
        if (!porData.has(f.data)) porData.set(f.data, { ...f, turmas: {} });
        porData.get(f.data).turmas[tipo] = f.equipeId;
    }));
    const lista = [...porData.values()].sort((a, b) => a.data.localeCompare(b.data)).slice(0, 5);

    el.innerHTML = lista.length
        ? lista.map((f) => `
            <li>
                <span class="principal">${esc(f.descricao)}<small>${dataCurta(f.data)}, ${NOMES_DIA[diaDaSemana(f.data)]}</small></span>
                <span class="lado-duplo">
                    ${["diurna", "noturna"].filter((t) => f.turmas[t]).map((t) => {
                        const turma = turmaPorId(f.turmas[t]);
                        return `<span style="--cor:${turma?.cor || "#8b93a1"}" title="${TIPOS[t].rotulo}"><i aria-hidden="true"></i>${TIPOS[t].curto}: ${turma?.curto || ""}</span>`;
                    }).join("")}
                </span>
            </li>`).join("")
        : `<li><span class="texto-apoio">Nenhum feriado cadastrado pela frente.</span></li>`;
}

function renderTurmas(funcionarios, equipes, configs) {
    const el = document.getElementById("listaEquipes");
    el.innerHTML = ["diurna", "noturna"].map((tipo) => {
        const ativos = ativosDaEscala(funcionarios, tipo);
        if (!ativos.length) return "";
        const todos = modoEncarregado(configs[tipo], tipo) === "todos";
        const lideres = ativos.filter((f) => ehEncarregado(f, equipes));
        const conta = (id) => ativos.filter((f) => turmaDe(f) === id && !(todos && ehEncarregado(f, equipes))).length;
        const sem = ativos.filter((f) => !turmaDe(f) && !(todos && ehEncarregado(f, equipes))).length;

        return `<li class="grupo">${TIPOS[tipo].rotulo}</li>` +
            TURMAS.map((t) => `
                <li style="--cor:${t.cor}">
                    <i class="vela" aria-hidden="true"></i>
                    <span class="principal">${t.nome}</span>
                    <span class="lado">${conta(t.id)} ${conta(t.id) === 1 ? "pessoa" : "pessoas"}</span>
                </li>`).join("") +
            (lideres.length ? `
                <li>
                    <span class="principal">Encarregados<small>${todos ? "Nos dois fins de semana" : "Com a própria turma"}</small></span>
                    <span class="lado">${lideres.length}</span>
                </li>` : "") +
            (sem ? `
                <li>
                    <span class="principal">Sem fim de semana<small>Ficam fora da escala até irem para A ou B</small></span>
                    <span class="lado">${sem}</span>
                </li>` : "");
    }).join("") || `<li><span class="texto-apoio">Nenhum funcionário cadastrado.</span></li>`;
}

async function iniciar() {
    const [equipesBrutas, funcionarios, feriados, cfgD, cfgN] = await Promise.all([
        lerColecao("equipes"), lerColecao("funcionarios"), lerColecao("feriados"), lerConfig("diurna"), lerConfig("noturna")
    ]);
    const equipes = ordenarEquipes(equipesBrutas);
    renderTurmas(funcionarios, equipes, { diurna: cfgD, noturna: cfgN });

    const resultados = await Promise.all(
        ["diurna", "noturna"].map((t) => plantaoDaEscala(t, equipes, funcionarios, feriados))
    );
    document.getElementById("plantoes").innerHTML = resultados.map(htmlPlantao).join("");
    renderFeriados(resultados);
}

iniciar().catch((erro) => {
    console.error(erro);
    document.getElementById("plantoes").innerHTML =
        `<div class="vazio"><h3>Não foi possível carregar o plantão</h3><p>Verifique a conexão e recarregue a página.</p></div>`;
});
