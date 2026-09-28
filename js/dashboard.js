// ======================================================
// Escala São Miguel
// dashboard.js — plantão atual (diurna e noturna), feriados e equipes
// ======================================================

import { montarLayout } from "./layout.js";
import {
    lerColecao, lerConfig, salvarConfig, lerAjustesDoMes, ordenarEquipes, ROTULO_AUSENCIA, TIPOS,
    tipoDaEquipe, tipoDoFuncionario, equipeFixaDoTipo, esc
} from "./dados.js";
import {
    gerarEscalaDoMes, integrantesDoDia, distribuirFeriados, sabadoDoFimDeSemana,
    somarDias, hojeISO, mesDe, NOMES_DIA, NOMES_DIA_CURTO, NOMES_MES, dataCurta, diaDaSemana
} from "./escala-engine.js";

montarLayout("dashboard");

const hora = new Date().getHours();
document.getElementById("saudacao").textContent =
    hora < 12 ? "Bom dia" : hora < 18 ? "Boa tarde" : "Boa noite";

const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const hoje = hojeISO();

// Calcula o próximo plantão de uma escala (fim de semana atual ou próximo,
// com o feriado mais próximo na frente se ele vier antes)
async function plantaoDaEscala(tipo, todasEquipes, funcionarios, todosFeriados) {
    const equipes = todasEquipes.filter((e) => tipoDaEquipe(e) === tipo);
    if (!equipes.length) return { tipo, equipes, dias: [], feriados: [] };

    let config = await lerConfig(tipo);

    // Primeiro acesso da escala: fixa o ponto de partida igual à tela Escala,
    // para as duas telas mostrarem sempre a mesma equipe.
    if (!config.existe) {
        config = {
            ...config,
            dataReferencia: sabadoDoFimDeSemana(hoje),
            equipeInicialId: equipes[0].id,
            feriadoEquipeInicialId: equipes[0].id,
            existe: true
        };
        salvarConfig(tipo, config).catch((erro) => console.error(erro));
    }
    const feriados = todosFeriados.map((f) => ({ ...f, equipeFixaId: equipeFixaDoTipo(f, tipo, todasEquipes) }));

    const sabado = sabadoDoFimDeSemana(hoje);
    const datas = [sabado, somarDias(sabado, 1)].filter((d) => d >= hoje);

    const distribuidos = distribuirFeriados(feriados, equipes, config);
    const feriadoAntes = distribuidos.find((f) => f.data >= hoje && f.data < datas[0]);
    if (feriadoAntes) datas.unshift(feriadoAntes.data);

    const meses = [...new Set(datas.map(mesDe))];
    const ajustesPorMes = Object.fromEntries(
        await Promise.all(meses.map(async (m) => [m, await lerAjustesDoMes(m, tipo)]))
    );
    const escalaPorMes = Object.fromEntries(meses.map((m) => [
        m, gerarEscalaDoMes(m, { equipes, feriados, config, ajustes: ajustesPorMes[m] })
    ]));

    const dias = datas
        .map((iso) => escalaPorMes[mesDe(iso)].find((d) => d.data === iso))
        .filter(Boolean)
        .map((d) => ({ ...d, integrantes: integrantesDoDia(d, funcionarios, ajustesPorMes[mesDe(d.data)]) }));

    return { tipo, equipes, dias, feriados: distribuidos.filter((f) => f.data >= hoje) };
}

function htmlPlantao({ tipo, equipes, dias }) {
    const titulo = `<h2 class="plantao-titulo"><i class="fa-solid ${TIPOS[tipo].icone}" aria-hidden="true"></i> ${TIPOS[tipo].rotulo}</h2>`;

    if (!equipes.length) {
        return `${titulo}
            <div class="vazio" style="margin-bottom:28px">
                <p>A ${TIPOS[tipo].rotulo.toLowerCase()} ainda não tem equipes.</p>
                <a class="bt bt-contorno" href="/pages/funcionarios.html?tipo=${tipo}">Montar equipes</a>
            </div>`;
    }

    const equipe = (id) => equipes.find((e) => e.id === id);

    return `${titulo}
        <section class="plantao">
            ${dias.map((d) => {
                const e = equipe(d.equipeId);
                const quando = d.data === hoje ? "Hoje" : d.data === somarDias(hoje, 1) ? "Amanhã" : cap(NOMES_DIA[d.diaSemana]);
                return `
                    <article class="plantao-dia" style="--cor:${esc(e?.cor || "#8b93a1")}">
                        <div class="plantao-data" aria-hidden="true">
                            <strong>${d.data.slice(8)}</strong>
                            <span>${NOMES_DIA_CURTO[d.diaSemana]} ${NOMES_MES[Number(d.data.slice(5, 7)) - 1].slice(0, 3)}</span>
                        </div>
                        <p class="plantao-quando">${quando}, ${dataCurta(d.data)}</p>
                        <h3 class="plantao-equipe">${esc(e?.nome || "Sem equipe")}</h3>
                        ${d.feriado ? `<p class="plantao-feriado">Feriado: ${esc(d.feriado.descricao)}</p>` : ""}
                        <ul class="plantao-membros">
                            ${d.integrantes.map((i) => `<li class="${i.ausencia ? "ausente" : ""}" title="${i.ausencia ? ROTULO_AUSENCIA[i.ausencia] : ""}">${esc(i.nome)}</li>`).join("")
                                || `<li>Sem funcionários ativos</li>`}
                        </ul>
                    </article>`;
            }).join("")}
        </section>`;
}

