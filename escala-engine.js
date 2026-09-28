// ======================================================
// Escala São Miguel
// escala-engine.js
// Motor de rodízio: fins de semana + feriados
// (sem dependência de Firebase, pode ser testado isolado)
// ======================================================
//
// Datas sempre no formato "AAAA-MM-DD" e calculadas em UTC,
// assim fuso horário e horário de verão não deslocam dias.

const DIA_MS = 86400000;
const SEMANA_MS = 7 * DIA_MS;

const pad = (n) => String(n).padStart(2, "0");
const mod = (a, n) => ((a % n) + n) % n;

export const DATA_REFERENCIA_PADRAO = "2026-01-03"; // um sábado

export const CONFIG_PADRAO = {
    modo: "fimdesemana",           // "fimdesemana" = mesma equipe sáb+dom | "alternado" = sáb e dom com equipes diferentes
    dataReferencia: DATA_REFERENCIA_PADRAO,
    equipeInicialId: null,         // equipe que trabalha no fim de semana de referência
    feriadoEquipeInicialId: null,  // equipe do primeiro feriado da lista
    feriadoNoFimDeSemana: "feriado" // "feriado" = rodízio de feriados assume | "fimdesemana" = equipe do fim de semana assume
};

// ------------------------------------------------------
// Datas
// ------------------------------------------------------

export function paraTempo(iso) {
    const [a, m, d] = iso.split("-").map(Number);
    return Date.UTC(a, m - 1, d);
}

export function paraISO(tempo) {
    return new Date(tempo).toISOString().slice(0, 10);
}

export function hojeISO() {
    const h = new Date();
    return `${h.getFullYear()}-${pad(h.getMonth() + 1)}-${pad(h.getDate())}`;
}

export function diaDaSemana(iso) {
    return new Date(paraTempo(iso)).getUTCDay(); // 0 = domingo, 6 = sábado
}

export function somarDias(iso, n) {
    return paraISO(paraTempo(iso) + n * DIA_MS);
}

export function ehFimDeSemana(iso) {
    const d = diaDaSemana(iso);
    return d === 0 || d === 6;
}

// Sábado do fim de semana ao qual a data pertence.
// Domingo -> sábado anterior; dia útil -> próximo sábado.
export function sabadoDoFimDeSemana(iso) {
    const d = diaDaSemana(iso);
    if (d === 6) return iso;
    if (d === 0) return somarDias(iso, -1);
    return somarDias(iso, 6 - d);
}

export function diasDoMes(mesISO) {
    const [a, m] = mesISO.split("-").map(Number);
    const total = new Date(Date.UTC(a, m, 0)).getUTCDate();
    return Array.from({ length: total }, (_, i) => `${mesISO}-${pad(i + 1)}`);
}

export function mesDe(iso) {
    return iso.slice(0, 7);
}

export function somarMeses(mesISO, n) {
    const [a, m] = mesISO.split("-").map(Number);
    const d = new Date(Date.UTC(a, m - 1 + n, 1));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

// ------------------------------------------------------
// Rodízio de fim de semana
// ------------------------------------------------------

function indiceDe(equipes, id) {
    const i = equipes.findIndex((e) => e.id === id);
    return i < 0 ? 0 : i;
}

// Qual equipe (índice na ordem de rodízio) trabalha nesta data de fim de semana.
// A conta parte de uma data fixa, então a sequência continua de um mês
// para o outro sem "reiniciar" no dia 1.
export function indiceFimDeSemana(iso, config, equipes) {
    const n = equipes.length;
    if (!n) return -1;

    const cfg = { ...CONFIG_PADRAO, ...config };
    const ref = sabadoDoFimDeSemana(cfg.dataReferencia || DATA_REFERENCIA_PADRAO);
    const semanas = Math.round(
        (paraTempo(sabadoDoFimDeSemana(iso)) - paraTempo(ref)) / SEMANA_MS
    );
    const inicial = indiceDe(equipes, cfg.equipeInicialId);

    if (cfg.modo === "alternado") {
        let domingo = diaDaSemana(iso) === 0 ? 1 : 0;

        // Com número par de equipes, cada uma cairia sempre no mesmo dia.
        // Em ciclos alternados, sábado e domingo trocam entre si, então
        // quem fez sábado passa para domingo no ciclo seguinte.
        if (n % 2 === 0) {
            const ciclo = Math.floor((semanas * 2) / n);
            if (mod(ciclo, 2) === 1) domingo = 1 - domingo;
        }

        return mod(inicial + semanas * 2 + domingo, n);
    }

    return mod(inicial + semanas, n);
}

export function equipeDoFimDeSemana(iso, config, equipes) {
    const i = indiceFimDeSemana(iso, config, equipes);
    return i < 0 ? null : equipes[i].id;
}

// ------------------------------------------------------
// Rodízio de feriados
// ------------------------------------------------------
//
// Todos os feriados cadastrados entram em ordem cronológica.
// Cada feriado recebe a próxima equipe da fila. Se um feriado tiver
// equipe fixa, ela é usada e a fila continua a partir dela.
// Feriado em fim de semana pode seguir a equipe do fim de semana
// (configurável); nesse caso ele não consome a vez de ninguém.

export function distribuirFeriados(feriados, equipes, config) {
    const cfg = { ...CONFIG_PADRAO, ...config };
    const n = equipes.length;
    const ordenados = [...feriados].sort((a, b) => a.data.localeCompare(b.data));

    if (!n) {
        return ordenados.map((f) => ({ ...f, equipeId: null, fixo: false, segueFimDeSemana: false }));
    }

    let ponteiro = indiceDe(equipes, cfg.feriadoEquipeInicialId);

    return ordenados.map((f) => {
        if (cfg.feriadoNoFimDeSemana === "fimdesemana" && ehFimDeSemana(f.data)) {
            return {
                ...f,
                equipeId: equipeDoFimDeSemana(f.data, cfg, equipes),
                fixo: false,
                segueFimDeSemana: true
            };
        }

        let idx = f.equipeFixaId ? equipes.findIndex((e) => e.id === f.equipeFixaId) : -1;
        const fixo = idx >= 0;
        if (!fixo) idx = mod(ponteiro, n);
        ponteiro = idx + 1;

        return { ...f, equipeId: equipes[idx].id, fixo, segueFimDeSemana: false };
    });
}

// ------------------------------------------------------
// Escala do mês
// ------------------------------------------------------
//
// ajustes = {
//   trocas:    { "AAAA-MM-DD": equipeId },
//   ausencias: { "AAAA-MM-DD": { funcionarioId: "FE" | "A" } }
// }

export function gerarEscalaDoMes(mesISO, { equipes, feriados = [], config = {}, ajustes = {} }) {
    const cfg = { ...CONFIG_PADRAO, ...config };
    const mapaFeriados = new Map(
        distribuirFeriados(feriados, equipes, cfg).map((f) => [f.data, f])
    );
    const trocas = ajustes.trocas || {};
    const idsValidos = new Set(equipes.map((e) => e.id));
    const dias = [];

    for (const iso of diasDoMes(mesISO)) {
        const semana = diaDaSemana(iso);
        const fds = semana === 0 || semana === 6;
        const feriado = mapaFeriados.get(iso) || null;

        if (!fds && !feriado) continue;

        let tipo = semana === 6 ? "sabado" : "domingo";
        let equipeOriginalId = fds ? equipeDoFimDeSemana(iso, cfg, equipes) : null;

        if (feriado) {
            tipo = "feriado";
            equipeOriginalId = feriado.equipeId;
        }

        const troca = trocas[iso];
        const alterado = !!troca && idsValidos.has(troca) && troca !== equipeOriginalId;

        dias.push({
            data: iso,
            diaSemana: semana,
            fimDeSemana: fds,
            tipo,
            feriado: feriado
                ? { descricao: feriado.descricao, fixo: feriado.fixo, segueFimDeSemana: feriado.segueFimDeSemana }
                : null,
            equipeOriginalId,
            equipeId: alterado ? troca : equipeOriginalId,
            alterado
        });
    }

    return dias;
}

// Integrantes da equipe do dia (ativos), com a ausência marcada, se houver
export function integrantesDoDia(dia, funcionarios, ajustes = {}) {
    const ausencias = (ajustes.ausencias || {})[dia.data] || {};
    return funcionarios
        .filter((f) => f.equipeId === dia.equipeId && f.status !== "Inativo")
        .map((f) => ({ ...f, ausencia: ausencias[f.id] || null }));
}

// ------------------------------------------------------
// Feriados nacionais do Brasil
// ------------------------------------------------------

export function pascoa(ano) {
    const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100;
    const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const mes = Math.floor((h + l - 7 * m + 114) / 31);
    const dia = ((h + l - 7 * m + 114) % 31) + 1;
    return `${ano}-${pad(mes)}-${pad(dia)}`;
}

export function feriadosNacionais(ano, incluirFacultativos = false) {
    const p = pascoa(ano);
    const lista = [
        [`${ano}-01-01`, "Confraternização Universal"],
        [somarDias(p, -2), "Sexta-feira Santa"],
        [`${ano}-04-21`, "Tiradentes"],
        [`${ano}-05-01`, "Dia do Trabalho"],
        [`${ano}-09-07`, "Independência do Brasil"],
        [`${ano}-10-12`, "Nossa Senhora Aparecida"],
        [`${ano}-11-02`, "Finados"],
        [`${ano}-11-15`, "Proclamação da República"],
        [`${ano}-11-20`, "Consciência Negra"],
        [`${ano}-12-25`, "Natal"]
    ];

    if (incluirFacultativos) {
        lista.push(
            [somarDias(p, -48), "Carnaval (segunda)"],
            [somarDias(p, -47), "Carnaval (terça)"],
            [somarDias(p, 60), "Corpus Christi"]
        );
    }

    return lista
        .map(([data, descricao]) => ({ data, descricao }))
        .sort((a, b) => a.data.localeCompare(b.data));
}

// ------------------------------------------------------
// Textos de data em português
// ------------------------------------------------------

export const NOMES_DIA = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
export const NOMES_DIA_CURTO = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
export const NOMES_MES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

export function dataCurta(iso) {
    const [, m, d] = iso.split("-");
    return `${d}/${m}`;
}

export function dataCompleta(iso) {
    const [a, m, d] = iso.split("-");
    return `${d}/${m}/${a}`;
}

export function tituloMes(mesISO) {
    const [a, m] = mesISO.split("-").map(Number);
    const nome = NOMES_MES[m - 1];
    return `${nome.charAt(0).toUpperCase()}${nome.slice(1)} de ${a}`;
}