function renderFeriados(resultados, todasEquipes) {
    const el = document.getElementById("proximosFeriados");
    const equipe = (id) => todasEquipes.find((e) => e.id === id);

    // junta a equipe diurna e a noturna de cada feriado
    const porData = new Map();
    resultados.forEach(({ tipo, feriados }) => feriados.forEach((f) => {
        if (!porData.has(f.data)) porData.set(f.data, { ...f, equipes: {} });
        porData.get(f.data).equipes[tipo] = f.equipeId;
    }));
    const lista = [...porData.values()].sort((a, b) => a.data.localeCompare(b.data)).slice(0, 5);

    el.innerHTML = lista.length
        ? lista.map((f) => `
            <li>
                <span class="principal">${esc(f.descricao)}<small>${dataCurta(f.data)}, ${NOMES_DIA[diaDaSemana(f.data)]}</small></span>
                <span class="lado-duplo">
                    ${["diurna", "noturna"].filter((t) => f.equipes[t]).map((t) => {
                        const e = equipe(f.equipes[t]);
                        return `<span style="--cor:${esc(e?.cor || "#8b93a1")}" title="${TIPOS[t].rotulo}"><i aria-hidden="true"></i>${TIPOS[t].curto}: ${esc(e?.nome || "")}</span>`;
                    }).join("")}
                </span>
            </li>`).join("")
        : `<li><span class="texto-apoio">Nenhum feriado cadastrado pela frente.</span></li>`;
}

function renderEquipes(todasEquipes, funcionarios) {
    const el = document.getElementById("listaEquipes");
    const blocos = ["diurna", "noturna"].map((tipo) => {
        const equipes = todasEquipes.filter((e) => tipoDaEquipe(e) === tipo);
        const doTipo = funcionarios.filter((f) => tipoDoFuncionario(f) === tipo && f.status !== "Inativo");
        const semEquipe = doTipo.filter((f) => !equipes.some((e) => e.id === f.equipeId)).length;
        if (!equipes.length && !semEquipe) return "";

        return `<li class="grupo">${TIPOS[tipo].rotulo}</li>` +
            equipes.map((e) => {
                const ativos = doTipo.filter((f) => f.equipeId === e.id).length;
                return `
                    <li style="--cor:${esc(e.cor)}">
                        <i class="vela" aria-hidden="true"></i>
                        <span class="principal">${esc(e.nome)}</span>
                        <span class="lado">${ativos} ${ativos === 1 ? "pessoa" : "pessoas"}</span>
                    </li>`;
            }).join("") +
            (semEquipe
                ? `<li><span class="principal">Sem equipe<small>Ficam fora da escala até entrarem numa equipe</small></span><span class="lado">${semEquipe}</span></li>`
                : "");
    }).join("");

    el.innerHTML = blocos || `<li><span class="texto-apoio">Nenhuma equipe criada.</span></li>`;
}

async function iniciar() {
    const [equipesBrutas, funcionarios, feriados] = await Promise.all([
        lerColecao("equipes"), lerColecao("funcionarios"), lerColecao("feriados")
    ]);
    const todasEquipes = ordenarEquipes(equipesBrutas);

    renderEquipes(todasEquipes, funcionarios);

    const resultados = await Promise.all(
        ["diurna", "noturna"].map((t) => plantaoDaEscala(t, todasEquipes, funcionarios, feriados))
    );

    document.getElementById("plantoes").innerHTML = resultados.map(htmlPlantao).join("");
    renderFeriados(resultados, todasEquipes);
}

iniciar().catch((erro) => {
    console.error(erro);
    document.getElementById("plantoes").innerHTML =
        `<div class="vazio"><h3>Não foi possível carregar o plantão</h3><p>Verifique a conexão e recarregue a página.</p></div>`;
});
